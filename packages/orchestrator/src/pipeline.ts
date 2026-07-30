import path from "node:path";
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { NotifyEvent, ScopedLogger } from "@drec/core";
import type { UploadOpts } from "@drec/app";
import { splitToSizeLimit } from "@drec/post-process";
import { selectWinner } from "./select.js";
import { retry } from "./retry.js";
import { humanBytes, humanDur, sumBytes } from "./format.js";

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
  stageDir: string;
  cookies: string;
  /** stage = 只合成不传;upload = 传 B站。 */
  uploadMode: "stage" | "upload";
  /** 仅 upload 时有意义:true(默认)= 仅自己可见,false = 公开。 */
  uploadPrivate?: boolean;
  uploadMeta: { tag: string; tid: number; desc?: string };
  steps?: PipelineSteps;
  cleanup?: PipelineCleanup;
  /** reconciler 硬过滤用:非空 → 只处理这些 worker 的录像;缺省/空 = 全部(向后兼容)。pipeline 本身不读。 */
  workers?: string[];
}

export interface PipelineDeps {
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  /** 执行子命令(merge/burn 等)。可选返回 stdout+stderr 文本 → pipeline 会摘尾写进该场 job.log。 */
  sh: (cmd: string) => Promise<void | string>;
  /** 仅上传 plain(P1)拿 BV —— **穿插上传接缝**:pipeline 先 fire 它(网络),与烧录(CPU)并行。 */
  uploadPlain: (plain: UploadOpts) => Promise<string>;
  /** 追加一个逻辑组到稿件(空组跳过)。多组**串行**调用(同稿件并发 append 会撞)。
   *  public 透传 → append 保留 P1 的水印关/可见性(防 append 重置)。 */
  appendGroup: (o: { bv: string; files: string[]; cookies: string; public: boolean }) => Promise<void>;
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
  try {
    const r = await runPipelineInner(b, deps, jlog);
    jlog(`=== pipeline end: ${r.state}${r.bv ? ` bv=${r.bv}` : ""} ===`);
    return r;
  } catch (e) {
    jlog(`!!! pipeline 抛错(reconciler 将标 failed): ${String((e as Error)?.stack ?? e)}`);
    throw e;
  }
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
  const splitForUpload = deps.splitForUpload ?? ((mp4: string) => splitToSizeLimit(mp4));
  const rmStage = deps.rmStage ?? (async (paths: string[]) => {
    const { rmSync } = await import("node:fs");
    for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
  });
  const burnDanmu = cfg.steps?.burnDanmu !== false;        // 默认开
  const burnLivechat = cfg.steps?.burnLivechat !== false;  // 默认开
  const clean = cfg.cleanup ?? {};
  const { streamKey } = b;
  const stageSub = path.join(cfg.stageDir, sanitizeKey(streamKey));

  // 续跑:job 已有 bv ⇒ P1 已建稿(不可逆),绝不重传。跳过 select/pull/merge/burn/uploadPlain,只补 append。
  const existing = ledger.get(streamKey);
  if (cfg.uploadMode === "upload" && existing?.bv) {
    return await resumeAppends(streamKey, existing.bv, stageSub, deps, jlog);
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
    ledger.setState(streamKey, "failed", { error: presentMembers.length ? "no winner" : "无可用成员(文件均缺失)" });
    return { state: "failed" };
  }

  const winner = selection.winner;
  jlog(`选优: winner=${winner.workerId} clean=${selection.clean} 各节点=${JSON.stringify(selection.perNode)}`);

  // 落库选优候选明细(coverage/时长/起止/缺口 + 谁胜出),供事后复盘"为什么这台赢"。
  ledger.recordCandidates(streamKey, selection.perNode, winner.workerId);

  // 没有任何 worker 完整录全(所有节点都断流过)→ 直接中断 + 通知,**绝不删源**(保护数据,
  // 留人工对齐拼接)。跨会话自动拼接是 followup(见 docs/multi-node-sync-followups.md),暂不自动做。
  // selection.clean=true ⇔ 存在「单会话且 gap≤阈值」的完整 worker;false ⇔ 都断流。
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
  const filesToPull = [
    ...winner.rec.tsFiles,
    ...(winner.rec.xmlPath ? [winner.rec.xmlPath] : []),
  ];
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

  const dateName = winner.rec.sessionBase.replace(/_\d{2}-\d{2}-\d{2}$/, "");
  const plain = path.join(stageSub, dateName + ".mp4");
  const danmuMp4 = path.join(stageSub, dateName + "_danmu.mp4");
  const livechatMp4 = path.join(stageSub, dateName + "_livechat.mp4");
  const xmlArg = winner.rec.xmlPath ? path.join(stageSub, path.basename(winner.rec.xmlPath)) : "";

  ledger.logStep(streamKey, "merge", "start");
  await sh(`node dist/douyin-rec.mjs merge --in ${stageSub} --base ${winner.rec.sessionBase}`);
  const plainBytes = (() => { try { return Number(statSync(plain).size); } catch { return 0; } })();
  ledger.logStep(streamKey, "merge", "done",
    `${winner.rec.tsFiles.length} 段 → ${plainBytes > 0 ? humanBytes(plainBytes) : "?"}${winner.rec.durationSec > 0 ? ` · ${humanDur(winner.rec.durationSec)}` : ""}`);

