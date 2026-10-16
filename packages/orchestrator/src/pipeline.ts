import path from "node:path";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import type { Broadcast } from "./identity.js";
import type { NodeRecording, Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import { formatBiliTitle, isAtomicTempName, formatPartTitle, isAppendAmbiguous, isJobAbort, isUploadRateLimited, burnFlags, pipelineBurns, effectiveStageFormat, resolveOutputStem, runWithJob, sanitizeStreamKey, survivingArtifacts, throwIfAborted, STAGE_READY, USER_STOP, VIDEO_EXT_ALT, type BurnSteps, type NotifyEvent, type ScopedLogger } from "@drec/core";
import type { OutputFormat, UploadOpts } from "@drec/core";
import { groupSessionsInDir } from "@drec/post-process";
import { selectWinner } from "./select.js";
import { retry } from "./retry.js";
import { humanBytes, sumBytes } from "./format.js";
import { buildWorkflow, deriveStageProducts, runWorkflowNodes, ResourcePool, type StageProducts, type WorkflowNodeKey } from "./workflow.js";
import { deriveSegmentPlan, stageProductPaths, UPLOAD_ALIAS_DIR } from "./session-plan.js";
import { runSegmentPipeline } from "./segment-pipeline.js";
// 节点侧上传(experimental,plans/027):全部逻辑隔离在 node-side-upload.ts,便于快速开关/回退。
import { shouldUseNodeSideUpload, tryNodeSideUpload } from "./node-side-upload.js";
import { PART_GROUP_CANONICAL, verifyMessage, verifyParts, verifyUploaded } from "./verify.js";
import { launchFinalizeFormat, type FinalizeFormatDeps } from "./finalize-format.js";

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
  /** `.ts` 直传(节点侧):单段独占分 P 的 `.ts` 不 remux 直接作上传物,见 HubPipelineConfig.steps.tsDirect。 */
  tsDirect?: boolean;
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

/** 清理路径兜底:只处理视频(.ts/.mp4/.flv 等);.xml/.ass 走 xmlKeepRule 单独判定。 */
export const videoOnly = (paths: string[]): string[] => paths.filter((p) => !/\.(xml|ass)$/i.test(p));

/**
 * 合并前自检(issue #143):`pulled`(本场拉进 stage 的视频分段,取 basename)里,哪些没被 stage 目录上的
 * 会话分组(`groupSessionsInDir`,会读 stage 里的边车)认领。非空 = merge 会漏段。
 */
export function unclaimedStageSegments(stageSub: string, pulled: readonly string[]): string[] {
  const present = readdirSyncSafe(stageSub);
  const claimed = new Set<string>();
  for (const g of Object.values(groupSessionsInDir(stageSub, present))) for (const f of g.ts) claimed.add(path.basename(f));
  // 只核 stage 里确实在的文件:没拉到是 pull 自己的失败(由 pull/merge 的产物检查报),不是「未认领」。
  return videoOnly([...pulled]).map((f) => path.basename(f)).filter((f) => !isAtomicTempName(f) && present.includes(f) && !claimed.has(f));
}

/**
 * Pre-pull sidecar recheck (issue #146).
 *
 * `missing` and `unknown` must stay separate. `exists()` reports false only when the node answered
 * "gone" and throws when it could not tell; a thrown probe lands in `unknown`. Because a transport
 * could still report false for its own reasons, a false answer is additionally confirmed with
 * `ping()` before it is called a deletion. Only `missing` may count toward
 * {@link MAX_SIDECAR_SKIPS} — otherwise a flaky network would escalate a healthy session.
 */
export interface SidecarProbe {
  /** Node answered and the sidecar is gone → counts toward the consecutive-skip limit. */
  missing: string[];
  /** Could not be confirmed (unreachable node / probe threw) → skip the round, never count. */
  unknown: string[];
}

/**
 * Ask each winner member's node whether the sidecar the scan declared is still there.
 *
 * Transports without `exists` are trusted (same rule as member pruning). A `false` answer is only
 * treated as a deletion once `ping()` confirms the node is actually reachable; transports without
 * `ping` keep the previous behaviour (count it) — both real transports implement it.
 */
export async function probeSidecars(
  members: readonly { workerId: string; rec: { sessionJsonPath?: string } }[],
  transports: ReadonlyMap<string, { exists?: (paths: string[]) => Promise<boolean>; ping?: () => Promise<void> }>,
): Promise<SidecarProbe> {
  const missing: string[] = [];
  const unknown: string[] = [];
  for (const m of members) {
    const sidecar = m.rec.sessionJsonPath;
    const tp = transports.get(m.workerId);
    if (!sidecar || !tp?.exists) continue;
    let present: boolean;
    try { present = await tp.exists([sidecar]); }
    catch { unknown.push(sidecar); continue; }   // the probe itself failed → unknown, not "gone"
    if (present) continue;
    if (tp.ping) {
      try { await tp.ping(); }
      catch { unknown.push(sidecar); continue; }
    }
    missing.push(sidecar);
  }
  return { missing, unknown };
}

/** Ledger `pull` detail prefix for "skipped this round because the sidecar is confirmed gone". */
export const SIDECAR_SKIP_PREFIX = "跳过·";
/**
 * Ledger `pull` detail prefix for "skipped this round, could not confirm". Never counts toward the
 * limit: an unreachable node is a connectivity problem, and the reconciler already alerts on nodes
 * that fail inventory for several rounds.
 */
export const SIDECAR_UNKNOWN_PREFIX = "未确认·";
/** 连续跳过上限:默认对账 30 分钟一轮 → 约 1.5 小时仍缺失就不再等,转人工 + 告警。 */
export const MAX_SIDECAR_SKIPS = 3;

/**
 * Consecutive *confirmed-missing* skips since the last real `pull` start.
 *
 * An {@link SIDECAR_UNKNOWN_PREFIX} round neither counts nor resets: it carries no evidence either
 * way, so the confirmed-missing evidence on both sides of it still stands. Any other `pull` entry
 * (a real pull start/done) ends the streak.
 */
export function consecutiveSidecarSkips(steps: readonly { step: string; phase: string; detail?: string | null }[]): number {
  let n = 0;
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i];
    if (s.step !== "pull") continue;
    if (s.phase !== "done") break;
    if (s.detail?.startsWith(SIDECAR_SKIP_PREFIX)) n++;
    else if (s.detail?.startsWith(SIDECAR_UNKNOWN_PREFIX)) continue;
    else break;
  }
  return n;
}

