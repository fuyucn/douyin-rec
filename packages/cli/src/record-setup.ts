import { readFileSync } from "node:fs";
import { getEngine, loadConfig, platformForRoom, type DownloadEngine } from "@drec/core";
import type { RecordOpts } from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";
import {
  readOutputLayout, rootOutputDir,
} from "@drec/app";
import {
  parseDanmuFlag, parseRollingUploadFlag, parseStreamUploadFlag, rejectsNoSpoolFlag,
} from "./cli-flags.js";
import type { RecordCliOpts } from "./record-options.js";
import { recordNotifier } from "./cli-notifier.js";

export interface RecordGlobalOpts {
  discordWebhook?: string;
  discordWebhookFile?: string;
}

// Invalid switches must fail before platform lookup, hooks, state files or network work.
function uploadModes(o: RecordCliOpts) {
  if (rejectsNoSpoolFlag(o.streamUploadSpool)) {
    console.error("[rec] --stream-upload-spool none 已禁用:直播直传必须保留本地回退文件");
    process.exit(2);
  }
  const rolling = parseRollingUploadFlag(o.rollingUpload);
  if (!rolling.ok) {
    console.error(`[rec] ${rolling.error}`);
    process.exit(2);
  }
  const stream = parseStreamUploadFlag(o.streamUpload);
  if (!stream.ok) {
    console.error(`[rec] ${stream.error}`);
    process.exit(2);
  }
  return { rollingEnabled: rolling.value, streamUploadEnabled: stream.value };
}

// A present binary may still be unusable (for example, an incompatible libc).
function pickEngine(requestedId: string, platformDefaultId: string): DownloadEngine {
  const requested = getEngine(requestedId) ?? getEngine(platformDefaultId);
  if (!requested) throw new Error(`没有可用引擎(请求 ${requestedId},平台默认 ${platformDefaultId})`);
  if (!requested.probe) return requested;
  const why = requested.probe();
  if (why === null) return requested;
  const fallback = getEngine("ffmpeg");
  if (!fallback || fallback.id === requested.id) {
    throw new Error(`录制引擎 ${requested.id} 不可用: ${why};且无可回落的 ffmpeg 引擎`);
  }
  process.stderr.write(`[rec] 引擎 ${requested.id} 不可用(${why})→ 已回落到 ${fallback.id}\n`);
  return fallback;
}

export function prepareRecord(o: RecordCliOpts, globals: RecordGlobalOpts) {
  const cfg = loadConfig(o.config);
  const modes = uploadModes(o);
  const platform = platformForRoom(o.room);
  const engineId = o.engine || o.recorder || cfg.recorder || platform.defaultEngine;
  const danmuEnabled = parseDanmuFlag(o.danmu ?? cfg.danmu);
  const cookies = o.cookiesFile ? readFileSync(o.cookiesFile, "utf-8").trim() : o.cookies ?? cfg.cookies;
  const recording: RecordOpts = {
    quality: (o.quality ?? cfg.quality) as RecordOpts["quality"],
    cookies, outDir: o.out || cfg.outDir || rootOutputDir(),
    segmentSec: o.segment !== undefined ? Number(o.segment) : cfg.segmentSec,
    name: o.name?.trim() || undefined,
    // Read once: a running session must keep its original layout.
    outputLayout: readOutputLayout(),
    danmuXmlMode: (o.danmuXmlMode ?? cfg.danmuXmlMode) === "segment" ? "segment" : "session",
  };
  const reconnectDelaySec = o.reconnect !== undefined ? Number(o.reconnect) : cfg.reconnectDelaySec;
  const roomUrl = platform.roomToUrl(o.room);
  const recorder = new PollingRecorder(pickEngine(engineId, platform.defaultEngine));
  const webhook = (globals.discordWebhookFile
    ? readFileSync(globals.discordWebhookFile, "utf-8").trim() || undefined : undefined)
    ?? globals.discordWebhook ?? cfg.discordWebhook ?? process.env.DISCORD_WEBHOOK;
  return {
    options: o, platform, roomUrl, recording, recorder, danmuEnabled, reconnectDelaySec,
    notifier: recordNotifier(webhook), ...modes,
    taskId: o.taskId !== undefined && /^\d+$/.test(o.taskId) ? Number(o.taskId) : undefined,
  };
}

export type PreparedRecord = ReturnType<typeof prepareRecord>;
