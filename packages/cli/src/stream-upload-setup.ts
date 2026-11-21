import { mkdirSync, readFileSync } from "node:fs";
import { ZERO_DISK_DELIVERY_ENV, type Notifier, type Platform, type RecordNameFacts, type RecordOpts } from "@drec/core";
import {
  readOutputLayout, resolveZeroDiskPumpDirs, zeroDiskNodePreflight, writeZeroDiskStatus,
  resolveStreamUploadMeta, zeroDiskStreamMeta, rootBiliupCookies, effectiveHubConfig,
  resolveDiskWatermark,
} from "@drec/app";
import { livePumpStatePath, readLivePumpState } from "@drec/zero-upload";
import { zeroDiskUploadCookie } from "./zero-disk-upload-cookie.js";
import type { RecordCliOpts } from "./record-options.js";

export interface StreamUploadInput {
  enabled: boolean;
  options: RecordCliOpts;
  platform: Platform;
  recording: RecordOpts;
  notifier: Notifier;
  notifyFacts?: RecordNameFacts;
}

async function prepareStorage(input: StreamUploadInput) {
  const { options, platform, recording, notifier } = input;
  const layout = readOutputLayout();
  const anchor = options.name?.trim() || "";
  const paths = resolveZeroDiskPumpDirs({
    platform, rawRoom: options.room, outDir: recording.outDir, anchorName: anchor, layout,
  });
  if (paths.pumpFilesDir !== recording.outDir) mkdirSync(paths.pumpFilesDir, { recursive: true });
  if (layout !== "room" && paths.roomDir !== recording.outDir) {
    const statePath = livePumpStatePath(paths.roomDir, paths.pumpRoom);
    const state = readLivePumpState(statePath);
    if (state && (state.pending || state.parts.some((part) => !part?.confirmed))) {
      const message = "直播直传房间目录里还有未确认分 P,但当前是 legacy 布局,不会自动续传: " + statePath;
      console.error("[直播直传] ⚠️ " + message);
      await notifier.notify({ kind: "error", stage: "直播直传", message }).catch(() => {});
    }
  }
  return { ...paths, layout, anchor };
}

async function prepareManaged(input: StreamUploadInput, roomSlug: string) {
  if (input.options.zeroDiskManaged !== "1") return undefined;
  const pre = zeroDiskNodePreflight(process.env[ZERO_DISK_DELIVERY_ENV]);
  if (!pre.ok) {
    writeZeroDiskStatus({ platform: input.platform.id, roomSlug, state: "refused",
      code: pre.refusal.code, message: pre.refusal.message, parts: 0 });
    const message = "直播直传拒绝启动 [" + pre.refusal.code + "]: " + pre.refusal.message;
    console.error("[直播直传] " + message);
    await input.notifier.notify({ kind: "error", stage: "直播直传", message }).catch(() => {});
    process.exit(2);
  }
  console.log("[直播直传] 节点预检通过(上传登录来源=" + pre.credentialSource + ",账号与 master 配置一致)");
  return pre;
}

/** Resolve once per run: layout and delivered metadata must not drift during a broadcast. */
export async function prepareStreamUpload(input: StreamUploadInput) {
  const { options, platform } = input;
  const roomSlug = platform.extractRoomSlug(platform.roomToUrl(options.room));
  const storage = await prepareStorage(input);
  const managed = await prepareManaged(input, roomSlug);
  const delivery = managed?.delivery;
  const streamMeta = zeroDiskStreamMeta(delivery, resolveStreamUploadMeta(platform.id, roomSlug));
  const uploadCookies = managed?.cookiesPath ?? zeroDiskUploadCookie(process.env, rootBiliupCookies());
  const manual: Pick<RecordCliOpts, "streamUploadTid" | "streamUploadTag" | "streamUploadPrivate"> =
    delivery ? {} : options;
  return { ...input, ...storage, roomSlug, delivery, streamMeta, uploadCookies, manual };
}

export type PreparedStreamUpload = Awaited<ReturnType<typeof prepareStreamUpload>>;

/** Preserve the daemon's disk threshold, including explicit zero and file-sourced configuration. */
export function streamUploadDiskMinGB(): number | undefined {
  try {
    const effective = effectiveHubConfig();
    const json = effective.json ?? readFileSync(effective.path, "utf-8");
    return resolveDiskWatermark(json, (message) => console.warn(message)).bytes / 1e9;
  } catch (error) {
    console.warn("[直播直传] 磁盘水位读取失败,pump 使用默认闸门: " +
      String((error as Error)?.message ?? error));
    return undefined;
  }
}
