/**
 * task-logs.test.ts — unit tests for the TaskLogStore ring buffer.
 *
 * Covers append/get isolation per task, the timestamp prefix, ring/cap drop of
 * the oldest line on overflow, multi-line splitting, and clear().
 */
import { describe, it, expect } from "vitest";
import { TaskLogStore } from "../../packages/app/src/task-logs.js";

/** Fixed clock → deterministic [HH:MM:SS] prefix. */
const fixedClock = (): Date => new Date(2026, 5, 12, 9, 8, 7);

describe("TaskLogStore", () => {
  it("append + get returns lines oldest→newest per task", () => {
    const s = new TaskLogStore({ now: fixedClock });
    s.append(1, "first");
    s.append(1, "second");
    s.append(2, "other");
    expect(s.get(1)).toEqual(["[09:08:07] first", "[09:08:07] second"]);
    expect(s.get(2)).toEqual(["[09:08:07] other"]);
  });

  it("get returns [] for an unknown task", () => {
    const s = new TaskLogStore();
    expect(s.get(999)).toEqual([]);
  });

  it("prefixes each line with [HH:MM:SS]", () => {
    const s = new TaskLogStore({ now: fixedClock });
    s.append(1, "hello");
    expect(s.get(1)[0]).toMatch(/^\[\d{2}:\d{2}:\d{2}\] hello$/);
    expect(s.get(1)[0]).toBe("[09:08:07] hello");
  });

  it("ring buffer drops the OLDEST line when over cap", () => {
    const s = new TaskLogStore({ cap: 3, now: fixedClock });
    for (const m of ["a", "b", "c", "d", "e"]) s.append(1, m);
    const lines = s.get(1);
    expect(lines).toHaveLength(3);
    expect(lines).toEqual(["[09:08:07] c", "[09:08:07] d", "[09:08:07] e"]);
  });

  it("splits a multi-line append, each line timestamped + counted", () => {
    const s = new TaskLogStore({ cap: 10, now: fixedClock });
    s.append(1, "line1\nline2\nline3");
    expect(s.get(1)).toEqual([
      "[09:08:07] line1",
      "[09:08:07] line2",
      "[09:08:07] line3",
    ]);
  });

  it("ignores empty input", () => {
    const s = new TaskLogStore();
    s.append(1, "");
    expect(s.get(1)).toEqual([]);
  });

  it("clear drops a task's lines without touching others", () => {
    const s = new TaskLogStore({ now: fixedClock });
    s.append(1, "x");
    s.append(2, "y");
    s.clear(1);
    expect(s.get(1)).toEqual([]);
    expect(s.get(2)).toEqual(["[09:08:07] y"]);
  });

  it("get returns a COPY (mutating it does not affect the store)", () => {
    const s = new TaskLogStore({ now: fixedClock });
    s.append(1, "a");
    const copy = s.get(1);
    copy.push("tampered");
    expect(s.get(1)).toEqual(["[09:08:07] a"]);
  });
});
