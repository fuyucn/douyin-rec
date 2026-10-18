// test/notify/notify-context.test.ts — issue #53 N1: notification context contract.
import { describe, it, expect } from "vitest";
import {
  contextForStream,
  decorateRecordEvent,
  parseStreamKey,
  resolveDisplayName,
  type NotifyContext,
  type NotifyEvent,
} from "../../packages/core/src/index.js";
import { formatMessage } from "../../packages/observability/src/notifier/index.js";
import { enrichHubEvent, parseStreamKey as obsParse } from "../../packages/observability/src/notifier/hub-label.js";

describe("parseStreamKey (core)", () => {
  it("parses date and the same-day time suffix; rejects other shapes", () => {
    expect(parseStreamKey("douyin:abc:2026-10-16")).toEqual({ platform: "douyin", roomSlug: "abc", date: "2026-10-16" });
    expect(parseStreamKey("bilibili:42:2026-10-16_2130")).toEqual({ platform: "bilibili", roomSlug: "42", date: "2026-10-16", time: "21:30" });
    expect(parseStreamKey("douyin:abc")).toBeNull();
    expect(parseStreamKey("douyin:abc:2026-10-16_21301")).toBeNull();
  });
  it("observability re-exports the same function (single implementation)", () => {
    expect(obsParse).toBe(parseStreamKey);
  });
});

describe("resolveDisplayName — single priority chain", () => {
  const all = {
    taskName: "T", liveAnchor: "L", cachedAnchor: "C", ledgerAnchor: "G",
    sessionBase: "S_2026-10-16_21-30-00", platform: "douyin", roomSlug: "abc",
  };
  it("walks task → live → cached → ledger → session → fallback", () => {
    expect(resolveDisplayName(all)).toEqual({ name: "T", source: "task" });
    expect(resolveDisplayName({ ...all, taskName: null })).toEqual({ name: "L", source: "live" });
    expect(resolveDisplayName({ ...all, taskName: "", liveAnchor: undefined })).toEqual({ name: "C", source: "cached" });
    expect(resolveDisplayName({ ...all, taskName: null, liveAnchor: null, cachedAnchor: null }))
      .toEqual({ name: "G", source: "ledger" });
    expect(resolveDisplayName({ sessionBase: "S_2026-10-16_21-30-00", platform: "douyin", roomSlug: "abc" }))
      .toEqual({ name: "S", source: "session" });
    expect(resolveDisplayName({ platform: "douyin", roomSlug: "abc" })).toEqual({ name: "douyin abc", source: "fallback" });
  });
  it("blank values are skipped, not used", () => {
    expect(resolveDisplayName({ taskName: "   ", liveAnchor: "\t", cachedAnchor: "C" })).toEqual({ name: "C", source: "cached" });
  });
  it("a session base without a date stamp is not a name; nothing known → placeholder", () => {
    expect(resolveDisplayName({ sessionBase: "no-stamp", roomSlug: "abc" })).toEqual({ name: "abc", source: "fallback" });
    expect(resolveDisplayName({})).toEqual({ name: "未知直播间", source: "fallback" });
  });
});

describe("contextForStream", () => {
  it("fills platform / room / date / time from the key and resolves the name", () => {
    expect(contextForStream("bilibili:42:2026-10-16_2130", { cachedAnchor: "C" })).toEqual({
      name: "C", nameSource: "cached", streamKey: "bilibili:42:2026-10-16_2130",
      platform: "bilibili", roomSlug: "42", date: "2026-10-16", time: "21:30",
    });
  });
  it("an unparseable key keeps the raw key but never uses it as the name", () => {
    const ctx = contextForStream("garbage");
    expect(ctx).toEqual({ name: "未知直播间", nameSource: "fallback", streamKey: "garbage" });
  });
});

describe("old events render exactly as before (ctx is ignored until renderers opt in)", () => {
  const ctx: NotifyContext = { name: "N", platform: "douyin", roomSlug: "abc", date: "2026-10-16", step: "merge", result: "error", next: "retry" };
  const events: NotifyEvent[] = [
    { kind: "recordStart", anchor: "A", room: "123", quality: "origin" },
    { kind: "recordEnd", anchor: "A", room: "123", outDir: "/o", reason: "下播" },
    { kind: "recordReconnect", anchor: "A", room: "123", downSec: 5 },
    { kind: "mergeDone", file: "/o/x.mp4" },
    { kind: "burnDone", style: "danmu", file: "/o/x_danmu.mp4" },
    { kind: "uploadDone", bv: "BV1x", url: "https://b/BV1x", streamKey: "douyin:abc:2026-10-16" },
    { kind: "hubTaskStart", streamKey: "douyin:abc:2026-10-16", room: "abc", workers: ["w1"], mode: "upload" },
    { kind: "stageReady", streamKey: "douyin:abc:2026-10-16" },
    { kind: "error", stage: "burn", message: "boom" },
  ];
  for (const e of events) {
    it(`${e.kind}: same text with or without ctx`, () => {
      expect(formatMessage({ ...e, ctx })).toBe(formatMessage(e));
    });
  }
  it("hub enrichment keeps an explicit ctx on the event", () => {
    const lookup = { anchorOf: () => "A", workerName: () => undefined };
    const out = enrichHubEvent({ kind: "stageReady", streamKey: "douyin:abc:2026-10-16", ctx }, lookup);
    // Explicit fields win; enrichment only adds what was missing (the key), without a mismatched name source.
    expect(out.ctx).toEqual({ ...ctx, streamKey: "douyin:abc:2026-10-16" });
  });
  it("ctx merge: a caller source without a name is dropped; an explicit undefined does not erase", () => {
    const lookup = { anchorOf: () => "A", workerName: () => undefined };
    const out = enrichHubEvent(
      { kind: "stageReady", streamKey: "douyin:abc:2026-10-16", ctx: { nameSource: "task", date: undefined, step: "merge" } },
      lookup,
    );
    expect(out.ctx).toMatchObject({ name: "A", nameSource: "cached", date: "2026-10-16", step: "merge" });
  });
});

describe("decorateRecordEvent (#53 N4)", () => {
  const facts = { taskName: "T", liveAnchor: "L", platform: "douyin", roomSlug: "abc" };
  it("record events show the resolved name and carry ctx", () => {
    const e = decorateRecordEvent({ kind: "recordStart", anchor: "L", room: "u", quality: "origin" } as NotifyEvent, facts);
    expect(e).toMatchObject({ anchor: "T", ctx: { name: "T", nameSource: "task", platform: "douyin", roomSlug: "abc" } });
  });
  it("other events get ctx but no anchor field", () => {
    const e = decorateRecordEvent({ kind: "error", stage: "弹幕", message: "m" } as NotifyEvent, facts);
    expect(e).not.toHaveProperty("anchor");
    expect(e.ctx).toMatchObject({ name: "T" });
  });
  it("no real name: keep the event's own anchor text; explicit ctx fields win", () => {
    const e = decorateRecordEvent(
      { kind: "recordEnd", anchor: "", room: "u", outDir: "/o", ctx: { step: "record" } } as NotifyEvent,
      { platform: "douyin", roomSlug: "abc" },
    );
    expect(e).toMatchObject({ anchor: "", ctx: { name: "douyin abc", nameSource: "fallback", step: "record" } });
  });
});
