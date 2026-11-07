import { describe, expect, it } from "vitest";
import { applyLiveEvent, applyProgress, createLiveRunTracker } from "./live-upload-tracker.js";
import type { LiveEvent } from "./live-upload.js";

const ev = (at: number, kind: LiveEvent["kind"], extra: Partial<LiveEvent> = {}): LiveEvent => ({ at, kind, ...extra });
const session = (id: string, createdAt: number, resumed = false) => ({ sessionId: id, createdAt, resumed });

describe("LiveRunTracker", () => {
  it("starts sessionless and binds a waiting snapshot in place", () => {
    let s = createLiveRunTracker({ mode: "zero-disk", platform: "douyin", roomSlug: "1", now: 1 });
    expect(s.current.state).toBe("waiting");
    expect(s.current.sessionId).toBeUndefined();
    s = applyLiveEvent(s, ev(2, "waiting"));
    s = applyLiveEvent(s, ev(3, "run_start", { session: session("1:10", 10) }));
    expect(s.current.sessionId).toBe("1:10");
    expect(s.current.events.map((e) => e.kind)).toEqual(["waiting", "run_start"]);
  });

  it("walks streaming -> sealing -> submitting -> confirmed", () => {
    let s = createLiveRunTracker({ mode: "zero-disk", platform: "douyin", roomSlug: "1", now: 1 });
    s = applyLiveEvent(s, ev(2, "run_start", { session: session("1:10", 10) }));
    s = applyLiveEvent(s, ev(3, "part_streaming", { part: 0 }));
    expect(s.current.currentPart?.phase).toBe("streaming");
    s = applyLiveEvent(s, ev(4, "part_sealed", { part: 0, bytes: 100 }));
    expect(s.current.currentPart?.phase).toBe("sealing");
    s = applyLiveEvent(s, ev(5, "part_submit", { part: 0 }));
    expect(s.current.parts[0]?.phase).toBe("submitting");
    s = applyLiveEvent(s, ev(6, "part_confirmed", { part: 0 }));
    expect(s.current.parts[0]?.phase).toBe("confirmed");
  });

  it("rotates to previous when a second session starts", () => {
    let s = createLiveRunTracker({ mode: "zero-disk", platform: "douyin", roomSlug: "1", now: 1 });
    s = applyLiveEvent(s, ev(2, "run_start", { session: session("1:10", 10) }));
    s = applyLiveEvent(s, ev(3, "part_streaming", { part: 0 }));
    s = applyLiveEvent(s, ev(4, "part_confirmed", { part: 0 }));
    s = applyLiveEvent(s, ev(5, "run_start", { session: session("1:20", 20) }));
    expect(s.previous?.sessionId).toBe("1:10");
    expect(s.current.sessionId).toBe("1:20");
    expect(s.current.parts).toHaveLength(0);
  });

  it("progress updates the current part without appending an event", () => {
    let s = createLiveRunTracker({ mode: "zero-disk", platform: "douyin", roomSlug: "1", now: 1 });
    s = applyLiveEvent(s, ev(2, "part_streaming", { part: 0 }));
    const before = s.current.events.length;
    s = applyProgress(s, { part: 0, uploadedBytes: 500, chunks: 2 });
    expect(s.current.currentPart?.uploadedBytes).toBe(500);
    expect(s.current.events.length).toBe(before);
  });

  it("progress with no current part is a no-op", () => {
    const s = createLiveRunTracker({ mode: "zero-disk", platform: "douyin", roomSlug: "1", now: 1 });
    expect(() => applyProgress(s, { part: 0, uploadedBytes: 1, chunks: 1 })).not.toThrow();
  });

  it("run_end on a sessionless snapshot is terminal", () => {
    let s = createLiveRunTracker({ mode: "zero-disk", platform: "douyin", roomSlug: "1", now: 1 });
    s = applyLiveEvent(s, ev(2, "run_end", { outcome: "finished" }));
    expect(s.current.state).toBe("finished");
  });
});
