import path from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import { isAppendAmbiguous, isJobAbort, isUploadRateLimited, resolveOutputStem, runWithJob, throwIfAborted, USER_STOP, type NotifyEvent, type ScopedLogger } from "@drec/core";
import type { UploadOpts } from "@drec/core";
import { selectWinner } from "./select.js";
import { retry } from "./retry.js";
import { humanBytes, sumBytes } from "./format.js";
import { buildWorkflow, deriveStageProducts, runWorkflowNodes, ResourcePool, type StageProducts, type WorkflowNodeKey } from "./workflow.js";
import { deriveSegmentPlan, segmentStem, type SegmentPlan } from "./session-plan.js";
import { planSegmentGroups } from "@drec/post-process";

/** 每任务可配的流水线步骤(默认全开;false 则跳过该产出)。 */
export interface PipelineSteps {
  mergeSegments?: boolean; // 默认 true:各分段合成一片;false = 不合并,按录制分段逐段产出/上传
  burnDanmu?: boolean;     // 默认 true:烧飞屏弹幕版(分段模式下 = 逐段烧)
  burnLivechat?: boolean;  // 默认 true:烧聊天框版(分段模式下 = 逐段烧)
}

/**
 * cleanup 开关(都默认 false)。**永不删 .xml/.ass**(弹幕源不可删硬约束)——
 * 所有清理路径只处理 .ts/.mp4,写入前再经 videoOnly() 兜底过滤。
 */
export interface PipelineCleanup {
  stageSourceAfterMerge?: boolean; // 合并后删 stage 里拉来的源 .ts(留合成产物)
  sourceAfterDone?: boolean;       // job 安全完成后删各成员节点原录制 .ts
  stageAfterDone?: boolean;        // job done(已上传)后删 stage 合成产物
}

/** 清理路径兜底:任何情况下都不把 .xml/.ass 交给删除通道(硬约束,见 AGENTS.md)。 */
const videoOnly = (paths: string[]): string[] => paths.filter((p) => !/\.(xml|ass)$/i.test(p));

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
  uploadMeta: { tag: string; tid: number; desc?: string; titleTemplate?: string };
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
   * 分段上传:把连续段按目标时长聚组成"分 P"的秒数(缺省 0 = 不合并,逐段上传)。
   * >0 时,累计时长接近该值(最多超 20%)的连续段合并成一个 mp4 再上传 —— 用于抵消
   * mesio `--fix` 把一场切成长短不一的碎段(否则分 P 爆炸且都短于录制设置的分段时长)。
   * 典型:设成录制时的 `--segment`(如 3600)。
   */
  segmentGroupSec?: number;
  /** reconciler 硬过滤用:非空 → 只处理这些 worker 的录像;缺省/空 = 全部(向后兼容)。pipeline 本身不读。 */
  workers?: string[];
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

/** streamKey(例 "douyin:767116735823:2026-06-27") → 安全目录名：替换 : / 为 _ */
function sanitizeKey(key: string): string {
  return key.replace(/[:/]/g, "_");
}

const defaultSplitForUpload = (mp4: string): Promise<string[]> =>
  import("@drec/post-process").then((m) => m.splitToSizeLimit(mp4));

const defaultRemuxSegment = (src: string, out: string): Promise<void> =>
  import("@drec/post-process").then((m) => m.remuxSegment(src, out));

const defaultSegmentDuration = (src: string): Promise<number> =>
  import("@drec/post-process").then((m) => m.ffprobeDuration(src));

/** 默认组内合并:与合并路径同款(逐段 mpegts 规范化 + concat -c copy),顺带把时基修正为 90000。 */
const defaultMergeSegments = (inputs: string[], outMp4: string): Promise<void> =>
  import("@drec/post-process").then((m) => m.mergeSession(inputs, outMp4));

/** 默认单段烧录:读该会话 xml → 按段窗口切 ASS(时间重定基) → burn。窗口内无弹幕则跳过(不产出)。 */
async function defaultBurnSegment(o: {
  plain: string;
  xmlPath: string;
  window: { startSec: number; endSec: number };
  style: "danmu" | "livechat";
  out: string;
}): Promise<void> {
  const { readFileSync } = await import("node:fs");
  const { renderXmlWindowToAss, burn, FONTS_DIR, ffprobeVideo } = await import("@drec/post-process");
  const xml = readFileSync(o.xmlPath, "utf-8");
  let dim: { width?: number; height?: number } = {};
  try { const v = await ffprobeVideo(o.plain); if (v.width > 0) dim = { width: v.width, height: v.height }; } catch { /* 无维度 → 用默认 */ }
  const { ass } = renderXmlWindowToAss(xml, o.style, o.window, { giftValueFilter: 0.9, ...dim });
  if (!ass) return; // 窗口内无弹幕 → 不产出(调用方按文件存在与否回落 plain 段)
  await burn({ inputMp4: o.plain, assText: ass, outMp4: o.out, fontsDir: FONTS_DIR, hwaccel: "auto" });
}

