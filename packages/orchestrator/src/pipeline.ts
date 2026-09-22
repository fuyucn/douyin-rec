import path from "node:path";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import { isJobAbort, resolveOutputStem, runWithJob, throwIfAborted, USER_STOP, type NotifyEvent, type ScopedLogger } from "@drec/core";
import type { UploadOpts, YoutubeUploadOpts } from "@drec/app";
import { selectWinner } from "./select.js";
import { retry } from "./retry.js";
import { humanBytes, sumBytes } from "./format.js";
import { buildWorkflow, deriveStageProducts, runWorkflowNodes, ResourcePool, type StageProducts, type WorkflowNodeKey } from "./workflow.js";

/** 每任务可配的流水线步骤(默认全开;false 则跳过该产出)。merge plain 是基础,总做。 */
export interface PipelineSteps {
  burnDanmu?: boolean;     // 默认 true:烧飞屏弹幕版
  burnLivechat?: boolean;  // 默认 true:烧聊天框版
}

/** cleanup 开关(都默认 false)。includeXmlAss 决定删除是否含 .xml/.ass(守"弹幕源不可删"硬规矩)。 */
export interface PipelineCleanup {
  stageSourceAfterMerge?: boolean; // 合并后删 stage 里拉来的源 .ts(留合成产物)
  sourceAfterDone?: boolean;       // job 安全完成后删各成员节点原录制 .ts
  stageAfterDone?: boolean;        // job done(已上传)后删 stage 合成产物
  includeXmlAss?: boolean;         // 上述删除是否含 .xml/.ass(默认 false)
}

export interface PipelineCfg {
  cleanMaxGapSec: number;
  /** 断流重连合并窗(ms):结束距现在不足该窗的场暂不处理;聚类容差同窗。缺省 reconciler 默认 10 分钟。 */
  reconnectWindowMs?: number;
  stageDir: string;
  cookies: string;
  /** stage = 只合成不传;upload = 按旧规则传 B站(无 destinations 时)。 */
  uploadMode: "stage" | "upload";
  /** 上传目的地;缺省由 uploadMode 推("upload"→["bilibili"];其它→[])。写了就以它为唯一真相。 */
  uploadDestinations?: readonly ("bilibili" | "youtube")[];
  /** 仅 upload 时有意义:true(默认)= 仅自己可见,false = 公开。 */
  uploadPrivate?: boolean;
  uploadMeta: { tag: string; tid: number; desc?: string; titleTemplate?: string };
  /** YouTube 目的地专属元数据;只在 destinations 含 youtube 时生效。 */
  youtubeMeta?: {
    privacy?: "private" | "unlisted" | "public";
    description?: string;
    tags?: string[];
    categoryId?: string;
    notifySubscribers?: boolean;
  };
  /** 渲染 {date}/{time} 回退用(sessionBase 解析不到时);缺省 Asia/Shanghai。 */
  timeZone?: string;
  steps?: PipelineSteps;
  cleanup?: PipelineCleanup;
  /** reconciler 硬过滤用:非空 → 只处理这些 worker 的录像;缺省/空 = 全部(向后兼容)。pipeline 本身不读。 */
  workers?: string[];
}

