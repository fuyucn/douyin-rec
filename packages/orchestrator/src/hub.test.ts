import { describe, it, expect, vi, afterEach } from "vitest";
import { startHub } from "./hub.js";

describe("startHub 并发守卫（防 reconcile fork 风暴）", () => {
  afterEach(() => vi.useRealTimers());

  it("reconcileAll 未完成时,周期 tick 不重入(任何时刻最多 1 个在跑)", async () => {
    vi.useFakeTimers();
    let inFlight = 0, maxInFlight = 0, calls = 0;
    let release: () => void = () => {};
    const reconcileAll = vi.fn(async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => { release = r; });
      inFlight--;
    });
    const stop = startHub({
      tasks: () => [],
      isRecording: () => false,
      reconcileAll,
      settleMs: 1000,
      pollMs: 100_000,            // poll 不参与本测
      reconcileIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);   // tick#1 → 进入,running=true,卡在未 resolve 的 promise
    await vi.advanceTimersByTimeAsync(50);   // tick#2 → 守卫跳过
    await vi.advanceTimersByTimeAsync(50);   // tick#3 → 守卫跳过
    expect(maxInFlight).toBe(1);             // 关键:永不并发(否则就是 fork 风暴)
    expect(calls).toBe(1);

    release();                                // 放行第一轮
    await vi.advanceTimersByTimeAsync(1);     // 让 finally 跑、running=false
    await vi.advanceTimersByTimeAsync(50);    // 下一 tick → 可再进
    expect(calls).toBe(2);

    release();
    stop();
  });
});
