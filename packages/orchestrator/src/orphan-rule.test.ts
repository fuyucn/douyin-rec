// packages/orchestrator/src/orphan-rule.test.ts
import { describe, it, expect } from "vitest";
import {
  DEFAULT_SEGMENT_SEC, ORPHAN_SLACK_MS, findDoneOverlap, matchOrphans, orphanWindows, parseStreamKeyRoom,
  spanOf, toDoneWindow, type BroadcastSpan, type DoneWindow, type OrphanWindow,
} from "./orphan-rule.js";
import type { Broadcast } from "./identity.js";
import type { UnclaimedSegment } from "./unclaimed.js";

const T = Date.UTC(2026, 5, 20, 1, 0, 0);
const MIN = 60_000;

function seg(over: Partial<UnclaimedSegment> = {}): UnclaimedSegment {
  return {
    path: "/r/a_000.mp4", sizeBytes: 1, mtimeMs: T, sessionBase: "a", segmentIndex: 0,
    stampMs: T, stampSource: "sidecar", sidecar: "full", platform: "douyin", roomSlug: "123", segmentSec: 600,
    ...over,
  };
}

function win(over: Partial<OrphanWindow> = {}): OrphanWindow {
  return {
    workerId: "w1", sessionBase: "a", platform: "douyin", roomSlug: "123",
    startMs: T, endMs: T + 30 * MIN, segmentCount: 1, paths: ["/r/a_000.mp4"], ...over,
  };
}

function span(over: Partial<BroadcastSpan> = {}): BroadcastSpan {
  return { streamKey: "douyin:123:2026-06-20", platform: "douyin", roomSlug: "123", startMs: T, endMs: T + 60 * MIN, ...over };
}

describe("orphanWindows", () => {
  it("in-range mtimes: start = stamp, end = max mtime", () => {
    const segs = [0, 1, 2].map((i) => seg({ segmentIndex: i, path: `/r/a_00${i}.mp4`, mtimeMs: T + (i + 1) * 10 * MIN }));
    const [w] = orphanWindows("w1", segs);
    expect(w).toMatchObject({ workerId: "w1", sessionBase: "a", platform: "douyin", roomSlug: "123", startMs: T, endMs: T + 30 * MIN, segmentCount: 3 });
    expect(w.paths).toEqual(["/r/a_000.mp4", "/r/a_001.mp4", "/r/a_002.mp4"]);
  });

  it("a far-future mtime is capped at stamp + (maxIdx + 1) * segmentSec + slack", () => {
    const segs = [0, 1, 2].map((i) => seg({ segmentIndex: i, mtimeMs: i === 2 ? T + 24 * 60 * MIN : T + i * MIN }));
    expect(orphanWindows("w1", segs)[0].endMs).toBe(T + 3 * 600_000 + ORPHAN_SLACK_MS);
  });

  it("segmentSec null falls back to the default segment length", () => {
    const segs = [seg({ segmentSec: null, segmentIndex: 0, mtimeMs: T + 1e12 })];
    expect(orphanWindows("w1", segs)[0].endMs).toBe(T + DEFAULT_SEGMENT_SEC * 1000 + ORPHAN_SLACK_MS);
  });

  it("mtime before the stamp clamps end to the stamp", () => {
    expect(orphanWindows("w1", [seg({ mtimeMs: T - 10 * MIN })])[0].endMs).toBe(T);
  });

  it("stampMs null -> null window (alert-only)", () => {
    const [w] = orphanWindows("w1", [seg({ stampMs: null, stampSource: null })]);
    expect(w.startMs).toBeNull();
    expect(w.endMs).toBeNull();
  });

  it("room = first non-null pair; null when no segment has one", () => {
    const withRoom = orphanWindows("w1", [seg({ platform: null, roomSlug: null }), seg({ segmentIndex: 1, platform: "bilibili", roomSlug: "9" })]);
    expect(withRoom[0]).toMatchObject({ platform: "bilibili", roomSlug: "9" });
    const noRoom = orphanWindows("w1", [seg({ platform: "douyin", roomSlug: null })]);
    expect(noRoom[0]).toMatchObject({ platform: null, roomSlug: null });
  });

  it("groups by sessionBase and sorts output by sessionBase", () => {
    const out = orphanWindows("w1", [seg({ sessionBase: "b" }), seg({ sessionBase: "a" }), seg({ sessionBase: "b", segmentIndex: 1 })]);
    expect(out.map((w) => [w.sessionBase, w.segmentCount])).toEqual([["a", 1], ["b", 2]]);
    expect(orphanWindows("w1", [])).toEqual([]);
  });
});

