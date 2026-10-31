import { describe, expect, it } from "vitest";
import { hasCurrentRun, listedRunCount, showsRunsEmpty } from "../../packages/web/src/lib/room-runs.js";

describe("room run list shape (issue #417)", () => {
  it("counts a live-upload room's current run as a row", () => {
    expect(hasCurrentRun({ streamUpload: true, liveNodes: 1, rolling: 0 })).toBe(true);
    expect(hasCurrentRun({ streamUpload: true, liveNodes: 0, rolling: 2 })).toBe(true);
    expect(hasCurrentRun({ streamUpload: true, liveNodes: 0, rolling: 0 })).toBe(false);
    // A file-recording task has no live row even when rolling is passed in.
    expect(hasCurrentRun({ streamUpload: false, liveNodes: 1, rolling: 1 })).toBe(false);
  });

  it("does not call a room with a current run empty", () => {
    expect(showsRunsEmpty({ loaded: true, hubRuns: 0, hasCurrent: true })).toBe(false);
    expect(showsRunsEmpty({ loaded: true, hubRuns: 0, hasCurrent: false })).toBe(true);
    expect(showsRunsEmpty({ loaded: true, hubRuns: 3, hasCurrent: false })).toBe(false);
    // Still loading: no empty state yet, it would flash.
    expect(showsRunsEmpty({ loaded: false, hubRuns: 0, hasCurrent: false })).toBe(false);
  });

  it("lists the current run on top of the hub rows", () => {
    expect(listedRunCount({ hubRuns: 0, hasCurrent: true })).toBe(1);
    expect(listedRunCount({ hubRuns: 4, hasCurrent: true })).toBe(5);
    expect(listedRunCount({ hubRuns: 4, hasCurrent: false })).toBe(4);
  });
});
