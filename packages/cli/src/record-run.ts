import { initRecorderState } from "@drec/core";
import { drecRoot } from "@drec/app";
import type { RecordCliOpts } from "./record-options.js";
import { prepareRecord, type RecordGlobalOpts } from "./record-setup.js";
import { prepareRollingUpload } from "./record-rolling.js";
import { runFileRecord } from "./record-session.js";
import { runStreamUploadRecord } from "./stream-upload-record.js";

export async function runRecord(options: RecordCliOpts, globals: RecordGlobalOpts): Promise<void> {
  const ctx = prepareRecord(options, globals);
  const rolling = await prepareRollingUpload(ctx);
  if (ctx.streamUploadEnabled && ctx.rollingEnabled) {
    console.error("[rec] --stream-upload 与 --rolling-upload 互斥,请只开一个");
    process.exit(2);
  }
  // State must exist while waiting for a stream, before either mode starts work.
  if (ctx.taskId !== undefined) {
    initRecorderState({
      root: drecRoot(), taskId: ctx.taskId, platform: ctx.platform.id,
      roomSlug: ctx.platform.extractRoomSlug(ctx.roomUrl),
      mode: ctx.streamUploadEnabled ? "live" : ctx.rollingEnabled ? "rolling" : "file",
    }).installExitHook(process);
  }
  if (await runStreamUploadRecord({
    enabled: ctx.streamUploadEnabled, options, platform: ctx.platform,
    recording: ctx.recording, notifier: ctx.notifier,
  })) return;
  await runFileRecord(ctx, rolling);
}