  // 穿插上传:upload 模式下 merge 完 plain 即**后台 fire P1 上传**(网络),与随后的烧录(CPU)并行,
  // 省总墙钟。stage 模式不传(bvPromise=null)。先 .then 收成 {bv}|{err},即便后续烧录抛错也不留
  // unhandled rejection(P1 可能已建稿 → 失败按 retry 处理,可接受)。upload_plain 的 start/done
  // 各自打点(与烧录轨并行,流程图分两轨)。
  const willUpload = cfg.uploadMode === "upload";
  if (willUpload) jlog(`P1(plain)后台上传启动(与烧录并行): ${plain}`);
  if (willUpload) ledger.logStep(streamKey, "upload_plain", "start");
  const bvPromise: Promise<{ bv: string } | { err: Error }> | null = willUpload
    ? (ledger.setState(streamKey, "uploading"),
       uploadPlain({
         video: plain, cookies: cfg.cookies, title: dateName,
         tag: cfg.uploadMeta.tag, tid: cfg.uploadMeta.tid,
         public: cfg.uploadPrivate === false, // private=false → 公开;默认(true)→ 仅自己可见
         desc: cfg.uploadMeta.desc,
       }).then((bv) => {
         // checkpoint:P1 建稿成功即刻落库 bv —— 必须在这里(不能等烧录/split 完),
         // 否则 P1 成功后若 burn/split 抛错,bv 丢失 → 重试重传 P1 → 重复稿(review Critical)。
         ledger.setBv(streamKey, bv);
         const sz = (() => { try { return Number(statSync(plain).size); } catch { return 0; } })();
         ledger.logStep(streamKey, "upload_plain", "done", sz > 0 ? humanBytes(sz) : undefined);
         return { bv };
       },
              (err: unknown) => ({ err: err as Error })))
    : null;

