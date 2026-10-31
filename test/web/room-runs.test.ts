import { describe, expect, it } from "vitest";
import { listedRunCount, showsRunsEmpty } from "../../packages/web/src/lib/room-runs.js";

// The row counts come from the components themselves (issue #417): the list only does arithmetic.
describe("room run list shape (issue #417)", () => {
  it("does not call a list empty while any row is rendered", () => {
    expect(showsRunsEmpty({ loaded: true, hubRuns: 0, liveRows: 1 })).toBe(false);
    // A live-upload room between two broadcasts: no current run, but its history is a row.
    expect(showsRunsEmpty({ loaded: true, hubRuns: 0, liveRows: 3 })).toBe(false);
    expect(showsRunsEmpty({ loaded: true, hubRuns: 0, liveRows: 0 })).toBe(true);
    expect(showsRunsEmpty({ loaded: true, hubRuns: 3, liveRows: 0 })).toBe(false);
    // Still loading: no empty state yet, it would flash.
    expect(showsRunsEmpty({ loaded: false, hubRuns: 0, liveRows: 0 })).toBe(false);
  });

  it("counts the hub total plus the rendered live rows", () => {
    expect(listedRunCount({ hubRuns: 0, liveRows: 1 })).toBe(1);
    expect(listedRunCount({ hubRuns: 4, liveRows: 2 })).toBe(6);
    // The hub total is the real total, not just the loaded page.
    expect(listedRunCount({ hubRuns: 57, liveRows: 1 })).toBe(58);
    expect(listedRunCount({ hubRuns: 4, liveRows: 0 })).toBe(4);
  });
});