async function defaultRmStage(paths: string[]): Promise<void> {
  const { rmSync } = await import("node:fs");
  for (const p of paths) {
    try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
  }
}

/**
 * 经**全局上传队列**执行一次上传/append 提交。队列 = master 进程内共享(ResourcePool),
 * 串行 + 相邻提交最小间隔(uploadMinGapMs)→ 多任务同时收播时排队,且不会瞬时打爆 B 站频率限制。
 * 无 pool(测试/兼容)则直连。
 */
function runUpload<T>(deps: PipelineDeps, fn: () => Promise<T>): Promise<T> {
  return deps.pool ? deps.pool.withUpload(fn) : fn();
}

/** 分段上传的一个"分 P"产物(单段直接 remux 或若干段合并成组)。 */
interface SegmentUploadPart {
  index: number;
  /** 待上传的 plain mp4(单段 = 该段 remux;组 = 合并产物)。 */
  plain: string;
  /** 该分 P 对应的弹幕窗口(组内各段窗口的并集);无 xml 则 null。 */
  window: { startSec: number; endSec: number; xmlPath: string } | null;
  /** 构成该分 P 的逐段 plain(清理时用)。 */
  memberPlains: string[];
  danmu?: string;
  livechat?: string;
}

/** 组内各段的弹幕窗口并集([min start, max end)),xml 取组内首个有 xml 的段。 */
function spanWindow(members: Array<{ window: { startSec: number; endSec: number } | null; xmlPath: string }>): { startSec: number; endSec: number; xmlPath: string } | null {
  const withWin = members.filter((m) => m.window && m.xmlPath);
  if (withWin.length === 0) return null;
  const startSec = Math.min(...withWin.map((m) => m.window!.startSec));
  const endSec = Math.max(...withWin.map((m) => m.window!.endSec));
  const xmlPath = withWin[0].xmlPath;
  return { startSec, endSec, xmlPath };
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
    : makeJobLog(path.join(deps.cfg.stageDir, sanitizeKey(b.streamKey)));
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
  const stageSub = path.join(cfg.stageDir, sanitizeKey(streamKey));

  // 续跑:job 已有 bv ⇒ P1 已建稿(不可逆),绝不重传。跳过 select/pull/merge/burn/uploadPlain,只补 append。
  const existing = ledger.get(streamKey);
  // 分段模式(bv 已存在)有自己的续跑(含 plain 段 checkpoint),不要走合并路径的 resumeAppends。
  if (cfg.uploadMode === "upload" && existing?.bv && cfg.steps?.mergeSegments !== false) {
    return await resumeAppends(streamKey, existing.bv, stageSub, deps, jlog);
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
    const ok = tp?.exists ? await tp.exists(m.rec.tsFiles).catch(() => false) : true;
    if (ok) presentMembers.push(m);
    else {
      console.warn(`[pipeline] ${streamKey} 剔除成员 ${m.workerId}:文件已不存在`);
      jlog(`剔除成员 ${m.workerId}:文件已不存在`);
    }
  }
  const candidates = { ...b, members: presentMembers };

  // Select the best recording across all (present) nodes
  ledger.logStep(streamKey, "select", "start");
  const selection = selectWinner(candidates, cfg.cleanMaxGapSec);
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
    existingStem,
  });
  ledger.setOutputStem(streamKey, dateName);
  jlog(`产物 stem / 标题: ${dateName}`);

  // 分段上传模式:不合并,逐段 remux(+逐段烧录)→ 逐段上传。走独立分支,与合并路径互斥。
  if (cfg.steps?.mergeSegments === false) {
    return await runSegmentPipeline({ streamKey, deps, jlog, stageSub, winnerMembers, allMembers: candidates.members, dateName });
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
    sessionBase: winner.rec.sessionBase,
    sessionBases: winnerMembers.map((m) => m.rec.sessionBase),
    plain, danmuMp4, livechatMp4, plainXml, xmlArg,
  };

  // 各成员节点的待删源:只删 .ts(弹幕源 .xml 永不删)——给 sourceAfterDone 用。
  const sourcePathsOf = (m: (typeof winnerMembers)[number]): string[] => videoOnly(m.rec.tsFiles);
  const cleanupSources = async (): Promise<void> => {
    if (!clean.sourceAfterDone) return;
    ledger.logStep(streamKey, "clean_source", "start");
    let fileCount = 0;
    for (const m of candidates.members) {
      const paths = sourcePathsOf(m);
      fileCount += paths.length;
      await transports.get(m.workerId)?.cleanup?.(paths).catch(() => {});
    }
    ledger.logStep(streamKey, "clean_source", "done", `删 ${candidates.members.length} 节点 · ${fileCount} 文件`);
  };

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

  // stageSourceAfterMerge:合并/烧录完成后删 stage 里拉来的源 .ts(留合成产物),尽早释放磁盘。
  // 放在 stage/upload 分支之前:stage 模式同样享受(旧测试断言),只是不动各成员节点原始源。
  if (clean.stageSourceAfterMerge) {
    const pulledTs = winnerMembers.flatMap((m) => m.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f))));
    ledger.logStep(streamKey, "clean_stage_src", "start");
    await rmStage(videoOnly(pulledTs));
    ledger.logStep(streamKey, "clean_stage_src", "done", `删 ${pulledTs.length} 文件(不含 .xml/.ass)`);
  }

  const bv = ledger.get(streamKey)?.bv;
  if (cfg.uploadMode !== "upload") {
    jlog(`stage 模式:合成完毕待人工上传`);
    ledger.setState(streamKey, "needs_manual");
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
  await cleanupSources();
  if (clean.stageAfterDone) {
    ledger.logStep(streamKey, "clean_stage", "start");
    // 只删合成视频产物;.xml/.ass 永不删(弹幕源硬约束)。
    const present = videoOnly([plain, danmuMp4, livechatMp4]).filter(Boolean).filter(existsSync);
    await rmStage(present);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${present.length} 文件`);
  }
  return { state: "done", bv };
}

/**
 * 分段产出流水线(steps.mergeSegments=false):**不合并**。
 *
 * 逐段 remux(ts/flv → mp4,无损,不拼接) → 可选逐段烧录(用该段在整场 xml 时间轴上的窗口)
 * → 上传:全部 plain 段**一次多文件 upload** 建稿(P1..Pn 顺序 = 段序),再逐组 append
 * danmu / livechat 各段(组内多段一次 append,顺序 = 段序)。
 *
 * 幂等/续跑:与合并路径共用 sync_node_states(stage=merge 记 remux,burn_* / upload_plain / append_*)。
 * `merge` 节点 = 「逐段 remux 产出 plain 段」,upload_plain = 「多文件建稿」,append_* = 「追各段组」。
 * 续跑:已建稿(bv 存在)→ 只补 append;plain 段已在 stage → remux 跳过重做。
 */
async function runSegmentPipeline(o: {
  streamKey: string;
  deps: PipelineDeps;
  jlog: (msg: string) => void;
  stageSub: string;
  winnerMembers: Broadcast["members"];
  allMembers: Broadcast["members"];
  dateName: string;
}): Promise<{ state: JobState; bv?: string }> {
  const { streamKey, deps, jlog, stageSub, winnerMembers, allMembers, dateName } = o;
  const { ledger, notify, cfg } = deps;
  const burnDanmu = cfg.steps?.burnDanmu !== false;
  const burnLivechat = cfg.steps?.burnLivechat !== false;
  const isPublic = cfg.uploadPrivate === false;
  const clean = cfg.cleanup ?? {};
  const rmStage = deps.rmStage ?? defaultRmStage;
  const splitForUpload = deps.splitForUpload ?? defaultSplitForUpload;
  // 逐段 sh:命令行 + 耗时 + 输出摘尾进 job.log(与合并路径一致)。
  const sh = async (cmd: string): Promise<void> => {
    jlog(`$ ${cmd}`);
    const t0 = Date.now();
    const out = await deps.sh(cmd);
    jlog(`  ✓ 完成(${Math.round((Date.now() - t0) / 1000)}s)`);
    if (typeof out === "string" && out.trim()) jlog(`  输出尾: ${out.trim().slice(-2048)}`);
  };

  // 续跑:已建稿(bv 已落库)→ 只补没做完的 append,绝不重传 plain 组(会重复建稿)。
  const existing = ledger.get(streamKey);

  // 该场各段的 remux 输入(按会话序 → 段序,已由 winnerMembers.tsFiles 保证)。
  const srcSegments = winnerMembers.flatMap((m) => m.rec.tsFiles);
  if (srcSegments.length === 0) {
    jlog(`分段模式:无可用分段`);
    ledger.markFailed(streamKey, "无可用分段");
    return { state: "failed" };
  }
  // 先按碎片阈值算出**本次允许的段号白名单**(原始段序)——主路径与续跑共用,
  // 确保续跑不会把 stage 里残留的碎片 seg mp4 也当成分段上传(踩过坑)。
  const probeDurationScan = deps.segmentDuration ?? defaultSegmentDuration;
  const minSegSecScan = cfg.minSegmentSec ?? 2;
  const allowedIndices = new Set<number>();
  {
    let off = 0;
    for (let i = 0; i < srcSegments.length; i++) {
      const localSrc = path.join(stageSub, path.basename(srcSegments[i]));
      let d = 0;
      try { d = await probeDurationScan(localSrc); } catch { d = 0; }
      off += d;
      if (minSegSecScan > 0 && d > 0 && d < minSegSecScan) continue; // 碎片:不进白名单
      allowedIndices.add(i);
    }
  }

  // ── 逐段 remux(merge 节点语义)──
  ledger.setState(streamKey, "merging");
  ledger.logStep(streamKey, "merge", "start");
  ledger.syncNodeState(streamKey, "merge", "running");
  const parts: SegmentPlan["parts"] = [];
  const xmlCache = new Map<string, string>();
  // 每个会话内累计时长 = 该会话后续段的窗口起点(与合并路径的弹幕偏移口径一致)。
  let globalOffset = 0;
  const remux = deps.remuxSegment ?? defaultRemuxSegment;
  const probeDuration = deps.segmentDuration ?? defaultSegmentDuration;
  const minSegSec = cfg.minSegmentSec ?? 2;
  let skippedFragments = 0;
  for (let i = 0; i < srcSegments.length; i++) {
    throwIfAborted();
    const remoteSrc = srcSegments[i];
    // pull 后源在 stage 内同名;remux 读本地副本(remote 路径只在 pull 时用过)。
    const localSrc = path.join(stageSub, path.basename(remoteSrc));
    let durSec = 0;
    try { durSec = await probeDuration(localSrc); } catch { durSec = 0; }
    // 段窗口(相对整场):从 globalOffset 起 durSec 秒。源缺失时长按 0 计(弹幕可能漂移,但不静默)。
    const startSec = globalOffset;
    globalOffset += durSec;
    // 碎片过滤:mesio `--fix` 切出的 0.2s 级初始化残片(分辨率不同、无有效内容)→ 不产出。
    // 仍累加 globalOffset(时长约 0),保证后续段的弹幕窗口对齐。
    if (minSegSec > 0 && durSec > 0 && durSec < minSegSec) {
      skippedFragments++;
      jlog(`跳过碎片段 ${i}: ${path.basename(localSrc)}(${durSec.toFixed(2)}s < ${minSegSec}s)`);
      continue;
    }
    // 文件名用**有效段序**(碎片跳过后的连续序号):mesio 碎片很多时避免文件名出现大量空洞,
    // 也让"近似分段时长合并"后的产物集合稳定。分 P 顺序仍由 parts 数组顺序保证。
    const stem = segmentStem(dateName, parts.length);
    const plain = path.join(stageSub, stem + ".mp4");
    if (!existsSync(plain)) {
      jlog(`remux 段 ${i}: ${path.basename(localSrc)} → ${path.basename(plain)}`);
      await remux(localSrc, plain);
    } else {
      jlog(`remux 段 ${i}: 已存在,跳过 ${path.basename(plain)}`);
    }
    // 该段所属会话的 xml(stage 内同名);按会话缓存内容,避免重复读。
    const sessionXml = winnerMembers.find((m) => m.rec.tsFiles.includes(remoteSrc))?.rec.xmlPath;
    const xmlStage = sessionXml ? path.join(stageSub, path.basename(sessionXml)) : "";
    let xmlText = "";
    if (xmlStage && existsSync(xmlStage)) {
      xmlText = xmlCache.get(xmlStage) ?? "";
      if (!xmlText) { const { readFileSync } = await import("node:fs"); xmlText = readFileSync(xmlStage, "utf-8"); xmlCache.set(xmlStage, xmlText); }
    }
    parts.push({
      index: parts.length, src: localSrc, plain, srcSegIndex: i, durSec,
      xmlPath: xmlText ? xmlStage : "",
      window: xmlText ? { startSec, endSec: startSec + durSec } : null,
      danmu: "", livechat: "",
    });
  }

  // ── 近似分段时长合并:把逐段 remux 的 plain 按目标时长聚组成"分 P"──
  // mesio 的 split operator 把一场切成 11+ 个长短不一的段(还有一堆 0.2s 碎片);
  // 逐段上传会产生十几个分 P,且都短于录制时设置的 segmentSec。这里按 segmentSec 把
  // 连续段合并成接近目标时长的组 → 每组 = 一个分 P(与合并路径的产出形态一致)。
  const groupTargetSec = cfg.segmentGroupSec ?? 0; // <=0 = 不合并(逐段上传)
  const planGroups = groupTargetSec > 0
    ? planSegmentGroups(parts.map((p) => p.durSec ?? 0), groupTargetSec)
    : parts.map((_, i) => [i]);
  const mergeGroup = deps.mergeSegments ?? defaultMergeSegments;
  const uploadParts: SegmentUploadPart[] = [];
  for (let gi = 0; gi < planGroups.length; gi++) {
    const memberIdxs = planGroups[gi];
    const members = memberIdxs.map((k) => parts[k]);
    if (groupTargetSec <= 0 || members.length === 1) {
      // 不合并 / 单段组:直接就是该段产物
      uploadParts.push({ index: gi, plain: members[0].plain, window: spanWindow(members), memberPlains: [members[0].plain] });
      continue;
    }
    // 组产物用独立 `_g{N}` 命名,绝不能与成员段同名 —— 否则 existsSync 命中第一个成员段,
    // 产物名 = {dateName}_{NNN}.mp4,与 hub 名称约定一致(段号补零 3 位)。
    // 不能用 segmentStem(dateName, members[0].index)(会与逐段 remux 的 seg 文件冲突 → existsSync 命中成员段跳过合并)。
    const merged = path.join(stageSub, `${dateName}_${String(gi).padStart(3, "0")}.mp4`);
    if (!existsSync(merged)) {
      jlog(`合并组 ${gi}: ${members.length} 段(≈${Math.round(members.reduce((n, m) => n + (m.durSec ?? 0), 0))}s)→ ${path.basename(merged)}`);
      await mergeGroup(members.map((m) => m.plain), merged);
    } else {
      jlog(`合并组 ${gi}: 已存在,跳过 ${path.basename(merged)}`);
    }
    uploadParts.push({ index: gi, plain: merged, window: spanWindow(members), memberPlains: members.map((m) => m.plain) });
  }
  jlog(`产出: ${parts.length} 有效段 → ${uploadParts.length} 个分 P(目标 ${groupTargetSec || "未设"}s)`);
  ledger.logStep(streamKey, "merge", "done", `${parts.length} 段 → ${uploadParts.length} 个分 P${skippedFragments ? `(跳过 ${skippedFragments} 碎片)` : ""}`);
  ledger.syncNodeState(streamKey, "merge", "done", { error: null });

  // 续跑:已建稿(bv 已落库)→ 只补没做完的 append(plain 剩余段 / danmu / livechat)。
  if (cfg.uploadMode === "upload" && existing?.bv) {
    return await resumeSegmentAppends(streamKey, existing.bv, uploadParts, deps, jlog, burnDanmu, burnLivechat, isPublic, splitForUpload);
  }

  // ── 逐段烧录(burn_danmu / burn_livechat 节点语义)──
  const burnOne = deps.burnSegment ?? defaultBurnSegment;
  const burnAll = async (style: "danmu" | "livechat", node: "burn_danmu" | "burn_livechat"): Promise<void> => {
    const on = style === "danmu" ? burnDanmu : burnLivechat;
    if (!on) { ledger.syncNodeState(streamKey, node, "skipped"); return; }
    ledger.logStep(streamKey, node, "start");
    ledger.syncNodeState(streamKey, node, "running");
    let burned = 0;
    for (const p of uploadParts) {
      throwIfAborted();
      const out = p.plain.replace(/\.mp4$/i, style === "danmu" ? "_danmu.mp4" : "_livechat.mp4");
      // 无弹幕窗口 → 该组无弹幕可烧,回落 plain(不产出 *_danmu.mp4)。
      if (!p.window) { jlog(`${node} 组 ${p.index}: 无弹幕,跳过`); continue; }
      if (!existsSync(out)) {
        jlog(`${node} 组 ${p.index}: ${path.basename(p.plain)} → ${path.basename(out)}`);
        // 默认实现内部:窗口内无弹幕 → 不产出文件(回落 plain 段)。烧完按存在与否记产物。
        await burnOne({ plain: p.plain, xmlPath: p.window.xmlPath, window: p.window, style, out });
      } else {
        jlog(`${node} 组 ${p.index}: 已存在,跳过 ${path.basename(out)}`);
      }
      if (existsSync(out)) {
        if (style === "danmu") p.danmu = out; else p.livechat = out;
        burned++;
      } else {
        jlog(`${node} 组 ${p.index}: 窗口内无弹幕,跳过`);
      }
    }
    ledger.logStep(streamKey, node, "done", `${burned}/${uploadParts.length} 组`);
    ledger.syncNodeState(streamKey, node, "done", { error: null });
  };
  await burnAll("danmu", "burn_danmu");
  await burnAll("livechat", "burn_livechat");

  // ── stage 模式:逐段产物落盘待人工,不建稿 ──
  if (cfg.uploadMode !== "upload") {
    jlog(`分段 stage 模式:${uploadParts.length} 个分 P 已合成待人工上传`);
    ledger.setState(streamKey, "needs_manual");
    notify({ kind: "stageReady", streamKey });
    return { state: "needs_manual" };
  }

  // ── 上传:全部 plain 段一次多文件 upload 建稿(P1..Pn 顺序 = 段序)──
  ledger.setState(streamKey, "uploading");
  ledger.logStep(streamKey, "upload_plain", "start");
  ledger.syncNodeState(streamKey, "upload_plain", "running");
  const plainFiles = uploadParts.map((p) => p.plain).filter(existsSync);
  if (plainFiles.length === 0) {
    jlog(`分段上传:无 plain 段产物`);
    ledger.syncNodeState(streamKey, "upload_plain", "failed", { error: "无 plain 段产物" });
    ledger.markFailed(streamKey, "分段上传:无 plain 段产物");
    notify({ kind: "error", stage: "上传", message: `${streamKey} 分段上传无 plain 段产物` });
    return { state: "failed" };
  }
  // 提交频率硬上限:一次 `biliup upload` 提交太多文件会触发 B 站 601(上传过快)。
  // 故 P1 单文件建稿拿 BV → 其余 plain 段分批 append(每批 ≤uploadBatchSize,批间走全局上传队列的间隔)。
  const batchSize = Math.max(1, cfg.uploadBatchSize ?? 1);
  const plainOpts = {
    cookies: cfg.cookies, tag: cfg.uploadMeta.tag, tid: cfg.uploadMeta.tid,
    public: isPublic, desc: cfg.uploadMeta.desc,
  };
  // 分 P checkpoint:每个已成功提交的段都落库(组名 "plain"),续跑据此精确跳过 → 不漏段、不重复。
  const donePlain = ledger.doneParts(streamKey, "plain");
  let bv = "";
  let p1Done = donePlain.has(0) || ledger.get(streamKey)?.bv != null;
  if (!p1Done) {
    jlog(`建稿 P1: ${path.basename(plainFiles[0])}(${plainFiles.length} 个 plain 段待传)`);
    // P1 建稿:可用 `uploadPlain` 建稿接缝(有线路换线),也可注入 `uploadPlainRaw`(测试用)。
    // 601 频率限制 → 重试(队列会先冷却);其余错误不重试(避免重复建稿)。
    bv = await retry(
      () => runUpload(deps, () => deps.uploadPlainRaw
        ? deps.uploadPlainRaw({ ...plainOpts, video: plainFiles[0], title: dateName })
        : deps.uploadPlain({ ...plainOpts, video: plainFiles[0], title: dateName })),
      { tries: 3, backoffMs: 60_000, sleep: deps.sleep, shouldRetry: (e) => isUploadRateLimited(e) },
    );
    ledger.setBv(streamKey, bv); // 建稿成功即刻落库(与合并路径同一幂等边界)
    ledger.markPartDone(streamKey, "plain", 0); // P1 = 第 0 段
    jlog(`建稿完成: ${bv}`);
  } else {
    bv = ledger.get(streamKey)?.bv ?? "";
    jlog(`建稿 P1 已存在,跳过(bv=${bv})`);
  }
  if (!bv) {
    jlog(`分段上传:已标 P1 完成但 bv 为空,转人工`);
    ledger.setState(streamKey, "needs_manual", { error: "分段上传:P1 已完成但 bv 为空" });
    return { state: "needs_manual" };
  }
  // 其余 plain 段逐个 append(顺序 = 段序)。每个成功即 checkpoint;601 由队列冷却 + retry 吸收。
  for (let i = 1; i < plainFiles.length; i += batchSize) {
    const batch: string[] = [];
    const idxs: number[] = [];
    for (let j = i; j < Math.min(i + batchSize, plainFiles.length); j++) {
      if (donePlain.has(j)) continue; // 续跑:已提交的段跳过
      batch.push(plainFiles[j]); idxs.push(j);
    }
    if (batch.length === 0) continue;
    jlog(`append plain 段 ${idxs.join(",")}: ${batch.length} 文件`);
    const tries = batch.length === 1 ? 5 : 1;
    await retry(
      () => runUpload(deps, () => deps.appendGroup({ ...plainOpts, bv, files: batch })),
      { tries, backoffMs: 60_000, sleep: deps.sleep, shouldRetry: (e) => isUploadRateLimited(e) || (batch.length === 1 && !isAppendAmbiguous(e)) },
    );
    for (const k of idxs) ledger.markPartDone(streamKey, "plain", k);
  }
  ledger.logStep(streamKey, "upload_plain", "done", `P1 + ${plainFiles.length - 1} 段`);
  ledger.syncNodeState(streamKey, "upload_plain", "done", { error: null });

  // ── 逐组 append:danmu 各段一组、livechat 各段一组(组内多段一次 append,顺序 = 段序)──
  await appendSegmentGroup(streamKey, bv, "append_danmu", uploadParts.map((p) => p.danmu).filter((f): f is string => !!f && existsSync(f)), burnDanmu, deps, jlog, isPublic, splitForUpload);
  await appendSegmentGroup(streamKey, bv, "append_livechat", uploadParts.map((p) => p.livechat).filter((f): f is string => !!f && existsSync(f)), burnLivechat, deps, jlog, isPublic, splitForUpload);

  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });

  // 可选清理:各成员节点原录制 .ts(永不删 .xml/.ass)。
  if (clean.sourceAfterDone) {
    ledger.logStep(streamKey, "clean_source", "start");
    let fileCount = 0;
    for (const m of allMembers) {
      const paths = videoOnly(m.rec.tsFiles);
      fileCount += paths.length;
      await deps.transports.get(m.workerId)?.cleanup?.(paths).catch(() => {});
    }
    ledger.logStep(streamKey, "clean_source", "done", `删 ${allMembers.length} 节点 · ${fileCount} 文件`);
  }
  // 可选清理:stage 里拉来的源 .ts + 产物(永不删 .xml/.ass)。
  if (clean.stageSourceAfterMerge) {
    ledger.logStep(streamKey, "clean_stage_src", "start");
    await rmStage(videoOnly(srcSegments.map((f) => path.join(stageSub, path.basename(f)))));
    ledger.logStep(streamKey, "clean_stage_src", "done", `删 ${srcSegments.length} 文件(不含 .xml/.ass)`);
  }
  if (clean.stageAfterDone) {
    // 组产物(合并 mp4 / 烧录 mp4)+ 组成员的逐段 plain(若合并成组则逐段 plain 可一并清)。
    const products = videoOnly([
      ...uploadParts.flatMap((p) => [p.plain, p.danmu, p.livechat].filter(Boolean) as string[]),
      ...(groupTargetSec > 0 ? uploadParts.flatMap((p) => p.memberPlains) : []),
    ]).filter(existsSync);
    ledger.logStep(streamKey, "clean_stage", "start");
    await rmStage(products);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length} 文件`);
  }
  return { state: "done", bv };
}