const STAGE_VIDEO_RE =new RegExp(`\\.(${VIDEO_EXT_ALT})$`, "i");

/**
 * stage 目录顶层的「视频类内容」(视频容器全集 ts/flv/mp4/mkv,来自 core 注册表 + `.work/` `.upload/` 中间产物目录)。
 * 用于 `stageAfterDone` 的整场清空:拉回的源段副本(本机胜出时是硬链接)、续跑残留、中间产物都在其中。
 * 另含随 pull 拉进 stage 的会话边车副本 `*.session.json`(issue #143;stage 里只有 pull 会产生它,
 * 删的只是 stage 的名字,节点源 / 本机硬链接源不受影响)—— 否则 `stageAfterDone` 清空后会残留。
 * 归属 = core `survivingArtifacts().stageSidecarCopies`(随 stage 清空而删;`stageAfterDone` 关时本函数不会被调用)。
 * **绝不包含** `.xml/.ass/job.log`;只看顶层、不递归未知目录;不返回 stageSub 本身。
 * 调用方必须自己保证「上传已确认 + 有稿件号」(见 finalizeAfterUpload)。
 */
export function stageVideoLeftovers(stageSub: string): string[] {
  const out: string[] = [];
  for (const name of readdirSyncSafe(stageSub)) {
    const p = path.join(stageSub, name);
    let isDir: boolean;
    try { isDir = lstatSync(p).isDirectory(); } catch { continue; }
    if (isDir ? name === ".work" || name === ".upload" : STAGE_VIDEO_RE.test(name) || name.endsWith(".session.json")) out.push(p);
  }
  return out;
}

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
  // 判定唯一实现在 core `survivingArtifacts`;「该侧可删」= 该侧 xml 不在留存清单里。
  const s = survivingArtifacts({ pipeline: { cleanup: { sourceAfterDone: true, stageAfterDone } } }, { stageHasXmlCopy: true });
  return side === "node" ? !s.nodeXml : !s.stageXml;
}

