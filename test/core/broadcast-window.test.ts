import { describe, expect, it } from "vitest";
import { isSameBroadcast, SAME_BROADCAST_GAP_MS } from "../../packages/core/src/broadcast-window.js";

describe("isSameBroadcast (issue #320)", () => {
  it("both live ids known: the ids decide, the gap does not", () => {
    expect(isSameBroadcast({ aLiveId: "a", bLiveId: "b", gapMs: 60_000 })).toBe(false);
    expect(isSameBroadcast({ aLiveId: "a", bLiveId: "a", gapMs: SAME_BROADCAST_GAP_MS * 3 })).toBe(true);
  });
  it("either id missing: the 60-minute gap rule", () => {
    expect(isSameBroadcast({ aLiveId: "a", bLiveId: null, gapMs: SAME_BROADCAST_GAP_MS })).toBe(true);
    expect(isSameBroadcast({ gapMs: SAME_BROADCAST_GAP_MS + 1 })).toBe(false);
  });
});
