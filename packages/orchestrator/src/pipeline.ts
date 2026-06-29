import path from "node:path";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { NotifyEvent } from "@drec/core";
import type { UploadOpts } from "@drec/app";
import { splitToSizeLimit } from "@drec/post-process";
import { selectWinner } from "./select.js";

export interface UploadArgs {
  plain: UploadOpts;
  /** 按逻辑块分组的分P(每组一条 append),例:[[danmu_part0,danmu_part1],[livechat]]。 */
  groups: string[][];
  run?: (argv: string[]) => Promise<string>;
}

export interface PipelineDeps {
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  sh: (cmd: string) => Promise<void>;
  upload: (o: UploadArgs) => Promise<string>;
  /** 把单个烧录产物按 16GB 上限切成多段(默认 splitToSizeLimit);可注入测试。 */
  splitForUpload?: (mp4: string) => Promise<string[]>;
  notify: (e: NotifyEvent) => void;
  cfg: {
    cleanMaxGapSec: number;
    stageDir: string;
    cookies: string;
    uploadMode: "auto-private" | "stage-only";
    uploadMeta: {
      tag: string;
      tid: number;
      desc?: string;
    };
  };
}

/** streamKey(例 "douyin:767116735823:2026-06-27") → 安全目录名：替换 : / 为 _ */
function sanitizeKey(key: string): string {
  return key.replace(/[:/]/g, "_");
}

export async function runPipeline(
  b: Broadcast,
  deps: PipelineDeps,
): Promise<{ state: JobState; bv?: string }> {
  const { transports, ledger, sh, upload, notify, cfg } = deps;
  const splitForUpload = deps.splitForUpload ?? ((mp4: string) => splitToSizeLimit(mp4));
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
  await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xmlArg} --style danmu --gift-value 0.9`);
  await sh(`node dist/douyin-rec.mjs burn --video ${plain} --xml ${xmlArg} --style livechat --gift-value 0.9`);

  // If not clean or stage-only mode: escalate to manual review
  if (!selection.clean || cfg.uploadMode === "stage-only") {
    ledger.setState(streamKey, "needs_manual");
    notify({
      kind: "error",
      stage: "同步",
      message: `无干净版本/待批，覆盖度：${JSON.stringify(selection.perNode)}`,
    });
    return { state: "needs_manual" };
  }

  // Upload clean winner. 每个逻辑块(danmu/livechat)先按 16GB 上限切分(超限→多段),
  // 再作为**独立一组**传给 upload(每组一条 append → 增量提交、各自可续传)。
  ledger.setState(streamKey, "uploading");
  const danmuParts = await splitForUpload(danmuMp4);
  const livechatParts = await splitForUpload(livechatMp4);
  const bv = await upload({
    plain: {
      video: plain,
      cookies: cfg.cookies,
      title: dateName,
      tag: cfg.uploadMeta.tag,
      tid: cfg.uploadMeta.tid,
      public: false,
      desc: cfg.uploadMeta.desc,
    },
    groups: [danmuParts, livechatParts],
  });

  ledger.markDone(streamKey, bv);
  return { state: "done", bv };
}
