import { existsSync } from "node:fs";
import { join } from "node:path";
import type { RecordOpts } from "@drec/core";
import { XmlDanmuWriter } from "@drec/manager";
import { describeStreamIdentity } from "@drec/record-engine";
import { resolveStreamPartTitle, resolveStreamUploadTitle } from "@drec/app";
import { zeroDiskSpoolName, zeroDiskXmlPath } from "./zero-disk-room.js";
import type { PreparedStreamUpload } from "./stream-upload-setup.js";

function createDanmu(ctx: PreparedStreamUpload, anchorName: () => string) {
  const { options, platform, recording, pumpFilesDir, roomSlug, layout, anchor } = ctx;
  const roomUrl = platform.roomToUrl(options.room);
  const opts: RecordOpts = {
    quality: recording.quality ?? platform.defaultQuality,
    cookies: options.cookies, outDir: recording.outDir, segmentSec: 0,
  };
  const source = options.danmu === "0" ? null
    : platform.connectDanmu?.({ roomUrl, channelId: roomSlug, opts }) ?? null;
  if (!source) return undefined;
  const writer = new XmlDanmuWriter({ log: (m) => console.warn(`[直播直传] ⚠️ ${m}`) });
  let xmlPath = "";
  let opened = false;
  console.log(`[rec] 弹幕落盘: ${pumpFilesDir}/<开播时间>.live.xml`);
  return {
    get xmlPath(): string { return xmlPath; },
    start: async (): Promise<void> => {
      const startMs = Date.now();
      const base = zeroDiskXmlPath(pumpFilesDir, roomSlug, startMs, undefined,
        layout === "room" ? anchor : undefined);
      xmlPath = base;
      if (layout === "room") {
        for (let n = 1; existsSync(xmlPath); n++) xmlPath = base.replace(/\.live\.xml$/, `-${n}.live.xml`);
      }
      writer.open(xmlPath, { anchorName: anchorName(), roomId: roomSlug, videoStartMs: startMs });
      opened = true;
      await source.start(roomUrl, opts, (m) => writer.add(m),
        (message) => console.error(`[直播直传] ⚠️ 弹幕: ${message}`));
    },
    stop: async (): Promise<void> => {
      await source.stop().catch(() => {});
      if (opened) writer.close();
    },
  };
}

/** One broadcast clock drives titles, spool names and ledger identity. */
export function createStreamUploadMedia(ctx: PreparedStreamUpload) {
  const { platform, roomSlug, options, recording, delivery, pumpFilesDir, anchor } = ctx;
  let anchorName = options.name?.trim() || roomSlug;
  let startMs = Date.now();
  let started = false;
  const titleContext = () => ({
    platform: platform.id, roomSlug, anchorName, startMs, ...(delivery ? { meta: delivery.meta } : {}),
  });
  return {
    get startMs(): number { return startMs; },
    quality: recording.quality ?? platform.defaultQuality,
    title: resolveStreamUploadTitle(titleContext()),
    titleForLive: (liveTitle: string) => resolveStreamUploadTitle({ ...titleContext(), liveTitle }),
    partTitle: (partIndex: number, liveTitle?: string) => resolveStreamPartTitle({
      ...titleContext(), partIndex, ...(liveTitle ? { liveTitle } : {}),
    }),
    fetch: async (room: string, quality: string) => {
      const stream = await platform.getStream(room, quality);
      if (stream.owner?.trim()) anchorName = stream.owner.trim();
      if (stream.living && stream.url) {
        console.log(`[session-id] ${describeStreamIdentity(stream)}`);
        if (!started) { startMs = Date.now(); started = true; }
      }
      return {
        living: stream.living,
        ...(stream.url ? { url: stream.url } : {}),
        ...(stream.headers ? { headers: stream.headers } : {}),
        ...(stream.title ? { title: stream.title } : {}),
        ...(stream.owner ? { owner: stream.owner } : {}),
      };
    },
    spoolName: (segment: number) => {
      const head = anchor || roomSlug;
      let name = zeroDiskSpoolName(head, startMs, segment);
      for (let n = 1; existsSync(join(pumpFilesDir, name)); n++) {
        name = zeroDiskSpoolName(head, startMs, segment, undefined, n);
      }
      return name;
    },
    danmu: createDanmu(ctx, () => anchorName),
  };
}