describe("spanOf", () => {
  it("end = max member endMs; no members -> startMs", () => {
    const rec = (endMs: number) => ({ roomSlug: "123", platform: "douyin", sessionBase: "a", tsFiles: [], startMs: T, endMs }) as never;
    const b: Broadcast = { streamKey: "k", platform: "douyin", roomSlug: "123", startMs: T, members: [
      { workerId: "w1", rec: rec(T + 5 * MIN) }, { workerId: "w2", rec: rec(T + 9 * MIN) },
    ] };
    expect(spanOf(b)).toEqual({ streamKey: "k", platform: "douyin", roomSlug: "123", startMs: T, endMs: T + 9 * MIN });
    expect(spanOf({ ...b, members: [] }).endMs).toBe(T);
  });
});

describe("matchOrphans", () => {
  it("overlapping same-room window lands under that streamKey", () => {
    const { overlapByKey, unmatched } = matchOrphans([win()], [span()]);
    expect(overlapByKey.get("douyin:123:2026-06-20")).toEqual([win()]);
    expect(unmatched).toEqual([]);
  });

  it("same time, different room or platform -> unmatched", () => {
    const { overlapByKey, unmatched } = matchOrphans([win({ roomSlug: "999" }), win({ sessionBase: "b", platform: "bilibili" })], [span()]);
    expect(overlapByKey.size).toBe(0);
    expect(unmatched.map((w) => w.sessionBase)).toEqual(["a", "b"]);
  });

  it("null room or null window -> unmatched", () => {
    const { unmatched } = matchOrphans([win({ platform: null, roomSlug: null }), win({ sessionBase: "b", startMs: null, endMs: null })], [span()]);
    expect(unmatched).toHaveLength(2);
  });

  it("gap exactly at tolerance matches; one ms beyond is unmatched", () => {
    const s = span({ startMs: T, endMs: T + 10 * MIN });
    const atTol = win({ startMs: T + 10 * MIN + ORPHAN_SLACK_MS, endMs: T + 40 * MIN });
    const beyond = win({ startMs: T + 10 * MIN + ORPHAN_SLACK_MS + 1, endMs: T + 40 * MIN });
    expect(matchOrphans([atTol], [s]).unmatched).toEqual([]);
    expect(matchOrphans([beyond], [s]).unmatched).toEqual([beyond]);
    const before = win({ startMs: T - 40 * MIN, endMs: T - ORPHAN_SLACK_MS - 1 });
    expect(matchOrphans([before], [s]).unmatched).toEqual([before]);
  });

  it("a window overlapping two spans is added to both", () => {
    const a = span({ streamKey: "k1", endMs: T + 10 * MIN });
    const b = span({ streamKey: "k2", startMs: T + 20 * MIN, endMs: T + 40 * MIN });
    const { overlapByKey, unmatched } = matchOrphans([win()], [a, b]);
    expect([...overlapByKey.keys()].sort()).toEqual(["k1", "k2"]);
    expect(unmatched).toEqual([]);
  });
});

