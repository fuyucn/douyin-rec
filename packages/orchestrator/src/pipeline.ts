import path from "node:path";
import type { Broadcast } from "./identity.js";
import type { Transport } from "./transport.js";
import type { JobState, SyncLedger } from "./ledger.js";
import type { NotifyEvent } from "@drec/core";
import type { UploadOpts } from "@drec/app";
import { selectWinner } from "./select.js";

export interface UploadArgs {
  plain: UploadOpts;
  extras: string[];
  run?: (argv: string[]) => Promise<string>;
}

export interface PipelineDeps {
  transports: Map<string, Transport>;
  ledger: SyncLedger;
  sh: (cmd: string) => Promise<void>;
  upload: (o: UploadArgs) => Promise<string>;
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
  const { streamKey } = b;

  // Select the best recording across all nodes
  const selection = selectWinner(b, cfg.cleanMaxGapSec);

  if (!selection.winner) {
    ledger.setState(streamKey, "failed", { error: "no winner" });
    return { state: "failed" };
  }

  const winner = selection.winner;

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

  // Upload clean winner
  ledger.setState(streamKey, "uploading");
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
    extras: [danmuMp4, livechatMp4],
  });

  ledger.markDone(streamKey, bv);
  return { state: "done", bv };
}
