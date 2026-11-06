import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { payloadFromForm, formFromRoom, type RoomContext } from "../../packages/web/src/lib/room-editor-form.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

const ROOT = join(__dirname, "..", "..");
const ctx: RoomContext = { hasRecording: true, hasRule: true, danmuAvailable: true, cookieReady: true, cookieForStream: false };

describe("no-spool option is not selectable", () => {
  it("form payload always sends streamUploadSpool=true, even with a tampered form state", () => {
    const room: RoomDTO = {
      key: "douyin.1", platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1",
      recording: { streamUpload: true, streamUploadSpool: false } as RoomDTO["recording"],
      processing: { enabled: true, workers: ["local"], pipeline: { upload: { mode: "rolling" }, steps: { burnDanmu: false, burnLivechat: false } } } as RoomDTO["processing"],
    };
    const form = { ...formFromRoom(room), streamUploadSpool: false };
    const result = payloadFromForm(form, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload.recording?.streamUploadSpool).toBe(true);
  });

  it("room editor has no switch that can write streamUploadSpool=false", () => {
    const source = readFileSync(join(ROOT, "packages", "web", "src", "modals", "RoomEditor.tsx"), "utf-8");
    expect(source).not.toContain("update({ streamUploadSpool })");
    expect(source).toContain("room.editor.zeroDiskSpoolHint");
  });
});
