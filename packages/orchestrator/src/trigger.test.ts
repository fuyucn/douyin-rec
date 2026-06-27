import { describe, it, expect, vi } from "vitest";
import { EndDebouncer } from "./trigger.js";
describe("EndDebouncer", () => {
  it("持续 false 过 settle → 触发结束", () => {
    vi.useFakeTimers(); let ended = 0;
    const d = new EndDebouncer(1000, () => ended++);
    d.observe(false); vi.advanceTimersByTime(1001);
    expect(ended).toBe(1); vi.useRealTimers();
  });
  it("settle 内恢复 true(抖动) → 不触发", () => {
    vi.useFakeTimers(); let ended = 0;
    const d = new EndDebouncer(1000, () => ended++);
    d.observe(false); vi.advanceTimersByTime(500); d.observe(true); vi.advanceTimersByTime(1000);
    expect(ended).toBe(0); vi.useRealTimers();
  });
});
