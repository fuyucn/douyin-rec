import { setRecorderPhase } from "@drec/core";
import {
  alignFileSize, DEFAULT_SEGMENT_CAP, DEFAULT_STALL_TIMEOUT_MS, DEFAULT_RECOVERY_WINDOW_MS,
  DEFAULT_MEDIA_WALL_ALERT_RATIO, runLivePump, type RunLivePumpOptions,
} from "@drec/zero-upload";
import { buildLivePumpSubmitter } from "./live-pump-submitter.js";
import { streamPartMaxMs } from "./stream-part-duration.js";
import { createStreamUploadMedia } from "./stream-upload-media.js";
import { createStreamUploadLifecycle } from "./stream-upload-lifecycle.js";
import { sweepStreamUploadSpools } from "./stream-upload-spools.js";
import {
  prepareStreamUpload, streamUploadDiskMinGB, type StreamUploadInput, type PreparedStreamUpload,
} from "./stream-upload-setup.js";

function secondsSetting(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.max(60_000, Math.round(value * 1000)) : fallback;
}

function uploadPolicy(ctx: PreparedStreamUpload) {
  const { options, manual, streamMeta, delivery } = ctx;
  const sizeCap = alignFileSize(options.streamUploadSize !== undefined
    ? Number(options.streamUploadSize)
    : streamMeta.partSizeMiB ? streamMeta.partSizeMiB * 1024 * 1024 : DEFAULT_SEGMENT_CAP);
  const stallTimeoutMs = secondsSetting(options.streamUploadStallSec, DEFAULT_STALL_TIMEOUT_MS);
  const recoverWindowMs = secondsSetting(options.streamUploadRecoverSec, DEFAULT_RECOVERY_WINDOW_MS);
  const ratio = Number(options.streamUploadRatioAlert);
  const mediaWallAlertRatio = Number.isFinite(ratio) && ratio >= 0 && ratio <= 1
    ? ratio : DEFAULT_MEDIA_WALL_ALERT_RATIO;
  const seconds = options.streamUploadSec ?? (Number(options.segment ?? 0) > 0
    ? options.segment + "(--segment)" : "字节兜底");
  console.log("[rec] 直播直传已开启:room=" + options.room + " sizeCap=" + sizeCap + " sec=" + seconds +
    " stall=" + stallTimeoutMs / 1000 + "s recover=" + recoverWindowMs / 1000 + "s tid=" +
    (manual.streamUploadTid ?? streamMeta.tid) + (delivery ? " (master 下发)" : ""));
  return {
    sizeCap, stallTimeoutMs, recoverWindowMs, mediaWallAlertRatio,
    tid: Number(manual.streamUploadTid ?? streamMeta.tid),
    tag: manual.streamUploadTag ?? streamMeta.tag,
    private: manual.streamUploadPrivate === undefined
      ? streamMeta.private : manual.streamUploadPrivate !== "0",
    ...(streamMeta.desc ? { desc: streamMeta.desc } : {}),
    ...(streamMeta.seasonSectionId ? { seasonSectionId: streamMeta.seasonSectionId } : {}),
    maxMs: streamPartMaxMs(options.streamUploadSec, options.segment),
  };
}

function pumpOptions(
  ctx: PreparedStreamUpload,
  media: ReturnType<typeof createStreamUploadMedia>,
  life: ReturnType<typeof createStreamUploadLifecycle>,
): RunLivePumpOptions {
  const submitter = buildLivePumpSubmitter({
    cookiesPath: ctx.uploadCookies, spoolDir: ctx.pumpFilesDir, pumpRoom: ctx.pumpRoom,
    ...(life.submitGate ? { submitGate: life.submitGate } : {}), log: console.log,
  });
  const diskMinGB = streamUploadDiskMinGB();
  return {
    submitter, cookiesPath: ctx.uploadCookies, room: ctx.pumpRoom, spoolDir: ctx.pumpFilesDir,
    ...(diskMinGB !== undefined ? { diskMinGB } : {}),
    fetch: media.fetch, quality: media.quality, spoolName: media.spoolName, title: media.title,
    titleForLive: media.titleForLive, partTitle: media.partTitle, danmu: media.danmu,
    ...uploadPolicy(ctx),
    maxSegments: 0, submit: true, spoolMode: "full", waitForBroadcast: true,
    signal: life.signal, drainSignal: life.drainSignal, onHandoff: life.onHandoff,
    onPhase: setRecorderPhase, log: console.log, reporter: life.reporter,
    onAlert: (message) => {
      void ctx.notifier.notify({ kind: "error", stage: "直播直传", message }).catch(() => {});
    },
    ...(life.submitGate ? { submitGate: life.submitGate, onPartConfirmed: life.onPartConfirmed } : {}),
  };
}

/** The mode gate precedes all streamed-upload construction, disk work and signal handlers. */
export async function runStreamUploadRecord(input: StreamUploadInput): Promise<boolean> {
  if (!input.enabled) return false;
  const ctx = await prepareStreamUpload(input);
  const media = createStreamUploadMedia(ctx);
  sweepStreamUploadSpools(ctx.recording.outDir, ctx.pumpFilesDir, ctx.pumpRoom);
  const life = createStreamUploadLifecycle(ctx);
  let exitCode: number;
  try {
    const result = await runLivePump(pumpOptions(ctx, media, life));
    exitCode = await life.finish(result, media.startMs);
  } catch (error) {
    exitCode = life.failed(error);
  } finally {
    life.dispose();
  }
  process.exit(exitCode);
  return true;
}
