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

  it("任务同步不被在跑的 reconcile 阻塞(独立锁,防停止指令饿死)", async () => {
    vi.useFakeTimers();
    let release: () => void = () => {};
    const reconcileAll = vi.fn(async () => {
      await new Promise<void>((r) => { release = r; });
    });
    const syncTasks = vi.fn().mockResolvedValue(undefined);
    const stop = startHub({
      tasks: () => [],
      isRecording: () => false,
      reconcileAll,
      settleMs: 1000,
      pollMs: 100_000,
      reconcileIntervalMs: 50,
      syncTasks,
      syncIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(50);   // reconcile tick → 进入并卡住
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(syncTasks).toHaveBeenCalledTimes(2); // 启动即同步一次 + tick 一次
    await vi.advanceTimersByTimeAsync(50);     // reconcile 仍占用锁,但 sync 照常跑
    expect(syncTasks.mock.calls.length).toBeGreaterThanOrEqual(3);

    release();
    stop();
  });

  it("主控重试5秒唤醒不受长对账阻塞,自身不重入且停止后清除定时器", async () => {
    vi.useFakeTimers();
    let releaseReconcile!: () => void;
    let releaseRetry!: () => void;
    const reconcileAll = vi.fn(() => new Promise<void>((r) => { releaseReconcile = r; }));
    const pollUploadRetries = vi.fn(() => new Promise<void>((r) => { releaseRetry = r; }));
    const stop = startHub({ tasks: () => [], isRecording: () => false, reconcileAll, pollUploadRetries,
      settleMs: 10, pollMs: 100_000, reconcileIntervalMs: 1_000 });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(reconcileAll).toHaveBeenCalledTimes(1);
    expect(pollUploadRetries).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollUploadRetries).toHaveBeenCalledTimes(1);
    releaseRetry();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(pollUploadRetries).toHaveBeenCalledTimes(2);
    stop(); releaseRetry(); releaseReconcile();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(pollUploadRetries).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("任务同步自身不重入(同一时刻最多 1 次在跑)", async () => {
    vi.useFakeTimers();
    let inFlight = 0, maxInFlight = 0, calls = 0;
    let release: () => void = () => {};
    const syncTasks = vi.fn(async () => {
      calls++; inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => { release = r; });
      inFlight--;
    });
    const stop = startHub({
      tasks: () => [],
      isRecording: () => false,
      reconcileAll: vi.fn().mockResolvedValue(undefined),
      settleMs: 1000,
      pollMs: 100_000,
      reconcileIntervalMs: 100_000,
      syncTasks,
      syncIntervalMs: 50,
    });

    await vi.advanceTimersByTimeAsync(1);    // 启动即同步 → 卡住
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(100);  // 周期 tick 全被自身守卫跳过
    expect(maxInFlight).toBe(1);
    expect(calls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(50);   // 放行后下个 tick 可再进
    expect(calls).toBe(2);
    release();
    stop();
  });
});