/** 由配置得出要跑哪些上传目的地(缺省保持旧行为:mode=upload → B站;mode=stage → 不传)。 */
export function resolveUploadDestinations(cfg: PipelineCfg): ReadonlySet<"bilibili" | "youtube"> {
  if (cfg.uploadDestinations) return new Set(cfg.uploadDestinations);
  return cfg.uploadMode === "upload" ? new Set(["bilibili"]) : new Set();
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
  /** 追加一个逻辑组到稿件(空组跳过)。多组**串行**调用(同稿件并发 append 会撞)。
   *  public 透传 → append 保留 P1 的水印关/可见性(防 append 重置)。 */
  appendGroup: (o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>;
  /** 上传 plain mp4 到 YouTube;destinations 含 youtube 时由 CLI 注入。测试可 mock。 */
  uploadYoutube?: (o: YoutubeUploadOpts) => Promise<{ videoId: string; url: string }>;
  /** 把单个烧录产物按 16GB 上限切成多段(默认 splitToSizeLimit);可注入测试。 */
  splitForUpload?: (mp4: string) => Promise<string[]>;
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

async function defaultRmStage(paths: string[]): Promise<void> {
  const { rmSync } = await import("node:fs");
  for (const p of paths) {
    try { rmSync(p, { force: true }); } catch { /* 忽略 */ }
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
  const destinations = resolveUploadDestinations(cfg);
  const bilibiliOn = destinations.has("bilibili");
  const youtubeOn = destinations.has("youtube");

  const existing = ledger.get(streamKey);
  // 续跑:job 已有 bv ⇒ P1 已建稿(不可逆),绝不重传。跳过 select/pull/merge/burn/uploadPlain,只补 append。
  if (bilibiliOn && existing?.bv) {
    return await resumeAppends(streamKey, existing.bv, stageSub, deps, jlog);
  }
  // YouTube-only 且有 ytId:YouTube 不可逆建稿已完成,直接收口 done(不再需要 rerun)。
  if (!bilibiliOn && youtubeOn && existing?.ytId) {
    jlog(`YouTube 已建稿 yt=${existing.ytId},收口 done`);
    ledger.markDone(streamKey, existing.bv ?? "", { ytId: existing.ytId });
    notify({ kind: "uploadDone", label: "YouTube", url: `https://youtu.be/${existing.ytId}` });
    return { state: "done" };
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

  // Merge and burn from the stageSub directory
  ledger.setState(streamKey, "merging");
  const earliest = winnerMembers.reduce((a, m) => (m.rec.startMs < a.rec.startMs ? m : a));
  const derived = deriveStageProducts(stageSub);
  const existingStem = (ledger.get(streamKey)?.outputStem ?? "").trim()
    || (derived && existsSync(derived.plain) ? derived.dateName : "");
  const dateName = resolveOutputStem({
    template: cfg.uploadMeta.titleTemplate,
    sessionBase: earliest.rec.sessionBase,
    startMs: earliest.rec.startMs || b.startMs,
    timeZone: cfg.timeZone,
    existingStem,
  });
  ledger.setOutputStem(streamKey, dateName);
  jlog(`产物 stem / 标题: ${dateName}`);
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

  // 各成员节点的待删源(.ts 总删;.xml 仅 includeXmlAss)——给 sourceAfterDone 用。
  const sourcePathsOf = (m: (typeof winnerMembers)[number]): string[] =>
    [...m.rec.tsFiles, ...(clean.includeXmlAss && m.rec.xmlPath ? [m.rec.xmlPath] : [])];
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
    willUpload: bilibiliOn,
    willUploadYoutube: youtubeOn,
    burnDanmu, burnLivechat,
    mergeSegments: winnerMembers.reduce((n, m) => n + m.rec.tsFiles.length, 0),
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
    const pulledXml = winnerMembers.flatMap((m) => (m.rec.xmlPath ? [path.join(stageSub, path.basename(m.rec.xmlPath))] : []));
    const xmlVictims = clean.includeXmlAss ? pulledXml : [];
    ledger.logStep(streamKey, "clean_stage_src", "start");
    await rmStage([...pulledTs, ...xmlVictims]);
    ledger.logStep(streamKey, "clean_stage_src", "done", `删 ${pulledTs.length + xmlVictims.length} 文件`);
  }

  const bv = ledger.get(streamKey)?.bv;
  const ytId = ledger.get(streamKey)?.ytId;
  if (destinations.size === 0) {
    jlog(`stage 模式:合成完毕待人工上传`);
    ledger.setState(streamKey, "needs_manual");
    await cleanupSources();
    notify({
      kind: "error",
      stage: "同步",
      message: `已合成完整版,待人工上传(stage)。覆盖度：${JSON.stringify(selection.perNode)}`,
    });
    return { state: "needs_manual" };
  }

  // upload 模式但 bv 为空 = P1 没真正传上去(例如 upload_plain 被旧 skipped 状态卡住)。
  // 绝不能假装 done/发 uploadDone,否则 UI 显示完成、B 站其实没有稿。
  if (bilibiliOn && !bv) {
    jlog(`upload 模式但 P1 未上传(bv 为空),转人工`);
    ledger.setState(streamKey, "needs_manual", { error: "upload 模式但 P1 未上传(bv 为空),请重跑或人工上传" });
    notify({ kind: "error", stage: "上传", message: `${streamKey} upload 模式但 P1 未上传(bv 为空),请人工处理` });
    return { state: "needs_manual" };
  }
  if (youtubeOn && !ytId) {
    jlog(`YouTube 上传未成功(ytId 为空),转人工`);
    ledger.setState(streamKey, "needs_manual", { error: "YouTube 上传未成功(ytId 为空),请重跑或人工上传" });
    notify({ kind: "error", stage: "上传", message: `${streamKey} YouTube 上传未成功,请人工处理` });
    return { state: "needs_manual" };
  }

  if (bv) jlog(`P1 上传完成: ${bv}`);
  if (ytId) jlog(`YouTube 上传完成: ${ytId}`);
  ledger.markDone(streamKey, bv ?? "", ytId ? { ytId } : {});
  if (bv) notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  if (ytId) notify({ kind: "uploadDone", label: "YouTube", url: `https://youtu.be/${ytId}` });
  await cleanupSources();
  if (clean.stageAfterDone) {
    ledger.logStep(streamKey, "clean_stage", "start");
    const victims = [plain, danmuMp4, livechatMp4];
    if (clean.includeXmlAss) {
      victims.push(plainXml, xmlArg, danmuMp4.replace(/\.mp4$/, ".ass"), livechatMp4.replace(/\.mp4$/, ".ass"));
    }
    const present = victims.filter(Boolean).filter(existsSync);
    await rmStage(present);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${present.length} 文件`);
  }
  return { state: "done", bv: bv ?? undefined };
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
  const destinations = resolveUploadDestinations(cfg);
  const youtubeOn = destinations.has("youtube");

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
      log: jlog, willUpload: true, willUploadYoutube: false, burnDanmu, burnLivechat, mergeSegments: 0,
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
  // 双平台续跑:B 站 P1 已成功(bv 已落库),YouTube 若随后失败,这里也要补跑 youtube_plain,
  // 否则会让「B 站有稿,YouTube 无录」被错误标 done。
  if (youtubeOn && !ledger.get(streamKey)?.ytId) {
    jlog(`续跑:补 YouTube 上传(upload_plain 已完成,只跑 youtube_plain)`);
    const workflow = buildWorkflow({
      streamKey, stageSub, products: prod, deps, cfg,
      log: jlog, willUpload: true, willUploadYoutube: true, burnDanmu, burnLivechat, mergeSegments: 0,
    });
    const r = await runWorkflowNodes({
      streamKey,
      nodes: workflow.nodes.filter((n) => n.key === "youtube_plain"),
      edges: [],
      ctx: workflow.ctx,
      pool: deps.pool ?? new ResourcePool(),
      forceRetry: new Set<WorkflowNodeKey>(["youtube_plain"]),
    });
    if (!r.ok) {
      const err = ledger.getNodeState(streamKey, "youtube_plain")?.error ?? "YouTube 上传失败";
      jlog(`续跑补 YouTube 失败,转人工: ${err}`);
      ledger.setState(streamKey, "needs_manual", { error: err });
      notify({ kind: "error", stage: "上传", message: `续跑补 YouTube 失败,请人工处理: ${err}` });
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

  const ytId = ledger.get(streamKey)?.ytId;
  ledger.markDone(streamKey, bv, ytId ? { ytId } : {});
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  if (ytId) notify({ kind: "uploadDone", label: "YouTube", url: `https://youtu.be/${ytId}` });

  // 可选:done 后删 stage 产物(与主路径同一开关;续跑不删 slave 源)。
  if (cfg.cleanup?.stageAfterDone) {
    const rmStage = deps.rmStage ?? defaultRmStage;
    const products = [prod.plain, prod.danmuMp4, prod.livechatMp4];
    const xmlAss = cfg.cleanup?.includeXmlAss
      ? [path.join(stageSub, prod.dateName + ".xml"),
         prod.danmuMp4.replace(/\.mp4$/, ".ass"), prod.livechatMp4.replace(/\.mp4$/, ".ass")]
      : [];
    ledger.logStep(streamKey, "clean_stage", "start");
    await rmStage([...products, ...xmlAss]);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${products.length + xmlAss.length} 文件`);
  }
  return { state: "done", bv };
}
