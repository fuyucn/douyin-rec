import { noteRecorderDraining, noteRecorderSignal } from "@drec/core";
import { RecordingSession, type RollingUploadHook } from "@drec/manager";
import { prepareRecordRemux } from "./record-remux.js";
import type { PreparedRecord } from "./record-setup.js";

function installRecordSignals(session: RecordingSession, close: () => Promise<void>): void {
  let stopping = false;
  let draining = false;
  const shutdown = (sig: string) => {
    if (stopping) return;
    stopping = true;
    noteRecorderSignal(sig);
    console.log(`\n[rec] 收到 ${sig}，正在停止…`);
    void session.stop().then(close).then(() => {
      console.log("[rec] 已停止");
      process.exit(0);
    }).catch((err: unknown) => {
      console.error("[rec] 停止时出错:", err);
      process.exit(1);
    });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  // A window ending drains the current broadcast; a later hard stop may still interrupt it.
  process.on("SIGUSR2", () => {
    if (stopping || draining) return;
    draining = true;
    noteRecorderDraining();
    console.log("[rec] 收到 SIGUSR2，窗口结束排空：等待当前直播自然收播…");
    void session.drain().then(close).then(() => {
      console.log("[rec] 排空完成，已停止");
      process.exit(0);
    }).catch((err: unknown) => {
      console.error("[rec] 排空出错:", err);
      process.exit(1);
    });
  });
}

/** Ordinary recording retains its admission gate, hook ownership and graceful shutdown. */
export async function runFileRecord(ctx: PreparedRecord, rolling?: () => RollingUploadHook): Promise<void> {
  const { makeRolling, close } = await prepareRecordRemux(ctx, rolling);
  const { makeNewBroadcastGate, effectiveHubConfig } = await import("@drec/app");
  const effHub = effectiveHubConfig();
  const admitNewBroadcast = makeNewBroadcastGate({
    outDir: ctx.recording.outDir, hubConfigPath: effHub.path, hubConfigJson: effHub.json,
    warn: (m: string) => console.warn(m),
  });
  const { reconnectDelaySec, notifier, danmuEnabled, recorder } = ctx;
  const session = new RecordingSession(recorder, {
    reconnectDelaySec, notifier, danmuEnabled, makeRolling, admitNewBroadcast,
  });
  installRecordSignals(session, close);
  console.log(
    `[rec] recorder=${recorder.name} danmu=${danmuEnabled ? "on" : "off"} ` +
    `quality=${ctx.recording.quality} segment=${ctx.recording.segmentSec}s out=${ctx.recording.outDir}`
  );
  console.log(`[rec] 开始录制: ${ctx.roomUrl}`);
  await session.start(ctx.roomUrl, ctx.recording, { anchorName: "" });
  console.log("[rec] 录制中… Ctrl-C 停止");
}