/** 分段 append 一个逻辑组(danmu 或 livechat 的全部段)。组内多段 = 一次 append(顺序 = 段序)。 */
async function appendSegmentGroup(
  streamKey: string,
  bv: string,
  step: "append_danmu" | "append_livechat",
  files: string[],
  on: boolean,
  deps: PipelineDeps,
  jlog: (msg: string) => void,
  isPublic: boolean,
  splitForUpload: (mp4: string) => Promise<string[]>,
): Promise<void> {
  const { ledger } = deps;
  if (!on) { ledger.syncNodeState(streamKey, step, "skipped"); return; }
  if (ledger.isStepDone(streamKey, step)) { jlog(`append 跳过(已完成): ${step}`); return; }
  if (files.length === 0) {
    jlog(`${step}: 无产物段,跳过`);
    ledger.syncNodeState(streamKey, step, "skipped");
    return;
  }
  // 每个产物段再按 16GB 上限切(罕见),展平成最终 append 文件列表(顺序保持)。
  const finalFiles: string[] = [];
  for (const f of files) finalFiles.push(...await splitForUpload(f));
  ledger.logStep(streamKey, step, "start");
  ledger.syncNodeState(streamKey, step, "running");
  // 分批 append(每批 ≤uploadBatchSize):每次提交走全局上传队列(限速 + 601 冷却)。
  // 每组按段号落 checkpoint(sync_parts),续跑精确跳过 → 不漏段、不重复分 P。
  const batchSize = Math.max(1, deps.cfg.uploadBatchSize ?? 1);
  const doneParts = ledger.doneParts(streamKey, step);
  let batches = 0;
  for (let i = 0; i < finalFiles.length; i += batchSize) {
    const batch: string[] = []; const idxs: number[] = [];
    for (let j = i; j < Math.min(i + batchSize, finalFiles.length); j++) {
      if (doneParts.has(j)) continue;
      batch.push(finalFiles[j]); idxs.push(j);
    }
    if (batch.length === 0) continue;
    batches++;
    jlog(`append ${step} 批 ${batches}: ${batch.length} 文件(段 ${idxs.join(",")})`);
    // 单文件批(默认)→ 601 可安全重试(最多 5 次,每次重新排队 = 走冷却);多文件批不重试(可能已部分提交)。
    const tries = batch.length === 1 ? 5 : 1;
    // retry 包在 runUpload 外:每次重试都重新获取上传配额(命中 601 后队列已记冷却)。
    await retry(
      () => runUpload(deps, () => deps.appendGroup({ bv, files: batch, cookies: deps.cfg.cookies, public: isPublic })),
      {
        tries,
        backoffMs: 60_000,
        sleep: deps.sleep,
        shouldRetry: (err) => isUploadRateLimited(err) || !isAppendAmbiguous(err),
        onRetry: (attempt, err) => jlog(`append ${step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
      },
    );
    for (const k of idxs) ledger.markPartDone(streamKey, step, k);
  }
  ledger.logStep(streamKey, step, "done", `${finalFiles.length} 文件 · ${batches} 批`);
  ledger.syncNodeState(streamKey, step, "done", { error: null });
  jlog(`append ${step} 完成(${finalFiles.length} 文件,${batches} 批)`);
}

/** 分段模式续跑:已建稿 → 只补没做完的 append(plain 剩余分 P / danmu / livechat)。 */
async function resumeSegmentAppends(
  streamKey: string,
  bv: string,
  uploadParts: SegmentUploadPart[],
  deps: PipelineDeps,
  jlog: (msg: string) => void,
  burnDanmu: boolean,
  burnLivechat: boolean,
  isPublic: boolean,
  splitForUpload: (mp4: string) => Promise<string[]>,
): Promise<{ state: JobState; bv?: string }> {
  const { ledger, notify, cfg } = deps;
  jlog(`分段续跑:已建稿 bv=${bv},只补 append`);
  if (uploadParts.length === 0) {
    jlog(`分段续跑失败:无可上传分 P`);
    ledger.setState(streamKey, "needs_manual", { error: `分段续跑失败:bv=${bv} 但无可上传分 P` });
    notify({ kind: "error", stage: "上传", message: `分段续跑失败:${bv} 产物缺失,请人工核对分 P` });
    return { state: "needs_manual", bv };
  }
  // 先补 plain:已建稿但其余分 P 可能还没传完(上次在 append plain 中途失败)。
  const plainFiles = uploadParts.map((p) => p.plain).filter((f) => f && existsSync(f));
  const donePlain = ledger.doneParts(streamKey, "plain");
  const batchSize = Math.max(1, cfg.uploadBatchSize ?? 1);
  for (let i = 0; i < plainFiles.length; i += batchSize) {
    const batch: string[] = []; const idxs: number[] = [];
    for (let j = i; j < Math.min(i + batchSize, plainFiles.length); j++) {
      if (donePlain.has(j)) continue;
      batch.push(plainFiles[j]); idxs.push(j);
    }
    if (batch.length === 0) continue;
    jlog(`续跑 append plain 分 P ${idxs.join(",")}`);
    await retry(
      () => runUpload(deps, () => deps.appendGroup({ bv, files: batch, cookies: cfg.cookies, public: isPublic })),
      { tries: batch.length === 1 ? 5 : 1, backoffMs: 60_000, sleep: deps.sleep, shouldRetry: (e) => isUploadRateLimited(e) || (batch.length === 1 && !isAppendAmbiguous(e)) },
    );
    for (const k of idxs) ledger.markPartDone(streamKey, "plain", k);
  }
  ledger.syncNodeState(streamKey, "upload_plain", "done", { error: null });
  const danmuFiles = uploadParts.map((p) => p.danmu).filter((f): f is string => !!f && existsSync(f));
  const livechatFiles = uploadParts.map((p) => p.livechat).filter((f): f is string => !!f && existsSync(f));
  await appendSegmentGroup(streamKey, bv, "append_danmu", danmuFiles, burnDanmu, deps, jlog, isPublic, splitForUpload);
  await appendSegmentGroup(streamKey, bv, "append_livechat", livechatFiles, burnLivechat, deps, jlog, isPublic, splitForUpload);
  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  if (cfg.cleanup?.stageAfterDone) {
    const rmStage = deps.rmStage ?? defaultRmStage;
    const products = videoOnly([
      ...uploadParts.flatMap((p) => [p.plain, p.danmu, p.livechat].filter(Boolean) as string[]),
      ...uploadParts.flatMap((p) => p.memberPlains),
    ]).filter(existsSync);
    await rmStage(products);
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
): Promise<{ state: JobState; bv?: string }> {
  const { ledger, appendGroup, notify, cfg } = deps;
  jlog(`续跑:已建稿 bv=${bv},跳过 select/pull/merge/burn/uploadPlain,只补 append(不做 sourceAfterDone 清理)`);
  const splitForUpload = deps.splitForUpload ?? defaultSplitForUpload;
  const burnDanmu = cfg.steps?.burnDanmu !== false;
  const burnLivechat = cfg.steps?.burnLivechat !== false;
  const isPublic = cfg.uploadPrivate === false;

  const prod = deriveStageProducts(stageSub);
  if (!prod) {
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
    await retry(() => appendGroup({ bv, files, cookies: cfg.cookies, public: isPublic }), {
      tries,
      backoffMs: 60_000,
      sleep: deps.sleep,
      onRetry: (attempt, err) => jlog(`续跑 append ${g.step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
    });
    ledger.logStep(streamKey, g.step, "done", `${files.length} 段`);
    jlog(`续跑 append 完成: ${g.step}`);
  }

  ledger.markDone(streamKey, bv);
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });

  // 可选:done 后删 stage 产物(与主路径同一开关;续跑不删 slave 源)。
  if (cfg.cleanup?.stageAfterDone) {
    const rmStage = deps.rmStage ?? defaultRmStage;
    const products = videoOnly([prod.plain, prod.danmuMp4, prod.livechatMp4]);
    ledger.logStep(streamKey, "clean_stage", "start");
    await rmStage(products);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length} 文件(不含 .xml/.ass)`);
  }
  return { state: "done", bv };
}