export interface PipelineCfg {
  cleanMaxGapSec: number;
  /** 断流重连合并窗(ms):结束距现在不足该窗的场暂不处理;聚类容差同窗。缺省 reconciler 默认 10 分钟。 */
  reconnectWindowMs?: number;
  /**
   * **磁盘水位闸门阈值(GB)** —— 与 reconciler 的磁盘看门狗**同一个配置键 / 同一个默认值**
   * (hub.config 的 `resources.diskMinGB`,缺省 10;`<=0` = 关闭)。
   *
   * 消费点:节点侧上传选路(节点剩余空间低于阈值 → **不选节点侧**,回落 pull 回 master)——
   * 盘满会让节点本地 remux 写盘 `ENOSPC` → 节点进程非 0 退出 → ssh rc≠0 → 保守转人工。
   * 未注入(undefined)= 闸门关闭(向后兼容,测试与旧调用方不受影响);`<=0` = 关闭;非数字(字符串/NaN)按 core `resolveDiskMinGB` 回落 10GB。
   * 解析口径唯一真理源:core `resolveDiskMinGB`(daemon / reconciler / 本闸门 / cli 共用)。
   */
  diskMinGB?: number;
  stageDir: string;
  cookies: string;
  /** stage = 只合成不传;upload = 传 B站。 */
  uploadMode: "stage" | "upload";
  /**
   * 输出格式(issue #137),**内部**:CLI 从规则绑定的源任务读(同 `segmentGroupSec` 的做法),不在 hub 规则里配。
   * 缺省 / original = 现状(mp4);实际容器一律经 core `effectiveStageFormat(outputFormat, uploadMode)`
   * 算出(投稿强制 mp4),**消费点不得自己再判**。
   */
  outputFormat?: OutputFormat;
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
  /**
   * 收尾后留存源分段转输出格式(plans/036 T9b)。**存在 = 启用**(缺省不注入 = 行为与此前一致,测试/兼容);
   * done + 清理完成后 fire-and-forget 派发,绝不阻塞 done、不碰上传路径。
   */
  finalizeFormat?: FinalizeFormatDeps;
  /** 旁路校验(issue #92)延迟多久再回读分 P 数(ms)。缺省 10 分钟;**只记录/告警,绝不影响清理**。 */
  sideCheckDelayMs?: number;
  /** 旁路校验的定时器注入(测试用:捕获/立即执行)。缺省 setTimeout(unref,不阻止进程退出)。 */
  scheduleSideCheck?: (fn: () => void, ms: number) => void;
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
   * **强制保留节点源 .xml**(节点侧上传路径专用)。
   *
   * 常规路径里 `xmlKeepRule("node", stageAfterDone)` 的前提是「stage 里有 xml 副本」(pull 会带上),
   * 故 `stageAfterDone=false` 时允许删节点 xml。但**节点侧上传从不把 xml 拉回/复制进 stage**
   * ⇒ 节点源 xml 恒为**最后一份**,任何情况下都不能删(否则弹幕永久丢失,AGENTS.md 明令禁止)。
   */
  keepNodeXml?: boolean;
}): Promise<CleanupOutcome> {
  const clean = o.cleanup ?? {};
  const survivors = survivingArtifacts({ pipeline: { cleanup: clean } }, { stageHasXmlCopy: !o.keepNodeXml });
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
  if (clean.sourceAfterDone) {
    // 节点源 xml 去留 = 留存清单(keepNodeXml 即 stageHasXmlCopy:false:节点侧上传无 stage xml 副本,节点 xml 恒为最后一份)。
    const delNodeXml = !survivors.nodeXml;
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
    if (!survivors.stageXml) {
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
 * **上传后的收口(单一插入点,合并路径 / 分段路径 / 两条续跑共用)**。
 *
 * 顺序是硬标准,不可调换:
 *   1. `markDone` —— **先**把 job 标成功(上传确实成功了);
 *   2. 清理(T12):走到这里 = 上传已确认(biliup 返回 0),按配置**无条件**清理;清理失败**绝不**改终态,
 *      只把 `clean_*` 标 failed 供补跑;
 *   3. 旁路校验(issue #92):延迟(默认 10 分钟)回读 B站分 P 数,**只记录/告警,不影响清理**。
 *
 * 为什么回读不再是清理的闸门:B站分 P 列表是最终一致的,回读反复把已成功的上传判成「疑似缺失」,
 * 据此保留源只会让磁盘持续涨(见 issue #66 / #92)。真丢分 P 的兜底 = biliup 退出码非 0。
 */
/**
 * **只清理**收口(T12 补跑专用):该场已 done、stage 产物已被清空,再跑一遍上传流程毫无意义
 * 且危险(可能重复投稿)。这里只做收尾:按配置删源,并走一遍统一收口(含延迟的旁路校验)。
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
  /** `keepNodeXml`:节点侧上传的场没有 stage 里的 xml 副本,节点源 xml 是最后一份 → 必须保留。 */
  opts: { keepNodeXml?: boolean } = {},
): Promise<{ state: JobState; bv?: string }> {
  const rmStageFn = deps.rmStage ?? defaultRmStage;
  const cfg = deps.cfg;
  const fin = await finalizeAfterUpload({
    streamKey, bv, deps, log: jlog, notify,
    cleanupSources: () => cleanupSourcesShared({
      streamKey, ledger: deps.ledger, transports: deps.transports, members,
      cleanup: cfg.cleanup,
      ...(opts.keepNodeXml ? { keepNodeXml: true } : {}),
      stagePulledSources: members.flatMap((m) => m.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)))),
      rmStage: rmStageFn, log: jlog,
    }),
    on: { plain: true, danmu: burnFlags(cfg.steps).burnDanmu, livechat: burnFlags(cfg.steps).burnLivechat },
  });
  // 收尾补跑:此前未清干净的 stage 视频类内容在这里补清(同一口径)。
  if (cfg.cleanup?.stageAfterDone) {
    const left = stageVideoLeftovers(stageSub);
    if (left.length > 0) {
      deps.ledger.logStep(streamKey, "clean_stage", "start");
      try { await rmStageFn(left); deps.ledger.logStep(streamKey, "clean_stage", "done", `删 ${left.length} 文件(补清 stage 视频类)`); }
      catch (e) {
        const msg = String((e as Error)?.message ?? e).slice(0, 200);
        deps.ledger.logStep(streamKey, "clean_stage", "done", `删 ${left.length} 文件 · 失败`);
        deps.ledger.syncNodeState(streamKey, "clean_stage", "failed", { error: msg });
        jlog(`清理失败(clean_stage):${msg}`);
      }
    }
  }
  return { state: "done", bv };
}

/** 旁路校验默认延迟:B站追加分 P 后列表刷新有延迟,读太早会误报(issue #92)。 */
export const DEFAULT_SIDE_CHECK_DELAY_MS = 10 * 60_000;

/** 本进程已排过旁路校验的场(收尾补跑会重复走到收口,不能每次都排一遍 → 重复告警)。有界,超限丢最旧。 */
const sideCheckScheduled = new Set<string>();
const SIDE_CHECK_MEMO_MAX = 2000;

/**
 * **旁路校验**(issue #92):上传确认(biliup 返回 0)后,延迟一段时间回读 B站分 P 数,
 * **只写日志 / 台账备注 / 告警,绝不改变清理结果、不转人工、不重传**。
 *
 * 为什么降级为旁路:回读读到的是 B站最终一致的列表,实测反复把已成功的上传判成「疑似缺失」
 * (见 issue #66 / #92),据此保留源只会让磁盘持续涨。真丢分 P 的兜底 = biliup 退出码非 0。
 *
 * 定时器只在内存里:进程重启则丢这一次校验——它只是旁路观察,丢了不影响任何数据。
 * 任何异常一律吞掉(只记日志):旁路绝不能把主线搞挂。
 */
export function scheduleSideCheck(o: {
  deps: PipelineDeps;
  streamKey: string;
  bv: string;
  on: { plain: boolean; danmu: boolean; livechat: boolean };
  log: (msg: string) => void;
  notify: (e: NotifyEvent) => void;
}): void {
  const { deps, streamKey, bv, on, log } = o;
  if (!deps.countParts || !bv) return;
  const memo = `${streamKey}|${bv}`;
  if (sideCheckScheduled.has(memo)) return;
  sideCheckScheduled.add(memo);
  if (sideCheckScheduled.size > SIDE_CHECK_MEMO_MAX) sideCheckScheduled.delete(sideCheckScheduled.values().next().value as string);
  const run = async (): Promise<void> => {
    try {
      const v = await verifyUploaded(deps.ledger, streamKey, bv, on, deps.countParts,
        deps.sleep ? { sleep: deps.sleep } : {});
      const text = verifyMessage(v, streamKey, bv);
      if (v.kind === "mismatch") {
        const note = `旁路校验:期望 ${v.expected} 个分 P、B站回读 ${v.actual} 个(仅记录;源已按 biliup 返回码清理)`;
        deps.ledger.logStep(streamKey, "clean_verify", "done", note);
        deps.ledger.syncNodeState(streamKey, "clean_verify", "done", { error: note });
        log(`${note} bv=${bv}`);
        o.notify({ kind: "error", stage: "上传", message: `${streamKey} ${note}(bv=${bv}),请在创作中心确认分 P` });
      } else if (v.kind === "ok") {
        deps.ledger.logStep(streamKey, "clean_verify", "done", `旁路校验通过:${v.actual} 个分 P`);
        log(text);
      } else {
        log(`旁路校验未得出结论:${text}`);
      }
    } catch (e) {
      log(`旁路校验异常(忽略,不影响清理):${String((e as Error)?.message ?? e)}`);
    }
  };
  const delay = Math.max(0, deps.sideCheckDelayMs ?? DEFAULT_SIDE_CHECK_DELAY_MS);
  const schedule = deps.scheduleSideCheck
    ?? ((fn: () => void, ms: number): void => { setTimeout(fn, ms).unref?.(); });
  schedule(() => { void run(); }, delay);
}

export async function finalizeAfterUpload(o: {
  streamKey: string;
  bv: string;
  deps: PipelineDeps;
  log: (msg: string) => void;
  /** 清理各节点源(+ 可选 stage 拉来源段);上传确认后无条件调用。 */
  cleanupSources: () => Promise<CleanupOutcome>;
  on: { plain: boolean; danmu: boolean; livechat: boolean };
  notify: (e: NotifyEvent) => void;
}): Promise<CleanupOutcome> {
  const { deps, streamKey, bv, log } = o;
  // **上传是否成功只看 biliup 返回码**(issue #92):走到这里 = 上传已确认(返回 0),按配置清理。
  // 回读分 P 数不再是清理的闸门,只作旁路校验(延迟回读,见 scheduleSideCheck)。
  // clean_verify 记为 done:不再产生 pending 软状态,收尾补跑不会因它反复重入。
  deps.ledger.syncNodeState(streamKey, "clean_verify", "done", { error: null });
  const outcome = await o.cleanupSources();
  scheduleSideCheck({ deps, streamKey, bv, on: o.on, log, notify: o.notify });
  return outcome;
}

/**
 * 边录边传(T-33)识别短路:若本场录像来自「录制节点已边录边传」的会话(`{base}.rolling.json`
 * 带 bv),则 master **绝不重复建稿** —— 直接收口为 done(带该 BV),并按 sourceAfterDone 删源。
 *
 * 为什么必须在**最早**短路:节点上传确认后已删该段源视频,覆盖率/选优会失真(可能误报未录全),
 * 不能靠下游判定。这里只看 sidecar 的权威事实(录制节点自己写的 BV)。
 *
 * 配置变更对正在进行的一场不生效(下一场起生效):若收口时当前规则已开烧录(`pipelineBurns(cfg.steps)`),
 * 该场仍按起录时(边录边传)配置收口 done,仅写 job.log 并通知「新配置下一场生效」,不转人工、不改上传/删源行为。
 *
 * 边界:
 *   - 没有任何成员带 rolling.bv → 返回 null,走常规路径(未启用边录边传 = 行为不变)。
 *   - 有 rolling.bv 但存在 ambiguous 段(结果不确定)→ **转人工**(保留源,不自动重传)。
 *   - 有 rolling.bv 但**磁盘上仍剩未确认分段**(进程在 onSessionEnd 前被杀)→ **转人工**:
 *     那些段的画面没进 BV,静默 done 会**丢片**。确认段会被删,故「还剩 ts」= 未确认。
 *   - 多个成员都带 rolling.bv 且 **BV 不一致** → 说明多节点各建稿(不该发生,闸门已挡)→ 转人工。
 */
export function tryRollingShortCircuit(o: {
  streamKey: string;
  cfg: { steps?: BurnSteps | null };
  members: Broadcast["members"];
  ledger: SyncLedger;
  transports: Map<string, Transport>;
  notify: (e: NotifyEvent) => void;
  jlog: (m: string) => void;
  /** 收口 done 后的回读核验接缝(只记录日志,不阻塞、不转人工;观察期)。缺省 = 不回读。 */
  countParts?: (bv: string) => Promise<number | null>;
}): { state: JobState; bv?: string } | null {
  const { streamKey, members, ledger, jlog, cfg } = o;
  if (ledger.get(streamKey)?.bv) return null; // 已有 BV(续跑) → 交给既有续跑路径
  // #57 R1 止血:有边传进度、**无稿件号**,且留有建稿意图(uploading.kind=create)或结果不确定(ambiguous)
  // = 建稿可能已提交、只是稿件号没落盘。此时走常规整场管线会**重复建稿**(B站不可逆)→ 转人工。
  // 先于 rolled/bvs 判定:同场其它成员即使有 bv(或没有任何 bv)也一样。
  const unsettled = members.filter((m) => rollingUnsettledWithoutBv(m.rec.rolling));
  if (unsettled.length > 0) {
    const detail = unsettled
      .map((m) => `${m.workerId}:${m.rec.sessionBase}(${describeUnsettled(m.rec.rolling!)})`)
      .join(";");
    jlog(`边录边传识别:无稿件号但存在建稿意图/不确定结果 [${detail}] → 转人工(不走常规整场管线,防重复建稿)`);
    ledger.setState(streamKey, "needs_manual", { error: `边录边传:建稿中断或结果不确定且无稿件号(${detail}),请人工核对稿件后处理` });
    o.notify({ kind: "error", stage: "上传", message: `${streamKey} 边录边传:建稿中断/结果不确定且无稿件号,已转人工核对(未走常规管线)` });
    return { state: "needs_manual" };
  }
  const rolled = members.filter((m) => m.rec.rolling?.bv);
  if (rolled.length === 0) return null;
  const bvs = [...new Set(rolled.map((m) => m.rec.rolling!.bv!))];
  if (bvs.length > 1) {
    // 区分根因:同一节点上的多个会话各自建稿(并列稿件)vs 不同节点各建稿。稿件号只进日志/通知,不进仓库。
    const perNode = new Map<string, Set<string>>();
    for (const m of rolled) (perNode.get(m.workerId) ?? perNode.set(m.workerId, new Set()).get(m.workerId)!).add(m.rec.rolling!.bv!);
    const sameNode = [...perNode.entries()].filter(([, set]) => set.size > 1);
    const list = bvs.join(",");
    const why = sameNode.length > 0
      ? `同节点多会话各自建稿(${sameNode.map(([w, set]) => `${w}:${[...set].join("/")}`).join(";")}),稿件并列`
      : `多节点各建稿(${list})`;
    jlog(`边录边传识别:${why} → 转人工(绝不自动重传,防重复投稿)`);
    ledger.setState(streamKey, "needs_manual", { error: `边录边传:${why},请人工核对合并或删重复稿` });
    o.notify({ kind: "error", stage: "上传", message: `${streamKey} 边录边传:${why},已转人工核对` });
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
  // 同节点上**无稿件号**的成员(如同节点后一个会话尚未开始上传)的视频也算未确认:它们不在该 BV 里,
  // 不计入 → 静默 done 会丢整个会话。其它节点的无稿件号成员是冗余录像,保持原口径不计。
  const rolledNodes = new Set(rolled.map((m) => m.workerId));
  const residual = members
    .filter((m) => m.rec.rolling?.bv || rolledNodes.has(m.workerId))
    .flatMap((m) => m.rec.tsFiles);
  if (residual.length > 0) {
    jlog(`边录边传识别:BV=${bv} 但磁盘仍剩 ${residual.length} 个未确认分段 → 转人工(不静默 done,防丢片)`);
    ledger.setState(streamKey, "needs_manual", { error: `边录边传:BV=${bv} 仍有 ${residual.length} 个未确认分段,请人工核对补传` });
    o.notify({ kind: "error", stage: "上传", message: `${streamKey} 边录边传:仍有未确认分段,已转人工` });
    return { state: "needs_manual", bv };
  }
  // 录制节点已建稿且全部确认 → master 直接收口 done。节点侧已删各确认段源视频,这里只标记完成
  // (本函数不删源、不看 uploadMode/sourceAfterDone)。
  jlog(`边录边传识别:录制节点已建稿 BV=${bv}(确认 ${rolled.flatMap((m) => m.rec.rolling?.confirmed ?? []).length} 段)→ 直接 done,绝不重复建稿`);
  if (pipelineBurns(cfg.steps)) {
    const msg = `${streamKey} 该场按起录时配置收口,新配置(烧录)下一场生效`;
    jlog(`边录边传识别:当前规则烧录已开启,与起录时配置不一致 → ${msg}(仍按 rolling 收口 done,BV=${bv})`);
    o.notify({ kind: "error", stage: "边录边传", message: `${msg}(BV=${bv})` });
  }
  ledger.setBv(streamKey, bv);
  ledger.markDone(streamKey, bv);
  o.notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}`, streamKey });
  // 回读核验(#57 R1 观察期):只记日志,不阻塞、不转人工、不影响 done。fire-and-forget,任何异常吞掉。
  const confirmed = new Set(rolled.flatMap((m) => m.rec.rolling?.confirmed ?? []));
  if (o.countParts && confirmed.size > 0) {
    void readbackRollingParts(o.countParts, bv, confirmed.size, streamKey, jlog);
  }
  return { state: "done", bv };
}

/** 无稿件号、但留有建稿意图(create)或不确定段 = 建稿可能已提交而稿件号丢失。 */
function rollingUnsettledWithoutBv(r: NodeRecording["rolling"]): boolean {
  if (!r || r.bv) return false;
  return r.uploading?.kind === "create" || (r.ambiguous?.length ?? 0) > 0;
}

function describeUnsettled(r: NonNullable<NodeRecording["rolling"]>): string {
  const parts: string[] = [];
  if (r.uploading?.kind === "create") parts.push(`建稿中 段${r.uploading.index}`);
  if (r.ambiguous?.length) parts.push(`不确定段 ${r.ambiguous.join(",")}`);
  return parts.join(" + ");
}

/** rolling 收口 done 后读回稿件分 P 数与已确认段数对照,**仅**写 job.log。 */
async function readbackRollingParts(
  countParts: (bv: string) => Promise<number | null>,
  bv: string,
  expected: number,
  streamKey: string,
  jlog: (m: string) => void,
): Promise<void> {
  try {
    const v = verifyParts(expected, await countParts(bv));
    const msg = v.kind === "ok" ? `分 P 数与已确认段数一致(${v.actual})`
      : v.kind === "mismatch" ? `分 P 数不符:已确认 ${v.expected} 段、稿件实际 ${v.actual}(观察期仅记录,未阻塞)`
      : v.kind === "unknown" ? `读取分 P 数失败(${v.reason}),未核验`
      : `跳过核验(${v.reason})`;
    jlog(`边录边传回读核验 ${streamKey} BV=${bv}: ${msg}`);
  } catch (e) {
    jlog(`边录边传回读核验 ${streamKey} BV=${bv}: 异常(${String((e as Error)?.message ?? e)}),未核验`);
  }
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
): Promise<{ state: JobState; bv?: string; stageReady?: true }> {
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
      // 收尾后留存转格式(T9b):单一插入点 —— 所有 done 出口(合并 / 分段 / 各续跑 / 节点侧上传)都经此,且已在清理之后。
      // fire-and-forget:不 await(launch 永不 reject),done 判定与上传路径不受影响。
      // stage 交付模式的正常终点(stageReady,清理之后)同样派发;其余 needs_manual(失败 / 不确定 / 用户停止)一律不派发。
      if (r.state === "done" || r.stageReady === true) {
        void launchFinalizeFormat({ b, deps, stageSub: path.join(deps.cfg.stageDir, sanitizeStreamKey(b.streamKey)), log: jlog });
      }
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
): Promise<{ state: JobState; bv?: string; stageReady?: true }> {
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
  const { burnDanmu, burnLivechat } = burnFlags(cfg.steps); // 默认开
  const clean = cfg.cleanup ?? {};
  const { streamKey } = b;
  const stageSub = path.join(cfg.stageDir, sanitizeStreamKey(streamKey));
  // 后处理产物容器:唯一出处 core effectiveStageFormat(original→mp4;投稿强制 mp4)。
  const stageFmt = effectiveStageFormat(cfg.outputFormat, cfg.uploadMode);

  // 续跑:job 已有 bv ⇒ P1 已建稿(不可逆),绝不重传。跳过 select/pull/merge/burn/uploadPlain,只补 append。
  const existing = ledger.get(streamKey);
  // issue #91:节点侧上传的 done 场收尾补跑 —— 只补核验 + 删源,**不重新选优/拉回/上传**。
  // 必须排在下面「合并模式续跑」之前:否则合并模式的 done 场走 resumeAppends → finalizeOnly(不带 keepNodeXml),
  // 会把节点上**最后一份** .xml 一并删掉。
  // 此前补跑会重入整条管线,在节点侧入口撞「已建稿」护栏,刷「请人工核对」告警且收尾永不收敛。
  // 判据 = 「这场实际走过节点侧上传(台账 node_upload=done)」或「当前配置走节点侧」:只看当前配置的话,
  // 规则后来改了(关节点侧/开烧录)再补跑,会落到 resumeAppends → finalizeOnly 不带 keepNodeXml,删掉最后一份 .xml。
  const ranNodeSide = ledger.getNodeState(streamKey, "node_upload")?.state === "done";
  if (existing?.state === "done" && existing.bv
      && (ranNodeSide || shouldUseNodeSideUpload(cfg, { burnDanmu, burnLivechat }).ok)) {
    jlog(`节点侧上传的 done 场补跑收尾:只补核验 + 删源(bv=${existing.bv}),不重传`);
    return await finalizeOnly(streamKey, existing.bv, deps, jlog, notify, b.members, stageSub, { keepNodeXml: true });
  }

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
    // 无稿件号但留有建稿意图/不确定段的成员也必须保留:剔除会让 rolling 短路看不到它 → 误走常规管线重复建稿。
    if ((m.rec.rolling?.bv && m.rec.tsFiles.length === 0) || rollingUnsettledWithoutBv(m.rec.rolling)) {
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
  const rollingShort = tryRollingShortCircuit({ streamKey, cfg, members: presentMembers, ledger, notify, transports, jlog, countParts: deps.countParts });
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
    ledger.setState(streamKey, "needs_manual", {
      winnerWorker: winner.workerId,
      error: "所有节点均断流未录全,已保留全部源,请人工对齐拼接",
    });
    notify({
      kind: "error",
      stage: "同步",
      message: `所有节点均断流未录全,最完整=${winner.workerId}(${Math.round(winner.rec.durationSec)}s),已保留全部源,请人工对齐拼接。覆盖度:${JSON.stringify(selection.perNode)}`,
    });
    return { state: "needs_manual" };
  }

  // The scan declares the sidecars; between the scan and the pull they can disappear (issue #146).
  // Recheck before pulling: gone → skip this round and wait for the next scan (a sidecar that is
  // really gone stops being declared, and the session is regrouped from the remaining segments).
  // Must return **before** advancing to `syncing` — that state is not in the reconciler's RETRYABLE
  // set, so advancing would wedge the job. Not recorded as `failed` either: that would burn a retry
  // and add alert noise for something a rescan resolves.
  const probe = await probeSidecars(winnerMembers, transports);
  if (probe.missing.length > 0 || probe.unknown.length > 0) {
    const prior = consecutiveSidecarSkips(ledger.getSteps(streamKey));
    if (probe.missing.length > 0 && prior >= MAX_SIDECAR_SKIPS) {
      // Confirmed gone for several rounds: stop waiting silently. `needs_manual` is not RETRYABLE,
      // so the alert fires once and no source file is touched.
      const names = probe.missing.map((f) => path.basename(f)).join(", ");
      const msg = `会话边车连续 ${prior} 轮扫描后仍消失(${names}),已转人工`;
      console.warn(`[pipeline] ${streamKey} ${msg}`);
      jlog(`${msg}(源文件未动)`);
      ledger.setState(streamKey, "needs_manual", { winnerWorker: winner.workerId, error: msg });
      notify({ kind: "error", stage: "同步", message: `${streamKey} ${msg},请检查节点上的会话边车与分段` });
      return { state: "needs_manual" };
    }
    const missingNames = probe.missing.map((f) => path.basename(f)).join(", ");
    const unknownNames = probe.unknown.map((f) => path.basename(f)).join(", ");
    const parts = [
      probe.missing.length > 0 ? `已消失(${missingNames})` : "",
      probe.unknown.length > 0 ? `无法确认(${unknownNames})` : "",
    ].filter(Boolean).join(" · ");
    console.warn(`[pipeline] ${streamKey} 会话边车 ${parts},本轮跳过,下一轮重扫`);
    if (probe.missing.length > 0) {
      jlog(`会话边车扫描后已消失(${missingNames}) → 本轮跳过该场(不记 failed),下一轮重扫后收口(第 ${prior + 1}/${MAX_SIDECAR_SKIPS} 次)`);
      // Ledger annotation (state untouched): the hub jobs page shows why this round did nothing, and
      // it is the counting source for the limit. Unconfirmed rounds are annotated separately and do
      // not count — a dropped ssh link must never escalate a healthy session to needs_manual.
      ledger.logStep(streamKey, "pull", "done",
        `${SIDECAR_SKIP_PREFIX}会话边车扫描后消失(${missingNames}),第 ${prior + 1}/${MAX_SIDECAR_SKIPS} 次`);
      if (probe.unknown.length > 0) {
        ledger.logStep(streamKey, "pull", "done", `${SIDECAR_UNKNOWN_PREFIX}会话边车无法确认(${unknownNames}),不计入上限`);
      }
    } else {
      jlog(`会话边车无法确认存在(${unknownNames}) → 本轮跳过该场(不记 failed、不计上限),下一轮重扫`);
      ledger.logStep(streamKey, "pull", "done", `${SIDECAR_UNKNOWN_PREFIX}会话边车无法确认(${unknownNames}),不计入上限`);
    }
    return { state: ledger.get(streamKey)?.state ?? "pending" };
  }

  // Mark syncing and pull files from winner node into a per-broadcast sub-directory
  ledger.advanceState(streamKey, "syncing", { winnerWorker: winner.workerId }); // done 场补跑:跳过
  const transport = transports.get(winner.workerId);
  if (!transport) throw new Error(`No transport for worker: ${winner.workerId}`);

  // ── 节点侧上传(experimental,plans/027)──────────────────────────────────────
  // 全部逻辑隔离在 node-side-upload.ts(含 kill switch);这里只做「是否该走」的判定 + 调用。
  // 不满足条件(未开启/全局停用/stage 模式/需烧录) → 记明原因后继续走下面的 pull 回 master。
  const nodeSide = shouldUseNodeSideUpload(cfg, { burnDanmu, burnLivechat });
  // earliest = 本场最早会话:开播时刻 / 直播标题 / 会话 base 的唯一口径。
  // 节点侧上传与 pull 回 master 的常规路径共用同一取值(否则节点侧渲染会偏)。
  const earliestRec = winnerMembers.reduce((a, m) => (m.rec.startMs < a.rec.startMs ? m : a));
  if (nodeSide.ok) {
    const nodeResult = await tryNodeSideUpload({
      streamKey, cfg, winner, winnerMembers, transport, ledger, jlog, notify, deps,
      // 收尾删源按**全部在场成员**(含落败节点)—— 与常规路径的 `candidates.members` 同口径。
      members: presentMembers,
      earliest: earliestRec,
      broadcastStartMs: b.startMs,
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
    // 会话边车带进 stage:stage 上的合并靠它认出节点侧已转换的 mkv/mp4 分段(issue #143)。旧 bundle 无此字段 = 不带。
    ...(m.rec.sessionJsonPath ? [m.rec.sessionJsonPath] : []),
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

  // 合并路径的兜底(issue #143):拉进 stage 的视频分段必须**全部**被 stage 上的会话分组认领。
  // 否则 merge 会静默丢掉整场会话(如边车缺失/不一致时已转换的 mkv)→ 成品缺段却照常往下走。
  // 未认领 → 转人工 + 告警,不进 merge/上传,不删任何源。分段模式(mergeSegments=false)逐段用 winnerMembers
  // 的显式路径、不经 groupSessions,不受此问题影响,故不套该检查。
  if (cfg.steps?.mergeSegments !== false) {
    const unclaimed = unclaimedStageSegments(stageSub, winnerMembers.flatMap((m) => m.rec.tsFiles));
    if (unclaimed.length > 0) {
      const names = unclaimed.slice(0, 5).join(", ") + (unclaimed.length > 5 ? " …" : "");
      jlog(`拉取的 ${unclaimed.length} 个视频分段未被任何会话认领(${names}) → 转人工(绝不删源)`);
      ledger.setState(streamKey, "needs_manual", {
        winnerWorker: winner.workerId,
        error: `${unclaimed.length} 个拉取的视频分段未被会话认领(会话边车缺失或与容器不符),已停止合并`,
      });
      notify({
        kind: "error",
        stage: "同步",
        message: `${streamKey} 拉取的 ${unclaimed.length} 个视频分段未被任何会话认领(会话边车缺失或与容器不符),已转人工,未合并、未删源`,
      });
      return { state: "needs_manual" };
    }
  }

  // 产物 stem / 标题:首次锁定(改模板不影响重跑)。合并与分段两条路径共用。
  // earliestRec 已在上面节点侧上传判定前算好(同一口径),这里复用,避免两处各减一次(改坏一处不报错)。
  const earliest = earliestRec;
  const derived = deriveStageProducts(stageSub, stageFmt);
  const existingStem = (ledger.get(streamKey)?.outputStem ?? "").trim()
    || (cfg.steps?.mergeSegments === false
      ? (deriveSegmentPlan(stageSub, undefined, stageFmt)?.dateName ?? "")
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
  ledger.advanceState(streamKey, "merging");
  const { plain, danmuMp4, livechatMp4 } = stageProductPaths(stageSub, dateName, stageFmt);
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
  const cleanupSources = async (): Promise<CleanupOutcome> =>
    cleanupSourcesShared({
      streamKey, ledger, transports, members: candidates.members,
      cleanup: clean, stagePulledSources, rmStage, log: jlog,
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
    ledger.setState(streamKey, "needs_manual", { error: STAGE_READY });
    // stage 模式**不做分P核验**(没有稿件/bv);清理失败只记 clean_* failed,不影响终态。
    await cleanupSources();
    // 正常终点(不是错误):走 stageReady,别再以「出错（同步）」打扰用户。
    notify({ kind: "stageReady", streamKey });
    return { state: "needs_manual", stageReady: true };
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
  notify({ kind: "uploadDone", bv: bv!, url: `https://www.bilibili.com/video/${bv!}`, streamKey });
  // 收口:上传确认(biliup 返回 0)后按配置清理(issue #92),回读分 P 数只做延迟旁路校验;
  // 清理失败只标 clean_*(T12),终态恒为 done。
  await finalizeAfterUpload({
    streamKey, bv: bv!, deps, log: jlog, notify, cleanupSources,
    on: { plain: true, danmu: burnDanmu, livechat: burnLivechat },
  });
  if (clean.stageAfterDone) {
    ledger.logStep(streamKey, "clean_stage", "start");
    // 合成视频产物总删;.xml/.ass 按 xmlKeepRule(stage)=true(=stageAfterDone 开)一并删
    // —— 此时节点源 .xml 已保留,不会两处同时删光。
    const present = videoOnly([plain, danmuMp4, livechatMp4]).filter(Boolean).filter(existsSync);
    // 上传确认后:stage 内其余视频类内容(拉回的源段副本、.work/.upload 中间产物)一并清(#60)。
    present.push(...stageVideoLeftovers(stageSub));
    // 分P标题别名目录(硬链接)也在这里清掉,否则会随 stage 长期残留。
    const aliasDir = path.join(stageSub, UPLOAD_ALIAS_DIR);
    if (existsSync(aliasDir)) present.push(aliasDir);
    if (xmlKeepRule("stage", true)) {
      present.push(...readdirSyncSafe(stageSub)
        .filter((f) => /\.(xml|ass)$/i.test(f))
        .map((f) => path.join(stageSub, f)));
    }
    const presentUniq = [...new Set(present)];
    present.length = 0; present.push(...presentUniq);
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
  const { burnDanmu, burnLivechat } = burnFlags(cfg.steps);
  const isPublic = cfg.uploadPrivate === false;

  // done 场的收尾补跑若在下面三处转人工:done 无出边,普通 setState 会被白名单拒绝 →
  // job 仍 done、告警照发、cleanupBackfillDue 周期性重复补跑刷告警。wasDone 时必须 force。
  const wasDone = ledger.get(streamKey)?.state === "done";
  const prod = deriveStageProducts(stageSub, effectiveStageFormat(cfg.outputFormat, cfg.uploadMode));
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
      ledger.setState(streamKey, "needs_manual", { error: err }, { force: wasDone });
      notify({ kind: "error", stage: "上传", message: `续跑重烧 ${br.step} 失败,请人工处理: ${err}` });
      return { state: "needs_manual", bv };
    }
  }
  const need = [
    ...(burnDanmu ? [prod?.danmuMp4] : []),
    ...(burnLivechat ? [prod?.livechatMp4] : []),
  ].filter((f): f is string => !!f);
  if (need.some((f) => !existsSync(f))) {
    // 本来就 done 的场(收尾补跑)+ 分P成品(plain/danmu/livechat mp4)已被 stageAfterDone **全部**清掉
    // = 上传早已完成,只补收尾;stage 里还剩拉回的源段(使 deriveStageProducts 非空)时同理,
    // 不能把 done 打成 needs_manual。成品只缺一部分(如有 plain 缺 danmu)= 真不一致,仍转人工。
    if (wasDone && ![prod.plain, prod.danmuMp4, prod.livechatMp4].some((f) => existsSync(f))) {
      jlog(`续跑:job 已 done 且 stage 分P产物已清理 → 只补收尾清理(不重跑上传)`);
      return await finalizeOnly(streamKey, bv, deps, jlog, notify, members, stageSub);
    }
    jlog(`续跑失败:stage 产物缺失(可能已清理),转人工。need=${JSON.stringify(need)}`);
    ledger.setState(streamKey, "needs_manual", { error: `续跑失败:bv=${bv} 但 stage 产物缺失,请人工补 append` }, { force: wasDone });
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
      ledger.setState(streamKey, "needs_manual", { error: `续跑遇多段组 ${g.step}(${files.length} 段),无法安全续传,请人工核对分 P` }, { force: wasDone });
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
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}`, streamKey });

  // 上传成功 → 与主路径同一收口(issue #92:按配置清理 + 延迟旁路校验)。
  // 续跑此前漏了 sourceAfterDone,是节点源残留的来源之一,这里一并补上。
  const rmStageFn = deps.rmStage ?? defaultRmStage;
  const cleanupSources = async (): Promise<CleanupOutcome> =>
    cleanupSourcesShared({
      streamKey, ledger, transports: deps.transports, members,
      cleanup: cfg.cleanup,
      stagePulledSources: members.flatMap((m) => m.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)))),
      rmStage: rmStageFn, log: jlog,
    });
  await finalizeAfterUpload({
    streamKey, bv, deps, log: jlog, notify, cleanupSources,
    on: { plain: true, danmu: burnDanmu, livechat: burnLivechat },
  });

  // 可选:done 后删 stage 产物(与主路径同一开关;续跑不删 slave 源)。
  if (cfg.cleanup?.stageAfterDone) {
    const products = [...new Set([
      ...videoOnly([prod.plain, prod.danmuMp4, prod.livechatMp4]),
      ...stageVideoLeftovers(stageSub),
    ])];
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