describe("parseStreamKeyRoom / toDoneWindow", () => {
  it("parses platform and roomSlug, with or without the _HHMM suffix", () => {
    expect(parseStreamKeyRoom("douyin:123:2026-06-20_0130")).toEqual({ platform: "douyin", roomSlug: "123" });
    expect(parseStreamKeyRoom("douyin:123:2026-06-20")).toEqual({ platform: "douyin", roomSlug: "123" });
  });

  it("roomSlug with colon splits at the first and last ':'", () => {
    expect(parseStreamKeyRoom("x:a:b:2026-06-20")).toEqual({ platform: "x", roomSlug: "a:b" });
  });

  it("fewer than two colons or empty roomSlug -> null", () => {
    expect(parseStreamKeyRoom("douyin")).toBeNull();
    expect(parseStreamKeyRoom("douyin:2026-06-20")).toBeNull();
    expect(parseStreamKeyRoom("douyin::2026-06-20")).toBeNull();
  });

  it("endMs null falls back to startMs; null startMs or bad key -> null", () => {
    expect(toDoneWindow({ streamKey: "douyin:123:2026-06-20", startMs: T, endMs: null }))
      .toEqual({ streamKey: "douyin:123:2026-06-20", platform: "douyin", roomSlug: "123", startMs: T, endMs: T });
    expect(toDoneWindow({ streamKey: "douyin:123:2026-06-20", startMs: T, endMs: T + MIN })?.endMs).toBe(T + MIN);
    expect(toDoneWindow({ streamKey: "douyin:123:2026-06-20", startMs: null, endMs: T })).toBeNull();
    expect(toDoneWindow({ streamKey: "bad", startMs: T, endMs: T })).toBeNull();
  });
});

describe("findDoneOverlap", () => {
  const done = (over: Partial<DoneWindow> = {}): DoneWindow => ({
    streamKey: "douyin:123:2026-06-20_0100", platform: "douyin", roomSlug: "123", startMs: T, endMs: T + 30 * MIN, ...over,
  });

  it("overlapping done job of the same room under another key is returned", () => {
    expect(findDoneOverlap(span(), [done()])).toEqual(done());
  });

  it("same streamKey, other room, or beyond tolerance -> null", () => {
    expect(findDoneOverlap(span(), [done({ streamKey: "douyin:123:2026-06-20" })])).toBeNull();
    expect(findDoneOverlap(span(), [done({ roomSlug: "999" })])).toBeNull();
    expect(findDoneOverlap(span(), [done({ platform: "bilibili" })])).toBeNull();
    const far = T + 60 * MIN + ORPHAN_SLACK_MS + 1;
    expect(findDoneOverlap(span(), [done({ startMs: far, endMs: far + MIN })])).toBeNull();
  });

  it("strict overlap, no tolerance: a restart 3 minutes after the done end is a new broadcast", () => {
    const d = done({ startMs: T - 60 * MIN, endMs: T - 3 * MIN });
    expect(findDoneOverlap(span(), [d])).toBeNull();
    const before = done({ startMs: T + 63 * MIN, endMs: T + 90 * MIN });
    expect(findDoneOverlap(span(), [before])).toBeNull();
  });

  it("a span starting inside the done window is matched", () => {
    const d = done({ startMs: T - 30 * MIN, endMs: T + 1 });
    expect(findDoneOverlap(span(), [d])).toEqual(d);
  });

  it("touching boundaries do not overlap on either side", () => {
    expect(findDoneOverlap(span(), [done({ startMs: T - 30 * MIN, endMs: T })])).toBeNull();
    expect(findDoneOverlap(span(), [done({ startMs: T + 60 * MIN, endMs: T + 90 * MIN })])).toBeNull();
  });

  it("returns the earliest overlapping done window by startMs", () => {
    const late = done({ streamKey: "douyin:123:2026-06-20_0130", startMs: T + 30 * MIN, endMs: T + 50 * MIN });
    const early = done({ streamKey: "douyin:123:2026-06-20_0050", startMs: T - 10 * MIN, endMs: T + 5 * MIN });
    expect(findDoneOverlap(span(), [late, early])?.streamKey).toBe("douyin:123:2026-06-20_0050");
  });
});
