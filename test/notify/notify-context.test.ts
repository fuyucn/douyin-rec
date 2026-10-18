// test/notify/notify-context.test.ts — issue #53 N1: notification context contract.
import { describe, it, expect } from "vitest";
import {
  contextForStream,
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
  it("hub enrichment keeps ctx on the event", () => {
    const lookup = { anchorOf: () => "A", workerName: () => undefined };
    const out = enrichHubEvent({ kind: "stageReady", streamKey: "douyin:abc:2026-10-16", ctx }, lookup);
    expect(out.ctx).toEqual(ctx);
  });
});
