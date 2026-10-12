import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import { formatBiliTitle, formatPartTitle, isAppendAmbiguous, isJobAbort, isUploadRateLimited, resolveOutputStem, runWithJob, sanitizeStreamKey, throwIfAborted, USER_STOP, type NotifyEvent, type ScopedLogger } from "@drec/core";
import type { UploadOpts } from "@drec/core";
import { selectWinner } from "./select.js";
import { retry } from "./retry.js";
import { humanBytes, sumBytes } from "./format.js";
import { buildWorkflow, deriveStageProducts, runWorkflowNodes, ResourcePool, type StageProducts, type WorkflowNodeKey } from "./workflow.js";
import { deriveSegmentPlan, UPLOAD_ALIAS_DIR } from "./session-plan.js";
import { runSegmentPipeline } from "./segment-pipeline.js";
// 节点侧上传(experimental,plans/027):全部逻辑隔离在 node-side-upload.ts,便于快速开关/回退。
import { shouldUseNodeSideUpload, tryNodeSideUpload } from "./node-side-upload.js";
import { PART_GROUP_CANONICAL, verifyBlocksOnMismatch, verifyMessage, verifyUploaded } from "./verify.js";

/** 每任务可配的流水线步骤(默认全开;false 则跳过该产出)。 */
export interface PipelineSteps {
  mergeSegments?: boolean; // 默认 true:各分段合成一片;false = 不合并,按录制分段逐段产出/上传
  burnDanmu?: boolean;     // 默认 true:烧飞屏弹幕版(分段模式下 = 逐段烧)
  burnLivechat?: boolean;  // 默认 true:烧聊天框版(分段模式下 = 逐段烧)
  /**
   * **(实验,缺省 false)** 节点侧上传(见 plans/027):该房间**不烧录**时,winner 节点本地
   * remux → biliup 上传,master 只收 BV,省掉整场录像 rsync 回传。需烧录时本开关无效(回落现状)。
   */
  nodeSideUpload?: boolean;
}

/**
 * cleanup 开关(都默认 false)。
 *
 * **.xml/.ass 的保护口径 = "不得没有副本"**,而非"任何位置都永不删":
 *   - stage 里拉来的源 .xml(copy)+ 烧录产出的 .ass 是**副本**;
 *   - 各成员节点的 .xml 是**原始弹幕源**(唯一时不可删)。
 * 故:保留 stage 时,节点源 .xml 可删(副本在 stage);不保留 stage 时,节点源 .xml 保留
 * (否则两处都没了)。实现见 xmlKeepRule —— 保证永不出现"两处同时删光"。
 */
export interface PipelineCleanup {
  stageSourceAfterMerge?: boolean; // 合并后删 stage 里拉来的源 .ts(+ 源 .xml/.ass 副本)
  sourceAfterDone?: boolean;       // job 安全完成后删各成员节点原录制 .ts(+ 源 .xml,若 stage 保留)
  stageAfterDone?: boolean;        // job done(已上传)后删 stage 合成产物(+ .xml/.ass,若节点源保留)
}

/** 清理路径兜底:只处理视频(.ts/.mp4/.flv 等);.xml/.ass 走下面的 keep 规则单独判定。 */
/** 清理路径兜底:只处理视频(.ts/.mp4/.flv 等);.xml/.ass 走 xmlKeepRule 单独判定。 */
export const videoOnly = (paths: string[]): string[] => paths.filter((p) => !/\.(xml|ass)$/i.test(p));

/**
 * **弹幕源/渲染文件(.xml/.ass)的删除规则**——唯一不变量:两处不能同时删光,至少留一份。
 *
 * 两种两侧组合:
 *   - `stageAfterDone=false`(保留 stage):删节点源时**连带删节点 .xml**(副本在 stage);
 *     stage 侧一律不删。
 *   - `stageAfterDone=true`(清空 stage):stage 侧 .xml/.ass 可随产物删;节点侧 .xml **保留**
 *     (此时若也删节点源,节点 .xml 就成了最后一份)。
 *
 * @param side     "node" = 节点侧源文件;"stage" = stage 目录内的 .xml/.ass
 * @param stageAfterDone 本场是否会在完成后清空 stage
 * @returns 该侧的 .xml/.ass 是否允许删除
 */
export function xmlKeepRule(side: "node" | "stage", stageAfterDone: boolean): boolean {
  return side === "node" ? !stageAfterDone : stageAfterDone;
}

export interface PipelineCfg {
  cleanMaxGapSec: number;
  /** 断流重连合并窗(ms):结束距现在不足该窗的场暂不处理;聚类容差同窗。缺省 reconciler 默认 10 分钟。 */
  reconnectWindowMs?: number;
  stageDir: string;
  cookies: string;
  /** stage = 只合成不传;upload = 传 B站。 */
  uploadMode: "stage" | "upload";
  /** 仅 upload 时有意义:true(默认)= 仅自己可见,false = 公开。 */
  uploadPrivate?: boolean;
  uploadMeta: {
    tag: string; tid: number; desc?: string;
    titleTemplate?: string;
    submissionTitleTemplate?: string;
    partTitleTemplate?: string;
  };
  /** 渲染 {date}/{time} 回退用(sessionBase 解析不到时);缺省 Asia/Shanghai。 */
  timeZone?: string;
  steps?: PipelineSteps;
  cleanup?: PipelineCleanup;
  /** 分段上传:每批 append 的文件数上限(缺省 1 = 单个文件一次提交 → 失败可安全重试)。 */
  uploadBatchSize?: number;
  /**
   * 分段上传:跳过短于该秒数的分段(缺省 2s)。mesio 的 `--fix` 在流不连续时会切出
   * 0.2s 级、且分辨率不同的初始化残片(无有效内容)——过滤掉,避免污染分 P、白跑上传。
   * 0 = 不过滤。
   */
  minSegmentSec?: number;
  /**
   * **(内部)分段上传的分 P 目标时长(秒)** = 录制任务创建时的分段时长(`segmentSec`),
   * 由 CLI 从源任务读取注入,**不在 hub 规则里单独配置**。
   * >0 时按累计时长聚组(最多超 20%)合并成一个 mp4 → 抵消 mesio `--fix` 把一场切成长短
   * 不一的碎段(否则分 P 爆炸且都短于录制设置的分段时长);<=0 = 逐段上传。
   */
  segmentGroupSec?: number;
  /** reconciler 硬过滤用:非空 → 只处理这些 worker 的录像;缺省/空 = 全部(向后兼容)。pipeline 本身不读。 */
  workers?: string[];
  /**
   * reconciler 能力门控用:非空 → 只处理具备这些能力标签的 worker(能力 ⊇ requires);缺省/空 = 无要求。
   * 与 `workers` 取交集(先按 workers 勾选,再按 requires 过滤)。pipeline 本身不读。
   */
  requires?: string[];
}

