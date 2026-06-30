import path from "node:path";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { NotifyEvent } from "@drec/core";
import type { UploadOpts } from "@drec/app";
import { splitToSizeLimit } from "@drec/post-process";
import { selectWinner } from "./select.js";

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
}

export interface PipelineDeps {
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  sh: (cmd: string) => Promise<void>;
  /** 仅上传 plain(P1)拿 BV —— **穿插上传接缝**:pipeline 先 fire 它(网络),与烧录(CPU)并行。 */
  uploadPlain: (plain: UploadOpts) => Promise<string>;
  /** 追加一个逻辑组到稿件(空组跳过)。多组**串行**调用(同稿件并发 append 会撞)。 */
  appendGroup: (o: { bv: string; files: string[]; cookies: string }) => Promise<void>;
  /** 把单个烧录产物按 16GB 上限切成多段(默认 splitToSizeLimit);可注入测试。 */
  splitForUpload?: (mp4: string) => Promise<string[]>;
  /** 删 master 本地 stage 文件(cleanup 用);默认 fs.rm,可注入测试。 */
  rmStage?: (paths: string[]) => Promise<void>;
  notify: (e: NotifyEvent) => void;
  cfg: PipelineCfg;
}

/** streamKey(例 "douyin:767116735823:2026-06-27") → 安全目录名：替换 : / 为 _ */
function sanitizeKey(key: string): string {
  return key.replace(/[:/]/g, "_");
}

