import { describe, expect, it } from "vitest";
import {
  LIVE_EVENT_LIMIT,
  LIVE_PART_LIMIT,
  capLiveUploadSnapshot,
  normalizeLiveUploadSnapshot,
  type LiveUploadSnapshot,
} from "./live-upload.js";

const GOOD: LiveUploadSnapshot = {
  schemaVersion: 1,
  mode: "zero-disk",
  sessionId: "room:1",
  createdAt: 10,
  platform: "douyin",
  roomSlug: "1",
  state: "streaming",
  startedAt: 10,
  updatedAt: 20,
  currentPart: { index: 0, phase: "streaming", uploadedBytes: 100, chunks: 1 },
  parts: [{ index: 0, phase: "streaming", uploadedBytes: 100, chunks: 1 }],
  events: [{ at: 10, kind: "run_start", session: { sessionId: "room:1", createdAt: 10, resumed: false } }],
};

describe("normalizeLiveUploadSnapshot", () => {
  it("keeps a valid snapshot and accepts waiting without a session", () => {
    expect(normalizeLiveUploadSnapshot(GOOD)?.sessionId).toBe("room:1");
    const waiting = normalizeLiveUploadSnapshot({ ...GOOD, sessionId: undefined, createdAt: undefined, state: "waiting", events: [] });
    expect(waiting?.state).toBe("waiting");
    expect(waiting?.sessionId).toBeUndefined();
  });

  it("drops bad parts/events instead of failing the snapshot", () => {
    const r = normalizeLiveUploadSnapshot({ ...GOOD, parts: [GOOD.parts[0], { index: "x" }], events: [GOOD.events[0], { at: 5, kind: "nope" }] });
    expect(r?.parts).toHaveLength(1);
    expect(r?.events).toHaveLength(1);
  });

  it("caps and sorts events, caps parts", () => {
    const events = Array.from({ length: 1000 }, (_, i) => ({ at: 1000 - i, kind: "live" as const }));
    const parts = Array.from({ length: 800 }, (_, i) => ({ index: i, phase: "confirmed" as const, uploadedBytes: 1, chunks: 1 }));
    const r = normalizeLiveUploadSnapshot({ ...GOOD, events, parts });
    expect(r?.events).toHaveLength(LIVE_EVENT_LIMIT);
    expect(r?.events[0]?.at).toBeLessThan(r!.events.at(-1)!.at);
    expect(r?.parts).toHaveLength(LIVE_PART_LIMIT);
  });

  it("returns null for a bad root and never throws", () => {
    expect(normalizeLiveUploadSnapshot(null)).toBeNull();
    expect(normalizeLiveUploadSnapshot({ ...GOOD, schemaVersion: 2 })).toBeNull();
    expect(normalizeLiveUploadSnapshot({ ...GOOD, state: "weird" })).toBeNull();
  });

  it("caps report copies more tightly", () => {
    const r = capLiveUploadSnapshot(GOOD);
    expect(r.events.length).toBeLessThanOrEqual(100);
    expect(r.parts.length).toBeLessThanOrEqual(200);
  });
});