  // 步骤开关:burnDanmu/burnLivechat 默认开,false 则跳过该产出。此刻 P1 在后台上传(若 upload 模式)。
  if (burnDanmu) {
    ledger.logStep(streamKey, "burn_danmu", "start");
    await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xmlArg} --style danmu --gift-value 0.9`);
    ledger.logStep(streamKey, "burn_danmu", "done",
      (() => { try { return `→ ${humanBytes(Number(statSync(danmuMp4).size))}`; } catch { return undefined; } })());
  }
  if (burnLivechat) {
    ledger.logStep(streamKey, "burn_livechat", "start");
    await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xmlArg} --style livechat --gift-value 0.9`);
    ledger.logStep(streamKey, "burn_livechat", "done",
      (() => { try { return `→ ${humanBytes(Number(statSync(livechatMp4).size))}`; } catch { return undefined; } })());
  }

  // 把弹幕 xml 复制一份作为 **plain xml 产物**(与 plain mp4 同名 {dateName}.xml),作为备份留在 stage。
  // 它是产物、不是「拉来的源」——所以 stageSourceAfterMerge 删源时不动它(即便 includeXmlAss);
  // 只有 stageAfterDone(上传后清产物)才按 includeXmlAss 一并删。这样 stage 备份永远含 plain xml。
  const plainXml = xmlArg ? path.join(stageSub, dateName + ".xml") : "";
  if (plainXml) {
    const { copyFileSync } = await import("node:fs");
    try { copyFileSync(xmlArg, plainXml); } catch { /* 源 xml 缺失则跳过 */ }
  }

  // 各成员节点的待删源(.ts 总删;.xml 仅 includeXmlAss)——给 sourceAfterDone 用。
  const sourcePathsOf = (m: typeof winner): string[] =>
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

  // cleanup:合并后删 stage 里拉来的源 .ts(留合成产物)。
  if (clean.stageSourceAfterMerge) {
    ledger.logStep(streamKey, "clean_stage_src", "start");
    const pulledTs = winner.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)));
    const victims = [...pulledTs, ...(clean.includeXmlAss && xmlArg ? [xmlArg] : [])];
    await rmStage(victims);
    ledger.logStep(streamKey, "clean_stage_src", "done", `删 ${victims.length} 文件`);
  }

  // stage 模式:有完整 winner 但不自动上传 → 产物已在 stage 待人工上传,源按配置清。
  // (!selection.clean 的「都断流」情况已在前面 early-return,这里 clean 必为 true。)
  if (!willUpload) {
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

  // upload 模式:P1 已在后台传(bvPromise)。各逻辑块先按 16GB 上限切分(超限→多段),
  // 再 await BV → **串行 append**(同稿件并发会撞;每组一条 append → 增量提交、各自可续传)。关掉的步骤 → 空组。
  const danmuParts = burnDanmu ? await splitForUpload(danmuMp4) : [];
  const livechatParts = burnLivechat ? await splitForUpload(livechatMp4) : [];
  jlog(`烧录全部完成,等待 P1 上传出 BV…(danmu ${danmuParts.length} 段 / livechat ${livechatParts.length} 段待 append)`);
  const r = await bvPromise!;
  if ("err" in r) {
    jlog(`P1 上传失败: ${r.err.message}`);
    ledger.setState(streamKey, "failed", { error: `P1 上传失败: ${r.err.message}` });
    notify({ kind: "error", stage: "上传", message: `plain 上传失败:${r.err.message}` });
    return { state: "failed" };
  }
  const bv = r.bv;
  jlog(`P1 上传完成: ${bv}`); // bv 已在 uploadPlain 的 .then 里即刻 setBv(见上,防 burn/split 失败丢 bv)
  const isPublic = cfg.uploadPrivate === false;
  const appendGroups: Array<{ step: "append_danmu" | "append_livechat"; files: string[] }> = [
    { step: "append_danmu", files: danmuParts },
    { step: "append_livechat", files: livechatParts },
  ];
  for (const g of appendGroups) {
    if (g.files.length === 0) continue;          // 关掉的步骤 → 空组,不传
    if (ledger.isStepDone(streamKey, g.step)) {  // 续跑:已完成的组跳过(幂等)
      jlog(`append 跳过(已完成): ${g.step}`);
      continue;
    }
    jlog(`append 开始: ${g.files.map((f) => path.basename(f)).join(", ")}`);
    const tApp = Date.now();
    ledger.logStep(streamKey, g.step, "start");
    // 单文件组就地重试安全(biliup 完整上传才加分 P);多段组 tries=1(避免跨调用重复分 P,见计划 021 Notes)
    const tries = g.files.length === 1 ? 3 : 1;
    await retry(() => appendGroup({ bv, files: g.files, cookies: cfg.cookies, public: isPublic }), {
      tries,
      sleep: deps.sleep,
      onRetry: (attempt, err) =>
        jlog(`append ${g.step} 第 ${attempt} 次失败,重试: ${String((err as Error)?.message ?? err).slice(0, 200)}`),
    });
    const apBytes = sumBytes(g.files);
    ledger.logStep(streamKey, g.step, "done",
      `${g.files.length} 段${apBytes > 0 ? ` · ${humanBytes(apBytes)}` : ""}`);
    jlog(`append 完成(${Math.round((Date.now() - tApp) / 1000)}s)`);
  }

  ledger.markDone(streamKey, bv);
  // hub 任务完成通知(成功上传):EventCenter 扇出 → 站内 toast + Discord webhook。
  notify({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}` });
  // cleanup:done 后删源节点录制 + stage 产物(按配置)。
  await cleanupSources();
  if (clean.stageAfterDone) {
    ledger.logStep(streamKey, "clean_stage", "start");
    const products = [plain, ...danmuParts, ...livechatParts];
    const xmlAss = clean.includeXmlAss
      ? [plainXml, xmlArg, danmuMp4.replace(/\.mp4$/, ".ass"), livechatMp4.replace(/\.mp4$/, ".ass")].filter(Boolean)
      : [];
    const victims = [...products, ...xmlAss];
    await rmStage(victims);
    ledger.logStep(streamKey, "clean_stage", "done", `删 ${victims.length} 文件`);
  }
  return { state: "done", bv };
}

/** 从 stageSub 目录按确定命名反推产物路径;找不到任何产物 → null。 */
function deriveProducts(stageSub: string): { dateName: string; plain: string; danmuMp4: string; livechatMp4: string } | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const danmu = files.find((f) => f.endsWith("_danmu.mp4"));
  const livechat = files.find((f) => f.endsWith("_livechat.mp4"));
  const plainF = files.find((f) => f.endsWith(".mp4") && !f.endsWith("_danmu.mp4") && !f.endsWith("_livechat.mp4"));
  let dateName: string | undefined;
  if (danmu) dateName = danmu.slice(0, -"_danmu.mp4".length);
  else if (livechat) dateName = livechat.slice(0, -"_livechat.mp4".length);
  else if (plainF) dateName = plainF.slice(0, -".mp4".length);
  if (!dateName) return null;
  return {
    dateName,
    plain: path.join(stageSub, dateName + ".mp4"),
    danmuMp4: path.join(stageSub, dateName + "_danmu.mp4"),
    livechatMp4: path.join(stageSub, dateName + "_livechat.mp4"),
  };
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
  const splitForUpload = deps.splitForUpload ?? ((mp4: string) => splitToSizeLimit(mp4));
  const burnDanmu = cfg.steps?.burnDanmu !== false;
  const burnLivechat = cfg.steps?.burnLivechat !== false;
  const isPublic = cfg.uploadPrivate === false;

  const prod = deriveProducts(stageSub);
  const need = [
    ...(burnDanmu ? [prod?.danmuMp4] : []),
    ...(burnLivechat ? [prod?.livechatMp4] : []),
  ].filter((f): f is string => !!f);
  if (!prod || need.some((f) => !existsSync(f))) {
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
    const tries = files.length === 1 ? 3 : 1;
    await retry(() => appendGroup({ bv, files, cookies: cfg.cookies, public: isPublic }), {
      tries,
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
    const rmStage = deps.rmStage ?? (async (paths: string[]) => {
      const { rmSync } = await import("node:fs");
      for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
    });
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
