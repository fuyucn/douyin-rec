import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_TITLE_TEMPLATES, blankForm, factsOf, formFromRoom, isValidPartSizeInput, isValidSeasonSectionIdInput, partSizePayload, payloadFromForm, ruleFactsOf, seasonSectionIdPatch, seasonSectionIdPayload, submitPayload, webhookPatch, type RoomContext } from "../../packages/web/src/lib/room-editor-form.js";
import { deriveConstraints, settledMethod } from "../../packages/web/src/lib/room-form-rules.js";
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

describe("task-only room save judges rolling as if the rule exists (#284)", () => {
  const taskOnly = () => formFromRoom({
    room: "1", platform: "douyin", processing: null,
    recording: { danmu: 1, quality: "origin", engine: "ffmpeg", segmentSec: 1800, useCookie: true },
  } as never);
  it("rolling + burn on falls back to upload even when ctx.hasRule is false", () => {
    const f = { ...taskOnly(), uploadOn: true, method: "rolling" as const, burnDanmu: true, workers: ["local"] };
    const r = payloadFromForm(f, { ...ctx, hasRule: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.processing?.pipeline?.upload?.mode).toBe("upload");
    expect(r.payload.processing?.pipeline?.steps?.burnDanmu).toBe(true);
  });
  it("the editor's settled method agrees with what save stores (no ROLLING offered then rewritten)", () => {
    const f = { ...taskOnly(), uploadOn: true, method: "rolling" as const, burnDanmu: true, workers: ["local"] };
    const noRule = { ...ctx, hasRule: false };
    expect(settledMethod(ruleFactsOf(f, noRule))).toBe("after");
    expect(deriveConstraints(ruleFactsOf(f, noRule)).rolling.locked).toBe(true);
    // Only the VERSIONS visibility keeps the real (display) rule presence.
    expect(factsOf(f, noRule).hasRule).toBe(false);
  });
});

function mkRoom(over: { recording?: Partial<NonNullable<RoomDTO["recording"]>> | null; processing?: Partial<NonNullable<RoomDTO["processing"]>> | null } = {}): RoomDTO {
  const recording = over.recording === null ? null : {
    taskId: 7, room: "https://live.douyin.com/1", name: "n", anchorName: null, quality: "origin", engine: "ffmpeg",
    danmu: 1, segmentSec: 1800, scheduleStart: "20:00", scheduleEnd: "02:00", enabled: true, useCookie: true,
    cookies: null, hasCookies: false, outDir: null, webhook: null, hasWebhook: false, rollingUpload: false, rollingEffective: false, outputFormat: "original",
    streamUpload: false, streamUploadSpool: true,
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
  it("seasonSectionId: empty inherits when never stored, clears when already stored, number when typed", () => {
    const fresh = mkRoom();
    const f1 = formFromRoom(fresh);
    expect(f1.seasonSectionIdStored).toBe(false);
    expect(ok(payloadFromForm(f1, ctx)).processing?.pipeline?.upload?.seasonSectionId).toBeUndefined();

    const cleared = mkRoom();
    (cleared.processing!.pipeline!.upload as { seasonSectionId?: number | null }).seasonSectionId = null;
    const f2 = formFromRoom(cleared);
    expect(f2.seasonSectionIdStored).toBe(true);
    expect(ok(payloadFromForm(f2, ctx)).processing?.pipeline?.upload?.seasonSectionId).toBeNull();

    const f3 = { ...formFromRoom(mkRoom()), seasonSectionId: "456" };
    expect(ok(payloadFromForm(f3, ctx)).processing?.pipeline?.upload?.seasonSectionId).toBe(456);
  });
  it("seasonSectionId: invalid values are rejected only while upload is on", () => {
    for (const value of ["-3", "0", "1.5", "1e3", "abc", String(Number.MAX_SAFE_INTEGER + 1)]) {
      expect(isValidSeasonSectionIdInput(value)).toBe(false);
    }
    expect(isValidSeasonSectionIdInput(" 456 ")).toBe(true);
    expect(seasonSectionIdPatch("", false)).toBeUndefined();
    expect(seasonSectionIdPatch("", true)).toBeNull();
    expect(seasonSectionIdPatch("456", false)).toBe(456);
    expect(seasonSectionIdPayload("-3", true)).toBeUndefined();
    expect(seasonSectionIdPayload("456", true)).toBe(456);
    const on = { ...formFromRoom(mkRoom()), uploadOn: true, seasonSectionId: "-3" };
    expect(payloadFromForm(on, ctx)).toEqual({ ok: false, error: "seasonSectionId" });
    const off = { ...formFromRoom(mkRoom()), uploadOn: false, seasonSectionId: "-3" };
    const r = payloadFromForm(off, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.payload.processing?.pipeline?.upload?.seasonSectionId).toBeUndefined();
  });
  it("part size: empty inherits/clears, range enforced, invalid blocks save only when upload is on", () => {
    expect(isValidPartSizeInput("")).toBe(true);
    for (const bad of ["99", "4097", "1.5", "-1", "abc"]) expect(isValidPartSizeInput(bad)).toBe(false);
    expect(partSizePayload("", false)).toBeUndefined();
    expect(partSizePayload("", true)).toBeNull();
    expect(partSizePayload("2048", false)).toBe(2048);
    expect(partSizePayload("99", true)).toBeUndefined();
    const on = { ...formFromRoom(mkRoom()), uploadOn: true, partSizeMiB: "99" };
    expect(payloadFromForm(on, ctx)).toEqual({ ok: false, error: "partSizeMiB" });
    const ok = payloadFromForm({ ...on, partSizeMiB: "2048" }, ctx);
    expect(ok.ok && ok.payload.processing?.pipeline?.upload?.partSizeMiB).toBe(2048);
  });
  it("round-trips stored fields without silently changing them", () => {
    const p = ok(payloadFromForm(formFromRoom(mkRoom()), ctx));
    expect(p.recording).toMatchObject({ name: "n", quality: "origin", engine: "ffmpeg", segmentSec: 1800, danmu: 1, useCookie: true, scheduleStart: "20:00", scheduleEnd: "02:00", outputFormat: "original" });
    // Untouched webhook field is omitted (= keep stored secret), not sent as null.
    expect(p.recording).not.toHaveProperty("webhook");
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

  it("zero-disk is saved only under rolling; leaving rolling clears it", () => {
    const f = { ...formFromRoom(mkRoom({ recording: { streamUpload: true, streamUploadSpool: false } })), method: "rolling" as const, burnDanmu: false, burnLivechat: false };
    const p = ok(payloadFromForm(f, ctx));
    expect(p.processing?.pipeline?.upload?.mode).toBe("rolling");
    expect(p.recording).toMatchObject({ streamUpload: true, streamUploadSpool: false });
    const q = ok(payloadFromForm({ ...f, method: "after" }, ctx));
    expect(q.recording).toMatchObject({ streamUpload: false });
  });

  it("empty schedule clears the window; malformed schedule is rejected", () => {
    const f = formFromRoom(mkRoom());
    expect(ok(payloadFromForm({ ...f, schedule: "" }, ctx)).recording).toMatchObject({ scheduleStart: null, scheduleEnd: null });
    expect(payloadFromForm({ ...f, schedule: "20:00" }, ctx)).toEqual({ ok: false, error: "schedule" });
  });
});

describe("webhookPatch (secret PATCH semantics, issue #47)", () => {
  it("untouched = omitted (keep), typed = replace, clear box = null", () => {
    expect(webhookPatch("", false)).toEqual({});
    expect(webhookPatch("   ", false)).toEqual({});
    expect(webhookPatch(" https://x/y ", false)).toEqual({ webhook: "https://x/y" });
    expect(webhookPatch("", true)).toEqual({ webhook: null });
    // typing a new value wins over a stale clear flag
    expect(webhookPatch("https://x/y", true)).toEqual({ webhook: "https://x/y" });
  });
});

describe("title templates are prefilled but clearing them keeps the old fallback", () => {
  const room = (upload: object) => ({
    room: "1", platform: "douyin",
    processing: { enabled: true, pipeline: { upload } },
    recording: { danmu: 1, quality: "origin", engine: "ffmpeg", segmentSec: 1800, useCookie: true },
  }) as never;
  it("empty stored templates show the shared defaults", () => {
    const f = formFromRoom(room({}));
    expect(f.titleTemplate).toBe(DEFAULT_TITLE_TEMPLATES.titleTemplate);
    expect(f.submissionTitleTemplate).toBe(DEFAULT_TITLE_TEMPLATES.submissionTitleTemplate);
    expect(f.partTitleTemplate).toBe(DEFAULT_TITLE_TEMPLATES.partTitleTemplate);
  });
  it("a stored template wins over the default", () => {
    expect(formFromRoom(room({ titleTemplate: "{name}_{date}" })).titleTemplate).toBe("{name}_{date}");
  });
  it("user-cleared fields are sent as unset so the backend fallback applies", () => {
    const f = { ...formFromRoom(room({})), uploadOn: true, titleTemplate: "", submissionTitleTemplate: "", partTitleTemplate: "" };
    const r = payloadFromForm(f, ctx);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const u = r.payload.processing?.pipeline?.upload;
    expect(u?.titleTemplate).toBeUndefined();
    expect(u?.submissionTitleTemplate).toBeUndefined();
    expect(u?.partTitleTemplate).toBeUndefined();
  });
});

describe("新增 = 编辑同一弹窗:create 与 edit 共用一条提交路径", () => {
  const plat = { defaultQuality: "origin", defaultEngine: "ffmpeg" };
  const emptyRoom = () => formFromRoom({ key: "", platform: "douyin", roomSlug: "", room: "", recording: null, processing: null });

  it("blankForm 与「编辑一个空房间」完全一致,只有 room 空着、弹幕默认开", () => {
    const b = blankForm(plat);
    expect(b).toEqual({ ...emptyRoom(), room: "", danmu: true, quality: "origin", engine: "ffmpeg" });
    expect(b).toMatchObject({ segmentSec: "1800", useCookie: true, tid: "21", uploadOn: false, procEnabled: true });
    expect(b.titleTemplate).toBe(DEFAULT_TITLE_TEMPLATES.titleTemplate);
    // 平台未识别时 quality/engine 留空,待识别后补默认
    expect(blankForm()).toMatchObject({ quality: "", engine: "" });
  });

  it("create 必填直播间地址;其余校验与 edit 同一套(schedule 报同一错)", () => {
    expect(submitPayload(blankForm(plat), ctx, { mode: "create", withProcessing: true })).toEqual({ ok: false, error: "room" });
    expect(submitPayload({ ...blankForm(plat), room: "   " }, ctx, { mode: "create", withProcessing: true })).toEqual({ ok: false, error: "room" });
    expect(submitPayload({ ...blankForm(plat), room: "100001", schedule: "20:00" }, ctx, { mode: "create", withProcessing: true }))
      .toEqual({ ok: false, error: "schedule" });
  });

  it("create 一次写两半:recording.room 去空白,master 带 processing", () => {
    const r = submitPayload({ ...blankForm(plat), room: " https://live.douyin.com/100001 " }, ctx, { mode: "create", withProcessing: true });
    if (!r.ok) throw new Error("expected ok");
    expect(r.mode).toBe("create");
    expect(r.payload.recording.room).toBe("https://live.douyin.com/100001");
    expect(r.payload.recording).toMatchObject({ segmentSec: 1800, danmu: 1, useCookie: true, outputFormat: "original" });
    expect(r.payload.processing).toBeDefined();
  });

  it("worker(无 editPipeline)create/edit 都不发 processing(规则只在主控生效)", () => {
    const c = submitPayload({ ...blankForm(plat), room: "100001" }, ctx, { mode: "create", withProcessing: false });
    if (!c.ok) throw new Error("expected ok");
    expect("processing" in c.payload).toBe(false);
    expect(c.payload.recording).toBeDefined();

    const e = submitPayload(formFromRoom(mkRoom()), ctx, { mode: "edit", withProcessing: false });
    if (!e.ok) throw new Error("expected ok");
    expect("processing" in e.payload).toBe(false);
    // worker 仍能写录制半边
    expect(e.payload.recording).toMatchObject({ quality: "origin", engine: "ffmpeg" });
  });

  it("edit 的 payload 不带 room(存量地址不回写,避免房间校验副作用)", () => {
    const f = formFromRoom(mkRoom()); // 存量 room = https://live.douyin.com/1
    const r = submitPayload(f, ctx, { mode: "edit", withProcessing: true });
    if (!r.ok) throw new Error("expected ok");
    expect(r.mode).toBe("edit");
    expect(r.payload).not.toHaveProperty("room");
    expect(r.payload.recording && "room" in r.payload.recording).toBe(false);
    expect(r.payload.processing).toBeDefined();
  });
});

describe("新增房间的接线(T-157:建房间不自动开播)", () => {
  const src = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "modals", "RoomEditor.tsx"), "utf-8");

  it("走 POST /api/rooms 一次写两半,并提示「已创建(默认暂停)」", () => {
    expect(src).toContain("api.createRoom(r.payload)");
    expect(src).toContain('toast(t("room.addedPaused"), "success")');
    expect(src).toContain("findExistingRoom(");
  });

  it("从不调用 startTask(开录是显式动作)", () => {
    expect(src).not.toContain("api.startTask(");
  });

  it("创建成功的文案中英都有", () => {
    const dict = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "lib", "i18n.tsx"), "utf-8");
    expect(dict.match(/\baddedPaused\s*:/g) ?? []).toHaveLength(2);
  });
});
