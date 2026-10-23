import { describe, expect, it } from "vitest";
import { effectiveReconnectWindowMs, isSameBroadcast, SAME_BROADCAST_GAP_MS } from "../../packages/core/src/broadcast-window.js";

describe("isSameBroadcast (issue #320)", () => {
  it("both live ids known: the ids decide, the gap does not", () => {
    expect(isSameBroadcast({ aLiveId: "a", bLiveId: "b", gapMs: 60_000 })).toBe(false);
    expect(isSameBroadcast({ aLiveId: "a", bLiveId: "a", gapMs: SAME_BROADCAST_GAP_MS * 3 })).toBe(true);
  });
  it("either id missing: the 30-minute gap rule", () => {
    expect(isSameBroadcast({ aLiveId: "a", bLiveId: null, gapMs: SAME_BROADCAST_GAP_MS })).toBe(true);
    expect(isSameBroadcast({ gapMs: SAME_BROADCAST_GAP_MS + 1 })).toBe(false);
  });
});

describe("effectiveReconnectWindowMs", () => {
  it("raises values below the 30-minute constant and flags them", () => {
    expect(effectiveReconnectWindowMs(600_000)).toEqual({ ms: SAME_BROADCAST_GAP_MS, clamped: true });
  });
  it("passes a larger configured window through unchanged (an old 60-minute config stays 60)", () => {
    expect(effectiveReconnectWindowMs(45 * 60_000)).toEqual({ ms: 45 * 60_000, clamped: false });
    expect(effectiveReconnectWindowMs(3_600_000)).toEqual({ ms: 3_600_000, clamped: false });
  });
  it("undefined falls back to the constant; <= 0 means disabled", () => {
    expect(effectiveReconnectWindowMs(undefined)).toEqual({ ms: SAME_BROADCAST_GAP_MS, clamped: false });
    expect(effectiveReconnectWindowMs(0)).toEqual({ ms: 0, clamped: false });
  });
});
