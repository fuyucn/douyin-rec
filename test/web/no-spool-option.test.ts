import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { payloadFromForm, formFromRoom, type RoomContext } from "../../packages/web/src/lib/room-editor-form.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

const ROOT = join(__dirname, "..", "..");
const ctx: RoomContext = { hasRecording: true, hasRule: true, writesRule: true, deliveryTouched: false, danmuAvailable: true, cookieReady: true, cookieForStream: false };

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

describe("UI copy describes the mandatory spool", () => {
  it("zero-disk label no longer claims no local video is written", () => {
    const dict = readFileSync(join(ROOT, "packages", "web", "src", "lib", "i18n.tsx"), "utf-8");
    expect(dict).toContain('zeroDisk: "直播直传（临时落盘分 P，上传成功后清理）"');
    expect(dict).toContain('zeroDisk: "Live upload (temporary local parts, cleaned after upload)"');
    expect(dict).toContain("每个分 P 先写临时文件");
    expect(dict).toContain("上传成功后清理");
    expect(dict).toContain("keeps its local fallback file");
    expect(dict).toContain("未上传完的那一段会保留本地回退文件");
    expect(dict).toContain("分 P 临时文件仅用于上传与失败回退,不参与留存格式转换");
    expect(dict).toContain("only serve upload and failure fallback and take no part in archive format conversion");
    expect(dict).not.toContain("不写本地视频");
    expect(dict).not.toContain("没有本地视频可回退");
    expect(dict).not.toContain("不产生本地视频文件");
    expect(dict).not.toContain("no local video");
    expect(dict).not.toContain("断流没有回退");
    expect(dict).not.toContain("no local video fallback");
  });
});