export async function runPipeline(
  b: Broadcast,
  deps: PipelineDeps,
): Promise<{ state: JobState; bv?: string }> {
  const { transports, ledger, sh, uploadPlain, appendGroup, notify, cfg } = deps;
  const splitForUpload = deps.splitForUpload ?? ((mp4: string) => splitToSizeLimit(mp4));
  const rmStage = deps.rmStage ?? (async (paths: string[]) => {
    const { rmSync } = await import("node:fs");
    for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
  });
  const burnDanmu = cfg.steps?.burnDanmu !== false;        // 默认开
  const burnLivechat = cfg.steps?.burnLivechat !== false;  // 默认开
  const clean = cfg.cleanup ?? {};
  const { streamKey } = b;

  // #1 防护:剔除「文件已不在该节点」的成员(已归档/清理)——否则可能选中其为 winner、pull 失败卡住。
  // 无 exists 能力的 transport 视为信任存在;exists 抛错按缺失剔除。
  const presentMembers = [];
  for (const m of b.members) {
    const tp = transports.get(m.tenantId);
    const ok = tp?.exists ? await tp.exists(m.rec.tsFiles).catch(() => false) : true;
    if (ok) presentMembers.push(m);
    else console.warn(`[pipeline] ${streamKey} 剔除成员 ${m.tenantId}:文件已不存在`);
  }
  const candidates = { ...b, members: presentMembers };

  // Select the best recording across all (present) nodes
  const selection = selectWinner(candidates, cfg.cleanMaxGapSec);

  if (!selection.winner) {
    ledger.setState(streamKey, "failed", { error: presentMembers.length ? "no winner" : "无可用成员(文件均缺失)" });
    return { state: "failed" };
  }

  const winner = selection.winner;

  // 落库选优候选明细(coverage/时长/起止/缺口 + 谁胜出),供事后复盘"为什么这台赢"。
  ledger.recordCandidates(streamKey, selection.perNode, winner.tenantId);

  // 没有任何 tenant 完整录全(所有节点都断流过)→ 直接中断 + 通知,**绝不删源**(保护数据,
  // 留人工对齐拼接)。跨会话自动拼接是 followup(见 docs/multi-node-sync-followups.md),暂不自动做。
  // selection.clean=true ⇔ 存在「单会话且 gap≤阈值」的完整 tenant;false ⇔ 都断流。
  if (!selection.clean) {
    ledger.setState(streamKey, "needs_manual", { winnerTenant: winner.tenantId });
    notify({
      kind: "error",
      stage: "同步",
      message: `所有节点均断流未录全,最完整=${winner.tenantId}(${Math.round(winner.rec.durationSec)}s),已保留全部源,请人工对齐拼接。覆盖度:${JSON.stringify(selection.perNode)}`,
    });
    return { state: "needs_manual" };
  }

  // Mark syncing and pull files from winner node into a per-broadcast sub-directory
  ledger.setState(streamKey, "syncing", { winnerTenant: winner.tenantId });
  const transport = transports.get(winner.tenantId);
  if (!transport) throw new Error(`No transport for tenant: ${winner.tenantId}`);

  // stageSub = stageDir/<sanitized-streamKey> — isolates each broadcast's files
  const stageSub = path.join(cfg.stageDir, sanitizeKey(streamKey));

  const filesToPull = [
    ...winner.rec.tsFiles,
    ...(winner.rec.xmlPath ? [winner.rec.xmlPath] : []),
  ];
  await transport.pull(filesToPull, stageSub);

  // Merge and burn from the stageSub directory
  ledger.setState(streamKey, "merging");

  const dateName = winner.rec.sessionBase.replace(/_\d{2}-\d{2}-\d{2}$/, "");
  const plain = path.join(stageSub, dateName + ".mp4");
  const danmuMp4 = path.join(stageSub, dateName + "_danmu.mp4");
  const livechatMp4 = path.join(stageSub, dateName + "_livechat.mp4");
  const xmlArg = winner.rec.xmlPath ? path.join(stageSub, path.basename(winner.rec.xmlPath)) : "";

  await sh(`node dist/douyin-rec.mjs merge --in ${stageSub} --base ${winner.rec.sessionBase}`);

  // 穿插上传:upload 模式下 merge 完 plain 即**后台 fire P1 上传**(网络),与随后的烧录(CPU)并行,
  // 省总墙钟。stage 模式不传(bvPromise=null)。先 .then 收成 {bv}|{err},即便后续烧录抛错也不留
  // unhandled rejection(P1 可能已建稿 → 失败按 retry 处理,可接受)。
  const willUpload = cfg.uploadMode === "upload";
  const bvPromise: Promise<{ bv: string } | { err: Error }> | null = willUpload
    ? (ledger.setState(streamKey, "uploading"),
       uploadPlain({
         video: plain, cookies: cfg.cookies, title: dateName,
         tag: cfg.uploadMeta.tag, tid: cfg.uploadMeta.tid,
         public: cfg.uploadPrivate === false, // private=false → 公开;默认(true)→ 仅自己可见
         desc: cfg.uploadMeta.desc,
       }).then((bv) => ({ bv }), (err: unknown) => ({ err: err as Error })))
    : null;

  // 步骤开关:burnDanmu/burnLivechat 默认开,false 则跳过该产出。此刻 P1 在后台上传(若 upload 模式)。
  if (burnDanmu) await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xmlArg} --style danmu --gift-value 0.9`);
  if (burnLivechat) await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xmlArg} --style livechat --gift-value 0.9`);

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
    for (const m of candidates.members) {
      await transports.get(m.tenantId)?.cleanup?.(sourcePathsOf(m)).catch(() => {});
    }
  };

  // cleanup:合并后删 stage 里拉来的源 .ts(留合成产物)。
  if (clean.stageSourceAfterMerge) {
    const pulledTs = winner.rec.tsFiles.map((f) => path.join(stageSub, path.basename(f)));
    await rmStage([...pulledTs, ...(clean.includeXmlAss && xmlArg ? [xmlArg] : [])]);
  }

  // stage 模式:有完整 winner 但不自动上传 → 产物已在 stage 待人工上传,源按配置清。
  // (!selection.clean 的「都断流」情况已在前面 early-return,这里 clean 必为 true。)
  if (!willUpload) {
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
  const r = await bvPromise!;
  if ("err" in r) {
    ledger.setState(streamKey, "failed", { error: `P1 上传失败: ${r.err.message}` });
    notify({ kind: "error", stage: "上传", message: `plain 上传失败:${r.err.message}` });
    return { state: "failed" };
  }
  const bv = r.bv;
  for (const files of [danmuParts, livechatParts]) {
    if (files.length === 0) continue; // 关掉的步骤 → 空组,不传
    await appendGroup({ bv, files, cookies: cfg.cookies });
  }

  ledger.markDone(streamKey, bv);
  // cleanup:done 后删源节点录制 + stage 产物(按配置)。
  await cleanupSources();
  if (clean.stageAfterDone) {
    const products = [plain, ...danmuParts, ...livechatParts];
    const xmlAss = clean.includeXmlAss
      ? [plainXml, xmlArg, danmuMp4.replace(/\.mp4$/, ".ass"), livechatMp4.replace(/\.mp4$/, ".ass")].filter(Boolean)
      : [];
    await rmStage([...products, ...xmlAss]);
  }
  return { state: "done", bv };
}
