/**
 * notification-text.test.ts — issue #53 N6: in-app toast text renders the structured context.
 */
import { describe, it, expect } from "vitest";
import { describeEvent } from "../../packages/web/src/lib/notification-text";
import type { AppEventDTO } from "../../packages/core/src/api-types";

/** Fake i18n: key + sorted vars, so assertions see exactly what was passed. */
const t = (key: string, vars?: Record<string, string | number>): string =>
  `${key}${vars ? JSON.stringify(Object.fromEntries(Object.entries(vars).sort())) : ""}`;
const ev = (event: Record<string, unknown>): AppEventDTO => ({ id: 1, at: 0, taskId: null, event } as unknown as AppEventDTO);

describe("describeEvent (#53 N6)", () => {
  it("events without ctx render exactly as before", () => {
    expect(describeEvent(ev({ kind: "error", stage: "burn", message: "boom" }), t))
      .toEqual({ key: "error", message: 'notif.evError{"message":"boom","stage":"burn"}', type: "error" });
    expect(describeEvent(ev({ kind: "hubTaskStart", streamKey: "k", room: "123", workers: ["a", "b"], mode: "upload" }), t)!.message)
      .toBe('notif.evHubStart{"count":2,"room":"123"}');
    expect(describeEvent(ev({ kind: "uploadDone", bv: "BV1x", url: "u" }), t)!.message).toBe('notif.evUpload{"bv":"BV1x"}');
    expect(describeEvent(ev({ kind: "recordStart", anchor: "A", room: "r", quality: "q" }), t)!.message).toBe('notif.evLive{"anchor":"A"}');
  });
  it("error with ctx names the room and appends the next step", () => {
    const d = describeEvent(ev({ kind: "error", stage: "弹幕", message: "m", ctx: { name: "小苏", next: "检查登录" } }), t)!;
    expect(d.message).toBe('notif.evErrorNamed{"message":"m","name":"小苏","stage":"弹幕"} notif.next{"next":"检查登录"}');
  });
  it("hub events use ctx name + date/time over the raw room", () => {
    const d = describeEvent(ev({ kind: "hubTaskStart", streamKey: "k", room: "123", workers: ["a"], mode: "upload",
      ctx: { name: "小苏", date: "2026-10-16", time: "21:30" } }), t)!;
    expect(d.message).toBe('notif.evHubStart{"count":1,"room":"小苏 · 2026-10-16 21:30"}');
    expect(describeEvent(ev({ kind: "uploadDone", bv: "BV1x", url: "u", ctx: { name: "小苏", date: "2026-10-16" } }), t)!.message)
      .toBe('notif.evUpload{"bv":"小苏 · 2026-10-16 · BV1x"}');
  });
  it("stageReady now produces a toast (it was silently dropped)", () => {
    expect(describeEvent(ev({ kind: "stageReady", streamKey: "douyin:1:2026-10-16", ctx: { name: "小苏", date: "2026-10-16" } }), t))
      .toEqual({ key: "merge", message: 'notif.evStageReady{"room":"小苏 · 2026-10-16"}', type: "success" });
    expect(describeEvent(ev({ kind: "stageReady", streamKey: "douyin:1:2026-10-16" }), t)!.message)
      .toBe('notif.evStageReady{"room":"douyin:1:2026-10-16"}');
  });
  it("record events fall back to ctx name when the anchor is empty; malformed ctx is ignored", () => {
    expect(describeEvent(ev({ kind: "recordEnd", anchor: "", room: "r", outDir: "/o", ctx: { name: "小苏" } }), t)!.message)
      .toBe('notif.evRecordEnd{"anchor":"小苏","reason":""}');
    expect(describeEvent(ev({ kind: "error", stage: "s", message: "m", ctx: ["x"] }), t)!.message)
      .toBe('notif.evError{"message":"m","stage":"s"}');
    expect(describeEvent(ev({ kind: "error", stage: "s", message: "m", ctx: { name: 5 } }), t)!.message)
      .toBe('notif.evError{"message":"m","stage":"s"}');
  });
});

describe("describeEvent: deliberate changes for events without ctx (#53 N6 review)", () => {
  it("record events with an empty anchor fall back to the room instead of rendering blank", () => {
    expect(describeEvent(ev({ kind: "recordStart", anchor: "", room: "r1", quality: "q" }), t)!.message).toBe('notif.evLive{"anchor":"r1"}');
  });
  it("upload done from an enriched event shows the date too (anchor · date · BV)", () => {
    expect(describeEvent(ev({ kind: "uploadDone", bv: "BV1x", url: "u", anchor: "A", date: "2026-10-16" }), t)!.message)
      .toBe('notif.evUpload{"bv":"A · 2026-10-16 · BV1x"}');
  });
  it("one name priority: resolved ctx name wins over the anchor for record and hub events alike", () => {
    const ctx = { name: "任务名", nameSource: "task" };
    expect(describeEvent(ev({ kind: "recordStart", anchor: "主播", room: "r", quality: "q", ctx }), t)!.message).toBe('notif.evLive{"anchor":"任务名"}');
    expect(describeEvent(ev({ kind: "hubTaskStart", room: "r", workers: [], anchor: "主播", ctx }), t)!.message).toContain("任务名");
  });
  it("a fallback ctx name never outranks the anchor and never prefixes an error", () => {
    const ctx = { name: "未知直播间", nameSource: "fallback" };
    expect(describeEvent(ev({ kind: "recordStart", anchor: "主播", room: "r", quality: "q", ctx }), t)!.message).toBe('notif.evLive{"anchor":"主播"}');
    expect(describeEvent(ev({ kind: "recordStart", anchor: "", room: "r", quality: "q", ctx }), t)!.message).toBe('notif.evLive{"anchor":"未知直播间"}');
    expect(describeEvent(ev({ kind: "error", stage: "s", message: "m", ctx }), t)!.message).toMatch(/^notif\.evError\{/);
  });
  it("hub session label prefers the anchor over a fallback ctx name", () => {
    const ctx = { name: "未知直播间", nameSource: "fallback", date: "2026-10-18" };
    expect(describeEvent(ev({ kind: "hubTaskStart", room: "r", workers: [], anchor: "主播", ctx }), t)!.message).toContain("主播 · 2026-10-18");
  });
});