export interface PipelineDeps {
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  /** 共享资源池(cpu/net 各 max=1 + 内存闸门)。缺省 → runPipeline 内部新建(测试/兼容)。 */
  pool?: ResourcePool;
  /** 执行子命令(merge/burn 等)。可选返回 stdout+stderr 文本 → pipeline 会摘尾写进该场 job.log。 */
  sh: (cmd: string) => Promise<void | string>;
  /** 仅上传 plain(P1)拿 BV —— **穿插上传接缝**:pipeline 先 fire 它(网络),与烧录(CPU)并行。 */
  uploadPlain: (plain: UploadOpts) => Promise<string>;
  /** 分段模式的 P1 建稿(可选):给定时优先于 `uploadPlain`(便于测试注入)。 */
  uploadPlainRaw?: (plain: UploadOpts) => Promise<string>;
  /** 追加一个逻辑组到稿件(空组跳过)。多组**串行**调用(同稿件并发 append 会撞)。
   *  public 透传 → append 保留 P1 的水印关/可见性(防 append 重置)。 */
  appendGroup: (o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>;
  /** 把单个烧录产物按 16GB 上限切成多段(默认 splitToSizeLimit);可注入测试。 */
  splitForUpload?: (mp4: string) => Promise<string[]>;
  /** 分段模式:单段 remux(默认 @drec/post-process remuxSegment);可注入测试。 */
  remuxSegment?: (src: string, outMp4: string) => Promise<void>;
  /** 分段模式:单段时长探测(默认 ffprobeDuration);可注入测试。 */
  segmentDuration?: (src: string) => Promise<number>;
  /** 分段模式:单段烧录(默认读 xml 窗口 → ASS → burn);可注入测试。 */
  burnSegment?: (o: { plain: string; xmlPath: string; window: { startSec: number; endSec: number }; style: "danmu" | "livechat"; out: string }) => Promise<void>;
  /** 分段模式:把一组逐段 plain 合并成一个分 P(默认 mergeSession);可注入测试。 */
  mergeSegments?: (inputs: string[], outMp4: string) => Promise<void>;
  /**
   * 取某稿件在 B站的**实际分 P 数**(T11 核验接缝;由 cli 注入 `countVideoParts`)。
   *
   * **为什么是注入接缝**:orchestrator(L4.5)绝不能 import @drec/app(L4)——分层测试会挂。
   * 返回 null = 取数失败(网络/接口)→ 核验记「软状态」,下轮重试,**不删源、不转人工**。
   * 缺省 undefined = 核验关闭(行为与本次上线前一致)。
   */
  countParts?: (bv: string) => Promise<number | null>;
  /** 删 master 本地 stage 文件(cleanup 用);默认 fs.rm,可注入测试。 */
  rmStage?: (paths: string[]) => Promise<void>;
  notify: (e: NotifyEvent) => void;
  /** 按 streamKey 造该场的 run 级 Logger(job.log)。缺省=内置文件直写(兼容旧行为/测试)。
   *  CLI 注入 @drec/observability 的 FileLogger,使「怎么落盘」由组合根装配、orchestrator 只调 ScopedLogger 接口。 */
  makeRunLogger?: (streamKey: string) => ScopedLogger;
  /** append 就地重试的退避 sleep(可注入测试,免真等 5s)。省略 → retry 内置 setTimeout。 */
  sleep?: (ms: number) => Promise<void>;
  cfg: PipelineCfg;
}

/** 默认按 16GB 上限切分(给上传用)。分段模块也用到。 */
export const defaultSplitForUpload = (mp4: string): Promise<string[]> =>
  import("@drec/post-process").then((m) => m.splitToSizeLimit(mp4));



/** 默认删 master 本地 stage 文件(cleanup 用)。分段模块也用到。 */
export async function defaultRmStage(paths: string[]): Promise<void> {
  const { rmSync } = await import("node:fs");
  for (const p of paths) {
    // recursive 让 .work/ .upload/ 这类目录也能整体删掉(否则只删文件,目录长期残留)。
    try { rmSync(p, { force: true, recursive: true }); } catch { /* 忽略 */ }
  }
}

/** 读目录文件名(失败 → 空数组;清理路径用,绝不反噬)。分段模块与合并路径共用。 */
export function readdirSyncSafe(dir: string): string[] {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * **统一的「删源」实现**(合并路径 / 分段路径 / 两条续跑路径共用,消除 4 处副本的分歧)。
 *
 * 删的**只有源**:
 *   - 各成员节点 `recordings/` 里的原始录像(.ts 总删;.xml 见 xmlKeepRule);
 *   - stage 里**拉来的源段副本**(`stagePulledSources`)—— 仅当调用方传入(即**有合并处理**时)。
 *
 * 关键:**保持分P上传时不得传 stagePulledSources** —— 分P模式下 stage 里的 `{name}_{NNN}.mp4`
 * 就是交付物本身(无合并,逐段无损 remux),删了它 = 删成品。分P的 stage 文件统一留到上传后清。
 *
 * 调用方负责保证「删源」只发生在安全点(stage 模式收尾 / upload 模式 markDone 之后)。
 */
export interface CleanupFailure {
  /** 失败的清理目标(节点 id 或 stage 路径)。 */
  target: string;
  error: string;
}
/**
 * 清理结果:**不抛错、不吞错**(plans/030 T12)。
 *
 * 现状的缺陷不是「清理失败把 job 标 failed」—— 现状全部 `catch(()=>{})` / try-catch 吞掉,
 * 失败对 job 完全不可见(日志里也只字未提),磁盘默默涨。改法:收集每个目标的失败返回,
 * 调用方把对应 `clean_*` 步骤标 failed 供 reconciler 补跑,**job 终态不受影响**
 * (上传已成功,清理失败只意味着磁盘没释放,不该让人重传)。
 */
export interface CleanupOutcome {
  ok: boolean;
  failed: CleanupFailure[];
}
const cleanupOk = (): CleanupOutcome => ({ ok: true, failed: [] });

export async function cleanupSourcesShared(o: {
  streamKey: string;
  ledger: SyncLedger;
  transports: Map<string, Transport>;
  members: readonly { workerId: string; rec: { tsFiles: string[]; xmlPath?: string } }[];
  cleanup?: PipelineCleanup;
  /** stage 里拉来的源段副本(绝对路径);**仅合并路径传**。分P模式不传。 */
  stagePulledSources?: string[];
  rmStage: (paths: string[]) => Promise<void>;
  log: (msg: string) => void;
  /**
   * **跳过节点源清理**(只做 stage 侧)。用于「核验疑似少分 P」时:
   * 那种情况不能销毁最后一份源(可能真丢片 / 也可能只是 B站还没同步),
   * 留源给 reconciler 的收尾补跑在**确认一致**后再删。
   */
  skipNodeSources?: boolean;
}): Promise<CleanupOutcome> {
  const clean = o.cleanup ?? {};
  const failed: CleanupFailure[] = [];
  /** 把一个清理步骤的失败目标落成一条 failed 步骤(UI/重试都靠它),并写 job.log。 */
  const markStep = (step: "clean_source" | "clean_stage_src", failures: CleanupFailure[], detail: string): void => {
    if (failures.length === 0) { o.ledger.logStep(o.streamKey, step, "done", detail); return; }
    const err = failures.map((f) => `${f.target}: ${f.error}`).join("; ").slice(0, 500);
    o.ledger.logStep(o.streamKey, step, "done", `${detail} · 部分失败 ${failures.length}`);
    o.ledger.syncNodeState(o.streamKey, step, "failed", { error: err });
    o.log(`清理失败(${step}):${err}`);
  };

  // ① 各节点 recordings 源(与 stage 侧独立;两开关可单独开)。
  if (clean.sourceAfterDone && !o.skipNodeSources) {
    const delNodeXml = xmlKeepRule("node", clean.stageAfterDone === true);
    o.ledger.logStep(o.streamKey, "clean_source", "start");
    let fileCount = 0;
    const srcFailed: CleanupFailure[] = [];
    for (const m of o.members) {
      const paths = videoOnly(m.rec.tsFiles);
      if (delNodeXml && m.rec.xmlPath) paths.push(m.rec.xmlPath);
      if (paths.length === 0) continue;
      fileCount += paths.length;
      const t = o.transports.get(m.workerId);
      // 无 cleanup 能力的 transport / 抛错都**如实记账**(不静默):否则磁盘占满时无人知。
      if (!t?.cleanup) { srcFailed.push({ target: m.workerId, error: "transport 无 cleanup 能力" }); continue; }
      try { await t.cleanup(paths); }
      catch (e) { srcFailed.push({ target: m.workerId, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    }
    failed.push(...srcFailed);
    markStep("clean_source", srcFailed, `删 ${o.members.length} 节点 · ${fileCount} 文件`);
  }

  // ② 有合并处理 → stage 里拉来的源段副本已成冗余(成品是合并 mp4),可删。
  if (o.stagePulledSources && o.stagePulledSources.length > 0 && clean.stageSourceAfterMerge) {
    const paths = [...o.stagePulledSources];
    // .xml/.ass 副本:不保留 stage(节点源会保留)时才删 —— 与 xmlKeepRule 一致,永不两处删光。
    if (xmlKeepRule("stage", clean.stageAfterDone === true)) {
      const dir = path.dirname(paths[0]);
      paths.push(...readdirSyncSafe(dir).filter((f) => /\.(xml|ass)$/i.test(f)).map((f) => path.join(dir, f)));
    }
    o.ledger.logStep(o.streamKey, "clean_stage_src", "start");
    const stageFailed: CleanupFailure[] = [];
    // rmStage 逐个路径失败也要归因到具体文件(否则只剩一个匿名错误,补跑时无法定位)。
    try {
      // rmStage 是一批一把梭:整批抛错时逐条重试,只为区分「哪些文件真的删不掉」。
      await o.rmStage(paths);
    } catch (e) {
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      stageFailed.push({ target: paths.join(",").slice(0, 300), error: msg });
    }
    failed.push(...stageFailed);
    markStep("clean_stage_src", stageFailed, `删 ${paths.length} 文件`);
  }
  return failed.length === 0 ? cleanupOk() : { ok: false, failed };
}


/**
 * **上传后的收口闸门(单一插入点,合并路径 / 分段路径 / 两条续跑共用)**。
 *
 * 顺序是硬标准,不可调换:
 *   1. `markDone` —— **先**把 job 标成功(上传确实成功了);
 *   2. 产物核验(T11):实际分 P 数 vs 台账期望 → 不一致/取数失败 → **不删源**,记 `clean_verify`;
 *   3. 清理(T12):只在 1、2 都允许时执行;清理失败**绝不**改终态,只把 `clean_*` 标 failed 供补跑。
 *
 * 为什么先 markDone 再核验:核验/清理都不是上传的前置条件,上传成功的事实不该
 * 因为「核验取数失败」而被回滚成 needs_manual(那会诱导用户重传 → 重复稿)。
 *
 * 返回是否执行了清理(供调用方决定 stageAfterDone 那一段还要不要跑:
 * 没删源时 stage 产物仍是有用副本,照 `stageAfterDone` 开关处理即可,不受影响)。
 */
/**
 * **只清理**收口(T12 补跑专用):该场已 done、stage 产物已被清空,再跑一遍上传流程毫无意义
 * 且危险(可能重复投稿)。这里只做两件事:核验(有基线才核)+ 删源。
 *
 * 返回值恒为 done —— 上传早已成功,清理结果不该把它降级。
 */
export async function finalizeOnly(
  streamKey: string,
  bv: string,
  deps: PipelineDeps,
  jlog: (msg: string) => void,
  notify: (e: NotifyEvent) => void,
  members: Broadcast["members"],
  stageSub: string,
): Promise<{ state: JobState; bv?: string }> {
  const rmStageFn = deps.rmStage ?? defaultRmStage;
  const cfg = deps.cfg;
  await finalizeAfterUpload({
    streamKey, bv, deps, log: jlog, notify,
    cleanupSources: () => cleanupSourcesShared({
      streamKey, ledger: deps.ledger, transports: deps.transports, members,
      cleanup: cfg.cleanup,
      stagePulledSources: members.flatMap((m) => m.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)))),
      rmStage: rmStageFn, log: jlog,
    }),
    on: {
      plain: true,
      danmu: cfg.steps?.burnDanmu !== false,
      livechat: cfg.steps?.burnLivechat !== false,
    },
  });
  return { state: "done", bv };
}

export async function finalizeAfterUpload(o: {
  streamKey: string;
  bv: string;
  deps: PipelineDeps;
  log: (msg: string) => void;
  /**
   * 清理各节点源(+ 可选 stage 拉来源段);收尾闸门决定要不要调。
   * `skipNodeSources` 供「核验疑似少分 P」时只清 stage、**保住节点源**。
   */
  cleanupSources: (opts?: { skipNodeSources?: boolean }) => Promise<CleanupOutcome>;
  on: { plain: boolean; danmu: boolean; livechat: boolean };
  notify: (e: NotifyEvent) => void;
}): Promise<CleanupOutcome & { verifyBlocked?: boolean }> {
  const { deps, streamKey, bv, log } = o;
  const ledger = deps.ledger;
  // 核验的重查退避复用 deps.sleep(与 append 重试同一注入点):测试注入 no-op 即免真等 45s。
  const v = await verifyUploaded(ledger, streamKey, bv, o.on, deps.countParts,
    deps.sleep ? { sleep: deps.sleep } : {});
  ledger.logStep(streamKey, "clean_verify", "done", v.kind === "mismatch"
    ? `不符:期望 ${v.expected} 实际 ${v.actual}${verifyBlocksOnMismatch() ? " · 保留全部源" : " · 仅记录(观察期)"}`
    : v.kind === "unknown" ? `待重试:${v.reason}`
    : v.kind === "ok" ? `${v.actual} 个分 P` : `跳过:${v.reason}`);
  log(verifyMessage(v, streamKey, bv));

  if (v.kind === "mismatch") {
    // **观察期默认走这里**(verifyBlocksOnMismatch()=false):只记录 + 告警,**不**转人工、
    // **不**阻止删源。理由见 verify.ts 的 DEFAULT_VERIFY_BLOCKING 注释(核验从未抓到真失败,
    // 只在 append 成功后 0.5 秒读到 B站未同步的旧值 → 误伤成功的上传 + 源永不删)。
    if (!verifyBlocksOnMismatch()) {
      // 观察期只放宽 **多出** 分 P 的情形(B站比我们提交的多 = 我们没丢东西,源可安全删)。
      //
      // **少了** 分 P(actual < expected)一律**不删节点源**:两种可能 ——
      //   ①B站 pages 还没同步(假失败,实测 0.5~0.6s 就核验时高发);②真的丢片。
      // 两种都不该在这种情况下**销毁最后一份源**(不可逆)。源留着,由 reconciler 的
      // 收尾补跑(clean_source 缺失 → 补跑)在**确认一致**之后再删,见 cleanupBackfillDue。
      const lostParts = v.actual < v.expected;
      ledger.syncNodeState(streamKey, "clean_verify", "done", {
        error: `分 P 数不符:期望 ${v.expected} 实际 ${v.actual}`
          + (lostParts ? "(观察期:疑似缺失,**保留节点源**,待补跑确认)" : "(观察期仅记录,多出分 P 不影响删源)"),
      });
      // 告警仍走 error 通道(NotifyEvent 没有 warn 档):观察期不该为「读早了」刷 error 通知,
      // 但**必须留痕** —— job.log 与台账已记,这里只把措辞标成「仅记录」便于日后区分。
      o.notify({
        kind: "error", stage: "上传",
        message: `${verifyMessage(v, streamKey, bv)}`
          + (lostParts ? "(观察期:疑似缺失,已保留节点源)" : "(观察期仅记录,未阻塞)"),
      });
      // 疑似缺失 → 只做 stage 侧清理,跳过节点源(sourceAfterDone 置 false);其余照常。
      return lostParts ? await o.cleanupSources({ skipNodeSources: true }) : await o.cleanupSources();
    }
    // 返回值也要改:调用方直接把本函数返回的 state 交给 reconciler/UI,
    // 只改台账不改返回值 → UI 显示 done、实际 needs_manual,两处真相打架。
    // 唯一会「不删源 + 转人工」的结论:分 P 丢了 = 交付不完整,必须人工补传/核对。
    // 标 needs_manual 而非 failed:failed 会被 reconciler 自动重跑 → 重传 = 重复稿。
    ledger.syncNodeState(streamKey, "clean_verify", "failed", {
      error: `分 P 数不符:期望 ${v.expected} 实际 ${v.actual}`,
    });
    ledger.setState(streamKey, "needs_manual", {
      error: `产物核验失败:期望 ${v.expected} 个分 P、实际 ${v.actual} 个(bv=${bv}),已保留全部源`,
    });
    o.notify({
      kind: "error", stage: "上传",
      message: verifyMessage(v, streamKey, bv),
    });
    // verifyBlocked:调用方据此把返回值也改成 needs_manual(返回值与台账必须一致)。
    return { ...cleanupOk(), verifyBlocked: true };
  }
  if (v.kind === "unknown") {
    // 软状态:pending(可重试),由 reconciler 下一轮补跑核验;源也保留。
    ledger.syncNodeState(streamKey, "clean_verify", "pending", { error: v.reason });
    o.notify({ kind: "error", stage: "上传", message: verifyMessage(v, streamKey, bv) });
    return cleanupOk();
  }
  ledger.syncNodeState(streamKey, "clean_verify", "done", { error: null });
  return await o.cleanupSources();
}

/**
 * 边录边传(T-33)识别短路:若本场录像来自「录制节点已边录边传」的会话(`{base}.rolling.json`
 * 带 bv),则 master **绝不重复建稿** —— 直接收口为 done(带该 BV),并按 sourceAfterDone 删源。
 *
 * 为什么必须在**最早**短路:节点上传确认后已删该段源视频,覆盖率/选优会失真(可能误报未录全),
 * 不能靠下游判定。这里只看 sidecar 的权威事实(录制节点自己写的 BV)。
 *
 * 边界:
 *   - 没有任何成员带 rolling.bv → 返回 null,走常规路径(未启用边录边传 = 行为不变)。
 *   - 有 rolling.bv 但存在 ambiguous 段(结果不确定)→ **转人工**(保留源,不自动重传)。
 *   - 有 rolling.bv 但**磁盘上仍剩未确认分段**(进程在 onSessionEnd 前被杀)→ **转人工**:
 *     那些段的画面没进 BV,静默 done 会**丢片**。确认段会被删,故「还剩 ts」= 未确认。
 *   - stage 模式:边录边传只在上传模式有意义;stage 模式仍照常合成(此处仅认 upload 模式)。
 *   - 多个成员都带 rolling.bv 且 **BV 不一致** → 说明多节点各建稿(不该发生,闸门已挡)→ 转人工。
 */
function tryRollingShortCircuit(o: {
  streamKey: string;
  members: Broadcast["members"];
  ledger: SyncLedger;
  transports: Map<string, Transport>;
  notify: (e: NotifyEvent) => void;
  jlog: (m: string) => void;
}): { state: JobState; bv?: string } | null {
  const { streamKey, members, ledger, jlog } = o;
  if (ledger.get(streamKey)?.bv) return null; // 已有 BV(续跑) → 交给既有续跑路径
  const rolled = members.filter((m) => m.rec.rolling?.bv);
  if (rolled.length === 0) return null;
  const bvs = [...new Set(rolled.map((m) => m.rec.rolling!.bv!))];
  if (bvs.length > 1) {
    jlog(`边录边传识别:多个节点各自建稿(${bvs.join(",")})→ 转人工(绝不自动重传,防重复投稿)`);
    ledger.setState(streamKey, "needs_manual", { error: `边录边传:多节点各建稿(${bvs.join(",")}),请人工核对删重复稿` });
    o.notify({ kind: "error", stage: "上传", message: `${streamKey} 边录边传:多节点各建稿,已转人工核对` });
    return { state: "needs_manual" };
  }
  const bv = bvs[0];
  const ambiguous = rolled.flatMap((m) => m.rec.rolling?.ambiguous ?? []);
  if (ambiguous.length > 0) {
    jlog(`边录边传识别:BV=${bv} 但存在结果不确定段(${ambiguous.join(",")})→ 转人工(保留源,不自动重传)`);
    ledger.setState(streamKey, "needs_manual", { error: `边录边传:BV=${bv} 有不确定段 ${ambiguous.join(",")},请人工核对分 P` });
    o.notify({ kind: "error", stage: "上传", message: `${streamKey} 边录边传:存在不确定分 P,已转人工` });
    return { state: "needs_manual", bv };
  }
  // 磁盘上仍剩分段 = 进程在 onSessionEnd 前被杀(确认段会被删,故「还剩 ts」= 未确认)→ 丢片风险,转人工。
  const residual = rolled.flatMap((m) => m.rec.tsFiles);
  if (residual.length > 0) {
    jlog(`边录边传识别:BV=${bv} 但磁盘仍剩 ${residual.length} 个未确认分段 → 转人工(不静默 done,防丢片)`);
    ledger.setState(streamKey, "needs_manual", { error: `边录边传:BV=${bv} 仍有 ${residual.length} 个未确认分段,请人工核对补传` });
    o.notify({ kind: "error", stage: "上传", message: `${streamKey} 边录边传:仍有未确认分段,已转人工` });
    return { state: "needs_manual", bv };
  }
  // 录制节点已建稿且全部确认 → master 直接收口 done。节点侧已删各确认段源视频,这里只标记完成。
  jlog(`边录边传识别:录制节点已建稿 BV=${bv}(确认 ${rolled.flatMap((m) => m.rec.rolling?.confirmed ?? []).length} 段)→ 直接 done,绝不重复建稿`);
  ledger.setBv(streamKey, bv);
  ledger.markDone(streamKey, bv);
  o.notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  return { state: "done", bv };
}

/**
 * 每场专属日志(`<stageSub>/job.log`,append-only,随 stage 产物持久保留)。
 * 记录选优明细/每步起止耗时/子命令输出摘尾/致命错误——补上「容器日志混杂且重启即丢」的复盘缺口。
 * 写失败静默(日志绝不反噬 pipeline)。
 */
function makeJobLog(stageSub: string): (msg: string) => void {
  let dirReady = false;
  return (msg: string): void => {
    try {
      if (!dirReady) { mkdirSync(stageSub, { recursive: true }); dirReady = true; }
      appendFileSync(path.join(stageSub, "job.log"), `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
    } catch { /* 日志失败不影响管线 */ }
  };
}

export async function runPipeline(
  b: Broadcast,
  deps: PipelineDeps,
): Promise<{ state: JobState; bv?: string }> {
  // 优先用注入的 run Logger(实现由 CLI 装配:observability 的 FileLogger);无则回退内置文件直写(兼容测试)。
  const injected = deps.makeRunLogger?.(b.streamKey);
  const jlog = injected
    ? (msg: string): void => injected.info(msg)
    : makeJobLog(path.join(deps.cfg.stageDir, sanitizeStreamKey(b.streamKey)));
  jlog(`=== pipeline start ${b.streamKey} 成员=[${b.members.map((m) => m.workerId).join(",")}] mode=${deps.cfg.uploadMode} ===`);
  return runWithJob(b.streamKey, async () => {
    try {
      // 同一 streamKey 的 pipeline 与手动 retryNode 共享流锁:reconciler 周期对账和
      // 用户单节点重跑永不并发操作同一场(防止 select/pull 与 retry 同时改文件/状态)。
      const r = await (deps.pool ?? new ResourcePool()).withStreamLock(b.streamKey, () => {
        throwIfAborted();
        return runPipelineInner(b, deps, jlog);
      });
      jlog(`=== pipeline end: ${r.state}${r.bv ? ` bv=${r.bv}` : ""} ===`);
      return r;
    } catch (e) {
      if (isJobAbort(e)) {
        jlog(`用户停止,转人工(不标 failed)`);
        deps.ledger.setState(b.streamKey, "needs_manual", { error: USER_STOP });
        return { state: "needs_manual" as const };
      }
      jlog(`!!! pipeline 抛错(reconciler 将标 failed): ${String((e as Error)?.stack ?? e)}`);
      throw e;
    }
  });
}

async function runPipelineInner(
  b: Broadcast,
  deps: PipelineDeps,
  jlog: (msg: string) => void,
): Promise<{ state: JobState; bv?: string }> {
  const { transports, ledger, uploadPlain, appendGroup, notify, cfg } = deps;
  // 子命令统一经此执行:命令行 + 耗时 + 输出摘尾(最后 2KB,biliup 输出可能很长)都进 job.log。
  const sh = async (cmd: string): Promise<void> => {
    jlog(`$ ${cmd}`);
    const t0 = Date.now();
    const out = await deps.sh(cmd);
    jlog(`  ✓ 完成(${Math.round((Date.now() - t0) / 1000)}s)`);
    if (typeof out === "string" && out.trim()) jlog(`  输出尾: ${out.trim().slice(-2048)}`);
  };
  const splitForUpload = deps.splitForUpload ?? defaultSplitForUpload;
  const rmStage = deps.rmStage ?? defaultRmStage;
  const burnDanmu = cfg.steps?.burnDanmu !== false;        // 默认开
  const burnLivechat = cfg.steps?.burnLivechat !== false;  // 默认开
  const clean = cfg.cleanup ?? {};
  const { streamKey } = b;
  const stageSub = path.join(cfg.stageDir, sanitizeStreamKey(streamKey));

  // 续跑:job 已有 bv ⇒ P1 已建稿(不可逆),绝不重传。跳过 select/pull/merge/burn/uploadPlain,只补 append。
  const existing = ledger.get(streamKey);
  // 分段模式(bv 已存在)有自己的续跑(含 plain 段 checkpoint),不要走合并路径的 resumeAppends。
  if (cfg.uploadMode === "upload" && existing?.bv && cfg.steps?.mergeSegments !== false) {
    return await resumeAppends(streamKey, existing.bv, stageSub, deps, jlog, b.members);
  }

  // 幂等:上一轮已把所有核心节点跑完(如 markDone 前中断) → 直接收口 done,不再 select/pull。
  const coreNodes = ["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"] as const;
  const nodeStates = ledger.getNodeStates(streamKey);
  if (nodeStates.length > 0 && coreNodes.every((n) => nodeStates.find((r) => r.node === n)?.state === "done")) {
    const bv = ledger.get(streamKey)?.bv;
    jlog(`全部核心节点已 done,直接 markDone 收口`);
    ledger.markDone(streamKey, bv ?? "");
    return { state: "done", bv };
  }

  // #1 防护:剔除「文件已不在该节点」的成员(已归档/清理)——否则可能选中其为 winner、pull 失败卡住。
  // 无 exists 能力的 transport 视为信任存在;exists 抛错按缺失剔除。
  const presentMembers = [];
  for (const m of b.members) {
    const tp = transports.get(m.workerId);
    // 边录边传(T-33):已建稿(rolling.bv)且 tsFiles 已被删空的成员 —— 文件「不存在」是**预期**的,
    // 不能按「已归档」剔除,否则 rolling 短路看不到它(漏收口)。只认「有 tsFiles 但确实缺失」为剔除。
    if (m.rec.rolling?.bv && m.rec.tsFiles.length === 0) {
      presentMembers.push(m);
      continue;
    }
    const ok = tp?.exists ? await tp.exists(m.rec.tsFiles).catch(() => false) : true;
    if (ok) presentMembers.push(m);
    else {
      console.warn(`[pipeline] ${streamKey} 剔除成员 ${m.workerId}:文件已不存在`);
      jlog(`剔除成员 ${m.workerId}:文件已不存在`);
    }
  }
  const candidates = { ...b, members: presentMembers };

  // ── 边录边传(T-33)识别:录制节点已自己建稿 → **绝不重复建稿** ─────────────────────
  // 该会话由录制节点边录边传(`{base}.rolling.json` 带 bv)。master 若再走 pull→merge→upload
  // 就是**重复投稿**(B 站不可逆)。这里**最早**短路(在 selectWinner/覆盖率判定之前)——因为段可能
  // 已被节点删掉,覆盖率会失真(误报「未录全」),不能靠下游判定。
  const rollingShort = tryRollingShortCircuit({ streamKey, members: presentMembers, ledger, notify, transports, jlog });
  if (rollingShort) return rollingShort;

  // Select the best recording across all (present) nodes
  // requireDanmu:本场要烧弹幕(danmu/livechat)时,别让「视频覆盖高但 xml 空」的节点赢过有弹幕的
  // (烧录只取 winner 自己的 xml)。关掉两个烧录步 → 弹幕无关,不参与排序。
  const requireDanmu = burnDanmu || burnLivechat;
  ledger.logStep(streamKey, "select", "start");
  const selection = selectWinner(candidates, cfg.cleanMaxGapSec, requireDanmu);
  ledger.logStep(streamKey, "select", "done");

  if (!selection.winner) {
    jlog(`选优失败:${presentMembers.length ? "no winner" : "无可用成员(文件均缺失)"}`);
    ledger.markFailed(streamKey, presentMembers.length ? "no winner" : "无可用成员(文件均缺失)");
    return { state: "failed" };
  }

  const winner = selection.winner;
  const winnerMembers = selection.winnerMembers;
  jlog(`选优: winner=${winner.workerId} clean=${selection.clean} 会话=${winnerMembers.length} 各节点=${JSON.stringify(selection.perNode)}`);

  // 落库选优候选明细(coverage/时长/起止/缺口 + 谁胜出),供事后复盘"为什么这台赢"。
  ledger.recordCandidates(streamKey, selection.perNode, winner.workerId);

  // 没有任何 worker 盖住整场 → 中断 + 通知,绝不删源。clean=true 表示至少一台内部无超阈值缺口且首尾包住并集。
  if (!selection.clean) {
    jlog(`所有节点均断流未录全 → 中断留人工(绝不删源)`);
    ledger.setState(streamKey, "needs_manual", { winnerWorker: winner.workerId });
    notify({
      kind: "error",
      stage: "同步",
      message: `所有节点均断流未录全,最完整=${winner.workerId}(${Math.round(winner.rec.durationSec)}s),已保留全部源,请人工对齐拼接。覆盖度:${JSON.stringify(selection.perNode)}`,
    });
    return { state: "needs_manual" };
  }

  // Mark syncing and pull files from winner node into a per-broadcast sub-directory
  ledger.setState(streamKey, "syncing", { winnerWorker: winner.workerId });
  const transport = transports.get(winner.workerId);
  if (!transport) throw new Error(`No transport for worker: ${winner.workerId}`);

  // ── 节点侧上传(experimental,plans/027)──────────────────────────────────────
  // 全部逻辑隔离在 node-side-upload.ts(含 kill switch);这里只做「是否该走」的判定 + 调用。
  // 不满足条件(未开启/全局停用/stage 模式/需烧录) → 记明原因后继续走下面的 pull 回 master。
  const nodeSide = shouldUseNodeSideUpload(cfg, { burnDanmu, burnLivechat });
  if (nodeSide.ok) {
    const nodeResult = await tryNodeSideUpload({
      streamKey, cfg, winner, winnerMembers, transport, ledger, jlog, notify, deps,
    });
    if (nodeResult) return nodeResult;
  } else if (cfg.steps?.nodeSideUpload) {
    // 只有规则显式开启却没走成时才记日志(避免默认关闭的房间刷屏)。
    jlog(`节点侧上传已开启但本场不适用:${nodeSide.reason} → 回落 pull 回 master`);
  }

  // stageSub 已在入口声明(续跑分支复用)——stageDir/<sanitized-streamKey>,隔离各场文件。
  const filesToPull = winnerMembers.flatMap((m) => [
    ...m.rec.tsFiles,
    ...(m.rec.xmlPath ? [m.rec.xmlPath] : []),
  ]);
  jlog(`pull 开始: ${filesToPull.length} 个文件 ← ${winner.workerId}`);
  const tPull = Date.now();
  ledger.logStep(streamKey, "pull", "start");
  await transport.pull(filesToPull, stageSub);
  const pulledPaths = filesToPull.map((f) => path.join(stageSub, path.basename(f)));
  const pullBytes = sumBytes(pulledPaths);
  ledger.logStep(streamKey, "pull", "done",
    `${filesToPull.length} 文件${pullBytes > 0 ? ` · ${humanBytes(pullBytes)}` : ""} ← ${winner.workerId}`);
  jlog(`pull 完成(${Math.round((Date.now() - tPull) / 1000)}s)`);

  // 产物 stem / 标题:首次锁定(改模板不影响重跑)。合并与分段两条路径共用。
  const earliest = winnerMembers.reduce((a, m) => (m.rec.startMs < a.rec.startMs ? m : a));
  const derived = deriveStageProducts(stageSub);
  const existingStem = (ledger.get(streamKey)?.outputStem ?? "").trim()
    || (cfg.steps?.mergeSegments === false
      ? (deriveSegmentPlan(stageSub)?.dateName ?? "")
      : (derived && existsSync(derived.plain) ? derived.dateName : ""));
  const dateName = resolveOutputStem({
    template: cfg.uploadMeta.titleTemplate,
    sessionBase: earliest.rec.sessionBase,
    startMs: earliest.rec.startMs || b.startMs,
    timeZone: cfg.timeZone,
    liveTitle: earliest.rec.title,
    existingStem,
  });
  // 投稿标题单独渲染:stage 文件名要严格字符集,B 站标题可含空格/标点/emoji。
  // 稿件名解析顺序:
  //   1. submissionTitleTemplate(独立配置)—— 用 sessionBase 重渲染,不受文件名快照影响;
  //   2. 没配 → 回落文件名规则(历史行为):模板含 {title} 且无锁定 stem 时走宽松渲染,
  //      否则直接用已锁定的文件名 stem(保证续跑稳定)。
  const subTpl = (cfg.uploadMeta.submissionTitleTemplate ?? "").trim();
  const titleCtx = {
    sessionBase: earliest.rec.sessionBase,
    startMs: earliest.rec.startMs || b.startMs,
    timeZone: cfg.timeZone,
    liveTitle: earliest.rec.title,
  };
  const usesLiveTitle = (cfg.uploadMeta.titleTemplate ?? "").includes("{title}");
  const uploadTitle = subTpl
    ? formatBiliTitle(subTpl, titleCtx)
    : usesLiveTitle && !existingStem
      ? formatBiliTitle(cfg.uploadMeta.titleTemplate, titleCtx)
      : dateName;
  ledger.setOutputStem(streamKey, dateName);
  jlog(`产物 stem: ${dateName}`);
  if (uploadTitle !== dateName) jlog(`投稿标题: ${uploadTitle}`);

  // 分 P 视频标题(可选):与稿件标题分开渲染。未配置 partTitleTemplate 时不改名(行为不变)。
  const pt = cfg.uploadMeta.partTitleTemplate;
  // 只有真正会产出的分 P 参与编号:{part}/{parts} 必须反映实际分 P 数,
  // 否则关了 burnDanmu 时 {parts} 会虚报(例如 P2 其实是 livechat 却显示 2/3)。
  const partKinds: Array<{ kind: "plain" | "danmu" | "livechat"; on: boolean }> = [
    { kind: "plain", on: true },
    { kind: "danmu", on: burnDanmu },
    { kind: "livechat", on: burnLivechat },
  ];
  const enabledKinds = partKinds.filter((k) => k.on);
  // 类型后缀由 formatPartTitle 自动追加(plain 无 / _danmu / _livechat),模板里不再有 {kind}。
  const partTitles: StageProducts["partTitles"] = pt
    ? Object.fromEntries(
        enabledKinds.map((k, i) => [
          k.kind,
          formatPartTitle(pt, { ...titleCtx, partIndex: i + 1, partTotal: enabledKinds.length }, k.kind),
        ]),
      ) as StageProducts["partTitles"]
    : undefined;

  // 分段上传模式:不合并,逐段 remux(+逐段烧录)→ 逐段上传。走独立分支,与合并路径互斥。
  if (cfg.steps?.mergeSegments === false) {
    return await runSegmentPipeline({
      streamKey, deps, jlog, stageSub, winnerMembers, allMembers: candidates.members, dateName, uploadTitle,
      renderPartTitle: pt
        ? (kind, partIndex, partTotal) => formatPartTitle(pt, { ...titleCtx, partIndex, partTotal }, kind)
        : undefined,
    });
  }

  // Merge and burn from the stageSub directory
  ledger.setState(streamKey, "merging");
  const plain = path.join(stageSub, dateName + ".mp4");
  const danmuMp4 = path.join(stageSub, dateName + "_danmu.mp4");
  const livechatMp4 = path.join(stageSub, dateName + "_livechat.mp4");
  const xmlArg = winner.rec.xmlPath ? path.join(stageSub, path.basename(winner.rec.xmlPath)) : "";
  const plainXml = xmlArg ? path.join(stageSub, dateName + ".xml") : "";
  const products: StageProducts = {
    dateName,
    uploadTitle,
    partTitles,
    sessionBase: winner.rec.sessionBase,
    sessionBases: winnerMembers.map((m) => m.rec.sessionBase),
    plain, danmuMp4, livechatMp4, plainXml, xmlArg,
  };

  // 合并模式:stage 里**拉来的源段副本**在合并产物落地后即为冗余 → 可随「删源」一并清。
  // (保持分P上传时不走这里:那时 stage 里的文件就是交付物本身。)
  const stagePulledSources = winnerMembers.flatMap((m) =>
    m.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f))));
  // 「删源」:节点 recordings 源 + (合并模式的)stage 拉来源段。调用点保证在安全点(stage 收尾 / markDone 后)。
  const cleanupSources = async (opts?: { skipNodeSources?: boolean }): Promise<CleanupOutcome> =>
    cleanupSourcesShared({
      streamKey, ledger, transports, members: candidates.members,
      cleanup: clean, stagePulledSources, rmStage, log: jlog,
      skipNodeSources: opts?.skipNodeSources,
    });

  const workflow = buildWorkflow({
    streamKey, stageSub, products, deps, cfg, log: jlog,
    willUpload: cfg.uploadMode === "upload", burnDanmu, burnLivechat,
    segmentCount: winnerMembers.reduce((n, m) => n + m.rec.tsFiles.length, 0),
  });
  const failedNodes = ledger.getFailedNodes(streamKey);
  const result = await runWorkflowNodes({
    streamKey, nodes: workflow.nodes, edges: workflow.edges, ctx: workflow.ctx,
    pool: deps.pool ?? new ResourcePool(),
    autoRetry: new Set<WorkflowNodeKey>(
      failedNodes
        .filter((n) => n.node === "merge" || n.node === "burn_danmu" || n.node === "burn_livechat")
        .map((n) => n.node as WorkflowNodeKey),
    ),
  });
  if (!result.ok) {
    const errText = result.failed.length
      ? ledger.getNodeState(streamKey, result.failed[0])?.error ?? `节点失败: ${result.failed.join(",")}`
      : `节点被阻断: ${result.blocked.join(",")}`;
    jlog(`pipeline 节点失败: failed=${result.failed.join(",")} blocked=${result.blocked.join(",")}`);
    ledger.markFailed(streamKey, `${errText} [${[...result.failed, ...result.blocked].join(",")}]`);
    notify({ kind: "error", stage: "同步", message: `${streamKey} 节点失败: ${errText}` });
    return { state: "failed", bv: ledger.get(streamKey)?.bv };
  }

  const bv = ledger.get(streamKey)?.bv;
  if (cfg.uploadMode !== "upload") {
    jlog(`stage 模式:合成完毕待人工上传`);
    ledger.setState(streamKey, "needs_manual");
    // stage 模式**不做分P核验**(没有稿件/bv);清理失败只记 clean_* failed,不影响终态。
    await cleanupSources();
    // 正常终点(不是错误):走 stageReady,别再以「出错（同步）」打扰用户。
    notify({ kind: "stageReady", streamKey });
    return { state: "needs_manual" };
  }

  // upload 模式但 bv 为空 = P1 没真正传上去(例如 upload_plain 被旧 skipped 状态卡住)。
  // 绝不能假装 done/发 uploadDone,否则 UI 显示完成、B 站其实没有稿。
  if (!bv) {
    jlog(`upload 模式但 P1 未上传(bv 为空),转人工`);
    ledger.setState(streamKey, "needs_manual", { error: "upload 模式但 P1 未上传(bv 为空),请重跑或人工上传" });
    notify({ kind: "error", stage: "上传", message: `${streamKey} upload 模式但 P1 未上传(bv 为空),请人工处理` });
    return { state: "needs_manual" };
  }

  jlog(`P1 上传完成: ${bv}`);
  ledger.markDone(streamKey, bv!);
  notify({ kind: "uploadDone", bv: bv!, url: `https://www.bilibili.com/video/${bv!}` });
  // 收口闸门:先核验分 P 数再决定删不删源(T11);清理失败只标 clean_*(T12),终态恒为 done。
  const finalize = await finalizeAfterUpload({
    streamKey, bv: bv!, deps, log: jlog, notify, cleanupSources,
    on: { plain: true, danmu: burnDanmu, livechat: burnLivechat },
  });
  // 核验判定「不完整」→ 该场对用户是未完成的活(转人工),返回值必须跟上,不能还报 done。
  if (finalize.verifyBlocked) return { state: "needs_manual", bv: bv! };
  if (clean.stageAfterDone) {
    ledger.logStep(streamKey, "clean_stage", "start");
    // 合成视频产物总删;.xml/.ass 按 xmlKeepRule(stage)=true(=stageAfterDone 开)一并删
    // —— 此时节点源 .xml 已保留,不会两处同时删光。
    const present = videoOnly([plain, danmuMp4, livechatMp4]).filter(Boolean).filter(existsSync);
    // 分P标题别名目录(硬链接)也在这里清掉,否则会随 stage 长期残留。
    const aliasDir = path.join(stageSub, UPLOAD_ALIAS_DIR);
    if (existsSync(aliasDir)) present.push(aliasDir);
    if (xmlKeepRule("stage", true)) {
      present.push(...readdirSyncSafe(stageSub)
        .filter((f) => /\.(xml|ass)$/i.test(f))
        .map((f) => path.join(stageSub, f)));
    }
    // 清理失败(T12)绝不外抛:抛出去会被 reconciler 当成 pipeline 失败 → job 变 failed →
    // 自动重跑整场 = **重复投稿**。只把 clean_stage 标 failed 供补跑。
    const stageFailed: CleanupFailure[] = [];
    try { await rmStage(present); }
    catch (e) { stageFailed.push({ target: stageSub, error: String((e as Error)?.message ?? e).slice(0, 200) }); }
    if (stageFailed.length === 0) {
      ledger.logStep(streamKey, "clean_stage", "done", `删 ${present.length} 文件`);
    } else {
      ledger.logStep(streamKey, "clean_stage", "done", `删 ${present.length} 文件 · 失败`);
      ledger.syncNodeState(streamKey, "clean_stage", "failed", {
        error: stageFailed.map((f) => `${f.target}: ${f.error}`).join("; ").slice(0, 500),
      });
      jlog(`清理失败(clean_stage):${stageFailed.map((f) => f.error).join("; ")}`);
    }
  }
  return { state: "done", bv };
}


/**
 * 续跑:已建稿(bv 已落库),只补没做完的 append。产物齐全 → markDone;缺失 → needs_manual。
 * 不做 sourceAfterDone(无成员清单),只做 append + 可选 stageAfterDone 清理。
 */
async function resumeAppends(
  streamKey: string,
  bv: string,
  stageSub: string,
  deps: PipelineDeps,
  jlog: (msg: string) => void,
  members: Broadcast["members"],
): Promise<{ state: JobState; bv?: string }> {
  const { ledger, appendGroup, notify, cfg } = deps;
  jlog(`续跑:已建稿 bv=${bv},跳过 select/pull/merge/burn/uploadPlain,只补 append`);
  const splitForUpload = deps.splitForUpload ?? defaultSplitForUpload;
  const burnDanmu = cfg.steps?.burnDanmu !== false;
  const burnLivechat = cfg.steps?.burnLivechat !== false;
  const isPublic = cfg.uploadPrivate === false;

  const wasDone = ledger.get(streamKey)?.state === "done";
  const prod = deriveStageProducts(stageSub);
  if (!prod) {
    // stage 产物已不存在:若该场**本来就 done**(T12 收尾补跑:stageAfterDone 已清空),
    // 说明上传早已完成、这里只是来补清理的 → 绝不能把 done 打成 needs_manual
    // (那会让 UI 显示"待人工",而实际上稿件好好的)。走「只清理」收口。
    if (wasDone) {
      jlog(`续跑:job 已 done 且 stage 产物已清理 → 只补收尾清理(不重跑上传)`);
      return await finalizeOnly(streamKey, bv, deps, jlog, notify, members, stageSub);
    }
    jlog(`续跑失败:stage 产物缺失(可能已清理),转人工。`);
    ledger.setState(streamKey, "needs_manual", { error: `续跑失败:bv=${bv} 但 stage 产物缺失,请人工补 append` });
    notify({ kind: "error", stage: "上传", message: `续跑失败:${bv} 产物缺失,请人工处理(补 append 或删稿重来)` });
    return { state: "needs_manual", bv };
  }
  // 续跑前先修复失败的烧录节点:docker crash / 中断可能留下半成品(文件在但缺 moov),
  // 直接 append 会把坏文件传上去;烧录是本地产物,重烧不会重复投稿。
  const burnRepairs: Array<{ step: "burn_danmu" | "burn_livechat"; on: boolean }> = [
    { step: "burn_danmu", on: burnDanmu },
    { step: "burn_livechat", on: burnLivechat },
  ];
  for (const br of burnRepairs) {
    if (!br.on) continue;
    if (ledger.getNodeState(streamKey, br.step)?.state !== "failed") continue;
    jlog(`续跑发现失败节点 ${br.step},先重烧再 append`);
    const workflow = buildWorkflow({
      streamKey, stageSub, products: prod, deps, cfg,
      log: jlog, willUpload: true, burnDanmu, burnLivechat, segmentCount: 0,
    });
    const repaired = await runWorkflowNodes({
      streamKey,
      nodes: workflow.nodes.filter((n) => n.key === br.step),
      edges: [],
      ctx: workflow.ctx,
      pool: deps.pool ?? new ResourcePool(),
      forceRetry: new Set<WorkflowNodeKey>([br.step]),
    });
    if (!repaired.ok) {
      const err = ledger.getNodeState(streamKey, br.step)?.error ?? `重烧失败: ${br.step}`;
      jlog(`续跑重烧 ${br.step} 失败,转人工: ${err}`);
      ledger.setState(streamKey, "needs_manual", { error: err });
      notify({ kind: "error", stage: "上传", message: `续跑重烧 ${br.step} 失败,请人工处理: ${err}` });
      return { state: "needs_manual", bv };
    }
  }
  const need = [
    ...(burnDanmu ? [prod?.danmuMp4] : []),
    ...(burnLivechat ? [prod?.livechatMp4] : []),
  ].filter((f): f is string => !!f);
  if (need.some((f) => !existsSync(f))) {
    jlog(`续跑失败:stage 产物缺失(可能已清理),转人工。need=${JSON.stringify(need)}`);
    ledger.setState(streamKey, "needs_manual", { error: `续跑失败:bv=${bv} 但 stage 产物缺失,请人工补 append` });
    notify({ kind: "error", stage: "上传", message: `续跑失败:${bv} 产物缺失,请人工处理(补 append 或删稿重来)` });
    return { state: "needs_manual", bv };
  }

  const groups: Array<{ step: "append_danmu" | "append_livechat"; mp4: string; on: boolean }> = [
    { step: "append_danmu", mp4: prod.danmuMp4, on: burnDanmu },
    { step: "append_livechat", mp4: prod.livechatMp4, on: burnLivechat },
  ];
  for (const g of groups) {
    if (!g.on) continue;
    if (ledger.isStepDone(streamKey, g.step)) { jlog(`append 跳过(已完成): ${g.step}`); continue; }
    const files = await splitForUpload(g.mp4);
    if (files.length === 0) continue;
    // 多段组(>16GB)无法安全续跑:上一轮可能已 append 部分段,重跑会重复分 P(无 per-part checkpoint)→ 转人工。
    if (files.length > 1) {
      jlog(`续跑无法安全处理多段组 ${g.step}(${files.length} 段,可能已 append 部分)→ 转人工`);
      ledger.setState(streamKey, "needs_manual", { error: `续跑遇多段组 ${g.step}(${files.length} 段),无法安全续传,请人工核对分 P` });
      notify({ kind: "error", stage: "上传", message: `${bv} 续跑遇多段组 ${g.step},无法安全续传,请人工核对分 P` });
      return { state: "needs_manual", bv };
    }
    jlog(`续跑 append 开始: ${g.step} (${files.length} 段)`);
    ledger.logStep(streamKey, g.step, "start");
    // 与主 workflow 一致:B站追加分 P 后稿件短暂锁定,60s*2^n 退避等锁释放。
    const tries = files.length === 1 ? 5 : 1;
    // 经**全局上传队列**执行(与主 workflow / 分段路径同一口径):否则续跑补 append 会绕过
    // 提交限速与 601 冷却,多场同时续跑时直接打爆 B 站频率限制。
    const submit = (): Promise<void> =>
      deps.pool
        ? deps.pool.withUpload(() => appendGroup({ bv, files, cookies: cfg.cookies, public: isPublic }), streamKey)
        : appendGroup({ bv, files, cookies: cfg.cookies, public: isPublic });
    await retry(submit, {
      tries,
      backoffMs: 60_000,
      sleep: deps.sleep,
      onRetry: (attempt, err) => jlog(`续跑 append ${g.step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
    });
    // 续跑补的 append 同样要记 checkpoint(T11.8):否则核验基线只含首轮提交的组,
    // 续跑补上的分 P 不计入期望 → 假 mismatch。
    for (let i = 0; i < files.length; i++) {
      const grp = g.step === "append_danmu" ? PART_GROUP_CANONICAL.danmu : PART_GROUP_CANONICAL.livechat;
      ledger.markPartDone(streamKey, grp, i);
    }
    ledger.logStep(streamKey, g.step, "done", `${files.length} 段`);
    jlog(`续跑 append 完成: ${g.step}`);
  }

  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });

  // 上传成功 → 与主路径同一收口闸门:核验分 P 数 → 才删源(T11/T12)。
  // 续跑此前漏了 sourceAfterDone,是节点源残留的来源之一,这里一并补上。
  const rmStageFn = deps.rmStage ?? defaultRmStage;
  const cleanupSources = async (opts?: { skipNodeSources?: boolean }): Promise<CleanupOutcome> =>
    cleanupSourcesShared({
      streamKey, ledger, transports: deps.transports, members,
      cleanup: cfg.cleanup,
      stagePulledSources: members.flatMap((m) => m.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)))),
      rmStage: rmStageFn, log: jlog,
      skipNodeSources: opts?.skipNodeSources,
    });
  const finalize = await finalizeAfterUpload({
    streamKey, bv, deps, log: jlog, notify, cleanupSources,
    on: { plain: true, danmu: burnDanmu, livechat: burnLivechat },
  });
  if (finalize.verifyBlocked) return { state: "needs_manual", bv };

  // 可选:done 后删 stage 产物(与主路径同一开关;续跑不删 slave 源)。
  if (cfg.cleanup?.stageAfterDone) {
    const products = videoOnly([prod.plain, prod.danmuMp4, prod.livechatMp4]);
    ledger.logStep(streamKey, "clean_stage", "start");
    try { await rmStageFn(products); ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length} 文件(不含 .xml/.ass)`); }
    catch (e) {   // 同上:清理失败不外抛(否则整场被判 failed → 重跑 = 重复投稿)
      const msg = String((e as Error)?.message ?? e).slice(0, 200);
      ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length} 文件 · 失败`);
      ledger.syncNodeState(streamKey, "clean_stage", "failed", { error: msg });
      jlog(`清理失败(clean_stage):${msg}`);
    }
  }
  return { state: "done", bv };
}
