import { describe, expect, it, vi } from "vitest";
import type { Platform } from "@drec/core";
import { createStreamUploadMedia } from "./stream-upload-media.js";
import type { PreparedStreamUpload } from "./stream-upload-setup.js";

/**
 * #496 review P2: the production adapter used to rebuild the stream object and drop
 * unplayableReason before the live-pump could show it.
 */
describe("stream-upload media probe adapter (#496)", () => {
  it("forwards unplayableReason from platform.getStream", async () => {
    const platform = {
      id: "bilibili", defaultQuality: "origin",
      roomToUrl: (room: string) => room, extractRoomSlug: () => "r",
      getStream: vi.fn(async () => ({ living: true, unplayableReason: "playurl 空" })),
    } as unknown as Platform;
    const ctx = {
      platform, roomSlug: "r",
      options: { room: "r", name: "n", danmu: "0" },
      recording: { outDir: "/tmp", quality: "origin", segmentSec: 0 },
      pumpFilesDir: "/tmp", layout: "room", anchor: "n",
    } as unknown as PreparedStreamUpload;
    const media = createStreamUploadMedia(ctx);
    await expect(media.fetch("r", "origin")).resolves.toMatchObject({
      living: true, unplayableReason: "playurl 空",
    });
  });
});
