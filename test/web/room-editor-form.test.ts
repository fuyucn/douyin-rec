import { describe, it, expect } from "vitest";
import { factsOf, formFromRoom, payloadFromForm, type RoomContext } from "../../packages/web/src/lib/room-editor-form.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

const ctx: RoomContext = { hasRecording: true, hasRule: true, danmuAvailable: true, cookieReady: true, cookieForStream: false };

describe("factsOf carries the room's rule presence (#284)", () => {
  it("task-only room (no processing half) → hasRule false, so VERSIONS stays hidden", () => {
    const f = formFromRoom({ room: "1", platform: "douyin", processing: null } as never);
    expect(factsOf(f, { ...ctx, hasRule: false }).hasRule).toBe(false);
  });
  it("room with a rule → hasRule true", () => {
    const f = formFromRoom({ room: "1", platform: "douyin", processing: { enabled: true, pipeline: {} } } as never);
    expect(factsOf(f, ctx).hasRule).toBe(true);
  });
});

function mkRoom(over: { recording?: Partial<NonNullable<RoomDTO["recording"]>> | null; processing?: Partial<NonNullable<RoomDTO["processing"]>> | null } = {}): RoomDTO {
  const recording = over.recording === null ? null : {
    taskId: 7, room: "https://live.douyin.com/1", name: "n", anchorName: null, quality: "origin", engine: "ffmpeg",
    danmu: 1, segmentSec: 1800, scheduleStart: "20:00", scheduleEnd: "02:00", enabled: true, useCookie: true,
    cookies: null, outDir: null, webhook: null, rollingUpload: false, rollingEffective: false, outputFormat: "original",
    ...over.recording,
  } as NonNullable<RoomDTO["recording"]>;
  const processing = over.processing === null ? null : ({
    enabled: true, workers: ["vps1"], requires: [],
    pipeline: {
      steps: { mergeSegments: true, burnDanmu: true, burnLivechat: false },
      upload: { mode: "upload", private: true, tid: 171, tag: "a,b", titleTemplate: "{name}_{date}" },
      cleanup: { stageSourceAfterMerge: true, sourceAfterDone: true, stageAfterDone: true },
    },
    ...over.processing,
  } as NonNullable<RoomDTO["processing"]>);
  return { key: "douyin.1", platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1", recording, processing };
}

const ok = (r: ReturnType<typeof payloadFromForm>) => {
  if (!r.ok) throw new Error("expected ok");
  return r.payload;
};

describe("room editor form ↔ payload", () => {
  it("sends workers: null (explicit all nodes) for an empty selection, never []", () => {
    const f = { ...formFromRoom(mkRoom()), workers: [] as string[] };
    expect(ok(payloadFromForm(f, ctx)).processing?.workers).toBeNull();
    const g = { ...formFromRoom(mkRoom()), workers: ["vps1", "local"] };
    expect(ok(payloadFromForm(g, ctx)).processing?.workers).toEqual(["vps1", "local"]);
  });
  it("round-trips stored fields without silently changing them", () => {
    const p = ok(payloadFromForm(formFromRoom(mkRoom()), ctx));
    expect(p.recording).toMatchObject({ name: "n", quality: "origin", engine: "ffmpeg", segmentSec: 1800, danmu: 1, useCookie: true, scheduleStart: "20:00", scheduleEnd: "02:00", outputFormat: "original", webhook: null });
    expect(p.processing?.workers).toEqual(["vps1"]);
    expect(p.processing?.pipeline?.steps).toMatchObject({ mergeSegments: true, burnDanmu: true, burnLivechat: false, nodeSideUpload: false });
    expect(p.processing?.pipeline?.upload).toMatchObject({ mode: "upload", private: true, tid: 171, tag: "a,b", titleTemplate: "{name}_{date}" });
    expect(p.processing?.pipeline?.cleanup).toEqual({ stageSourceAfterMerge: true, sourceAfterDone: true, stageAfterDone: true });
  });

  it("never sends recording.enabled (the switch owns it; a stale editor must not overwrite it)", () => {
    const p = ok(payloadFromForm(formFromRoom(mkRoom({ recording: { enabled: false } })), ctx));
    expect(p.recording).toBeDefined();
    expect("enabled" in (p.recording ?? {})).toBe(false);
  });

  it("missing burn flags read as ON (backend default), not silently saved off", () => {
    const room = mkRoom({ processing: { pipeline: { upload: { mode: "stage" } } } as never });
    const p = ok(payloadFromForm(formFromRoom(room), ctx));
    expect(p.processing?.pipeline?.steps).toMatchObject({ burnDanmu: true, burnLivechat: true });
  });

  it("rule-only room: no recording half in the payload", () => {
    const p = ok(payloadFromForm(formFromRoom(mkRoom({ recording: null })), { ...ctx, hasRecording: false }));
    expect(p.recording).toBeUndefined();
    expect(p.processing).toBeDefined();
  });

  it("archive mode keeps the chosen format; upload mode locks to mp4 (original stays original)", () => {
    const f = { ...formFromRoom(mkRoom()), uploadOn: false, outputFormat: "mkv" as const };
    expect(ok(payloadFromForm(f, ctx)).recording?.outputFormat).toBe("mkv");
    expect(ok(payloadFromForm({ ...f, uploadOn: true }, ctx)).recording?.outputFormat).toBe("mp4");
  });

  it("rolling with burn on falls back to after-broadcast upload (rules decide, not the editor)", () => {
    const f = { ...formFromRoom(mkRoom()), method: "rolling" as const };
    expect(ok(payloadFromForm(f, ctx)).processing?.pipeline?.upload?.mode).toBe("upload");
    const noBurn = { ...f, burnDanmu: false, burnLivechat: false };
    expect(ok(payloadFromForm(noBurn, ctx)).processing?.pipeline?.upload?.mode).toBe("rolling");
  });

  it("empty schedule clears the window; malformed schedule is rejected", () => {
    const f = formFromRoom(mkRoom());
    expect(ok(payloadFromForm({ ...f, schedule: "" }, ctx)).recording).toMatchObject({ scheduleStart: null, scheduleEnd: null });
    expect(payloadFromForm({ ...f, schedule: "20:00" }, ctx)).toEqual({ ok: false, error: "schedule" });
  });
});
