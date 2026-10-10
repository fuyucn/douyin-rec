import { describe, it, expect, vi } from "vitest";
import { JobDispatcher } from "./job-dispatcher.js";

/** 可手动 resolve 的 deferred,用来观察并发窗口而不靠 sleep 猜时序。 */
function deferred<T = void>() {
  // 参数可选:`resolve()` 直接完成(void 用法),`resolve(v)` 带值。
  let resolve!: (v?: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = (v?: T) => res(v as T);
    reject = rej;
  });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

const flush = () => new Promise<void>((r) => setImmediate(r));

describe("JobDispatcher", () => {
  it("并发上限生效:maxConcurrent=2 → 第三个任务排队等待,不并发跑", async () => {
    const d = new JobDispatcher({ maxConcurrent: 2, log: () => {} });
    const running: string[] = [];
    const gates: Record<string, ReturnType<typeof deferred>> = {};

    for (const key of ["a", "b", "c"]) {
      gates[key] = deferred();
      d.enqueue(key, async () => {
        running.push(key);
        await gates[key].promise;
      });
    }
    await flush();
    expect(running).toEqual(["a", "b"]);        // 只有两个在跑
    expect(d.waiting).toBe(1);                  // c 在排队

    gates.a.resolve();
    await flush();
    expect(running).toEqual(["a", "b", "c"]);  // 腾出槽位 → c 上场
    gates.b.resolve();
    gates.c.resolve();
    await d.drain();
    expect(d.pending).toBe(0);
  });

  it("maxConcurrent=1 → 严格串行(与旧行为一致)", async () => {
    const d = new JobDispatcher({ maxConcurrent: 1, log: () => {} });
    const order: string[] = [];
    const g = deferred();
    d.enqueue("a", async () => { await g.promise; order.push("a"); });
    d.enqueue("b", async () => { order.push("b"); });
    await flush();
    expect(order).toEqual([]);
    g.resolve();
    await d.drain();
    expect(order).toEqual(["a", "b"]);
  });

  it("同 key 在活动期间重复 enqueue → 只执行一次", async () => {
    const d = new JobDispatcher({ maxConcurrent: 2, log: () => {} });
    const run = vi.fn(async () => { await g.promise; });
    const g = deferred();
    expect(d.enqueue("x", run)).toBe(true);
    await flush();
    expect(d.enqueue("x", run)).toBe(false);   // 活动去重
    expect(run).toHaveBeenCalledTimes(1);
    expect(d.stats.deduped).toBe(1);
    g.resolve();
    await d.drain();
  });

  it("settle(失败也算)后 key 出活动集合 → 下一轮可合法重试(dedup 不压重试)", async () => {
    const d = new JobDispatcher({ maxConcurrent: 2, log: () => {} });
    const fail = vi.fn(async () => { throw new Error("boom"); });
    d.enqueue("x", fail);
    await d.drain();
    // 失败后必须还能再派发 —— 否则 reconciler 的 RETRYABLE 重入会被压掉。
    expect(d.enqueue("x", async () => {})).toBe(true);
    await d.drain();
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it("单场抛错不影响其余场完成,且不静默(drain 正常返回)", async () => {
    const d = new JobDispatcher({ maxConcurrent: 3, log: () => {} });
    const ok = vi.fn(async () => {});
    d.enqueue("bad", async () => { throw new Error("x"); });
    d.enqueue("good1", ok);
    d.enqueue("good2", ok);
    await expect(d.drain()).resolves.toBeUndefined();
    expect(ok).toHaveBeenCalledTimes(2);
  });

  it("drain 后 active 集合清空", async () => {
    const d = new JobDispatcher({ maxConcurrent: 2, log: () => {} });
    d.enqueue("a", async () => {});
    d.enqueue("b", async () => {});
    await d.drain();
    // 两个都能再次入队 = 活动集合确实空了
    expect(d.enqueue("a", async () => { await Promise.resolve(); })).toBe(true);
    expect(d.enqueue("b", async () => { await Promise.resolve(); })).toBe(true);
    await d.drain();
  });

  it("drain 在空闲时立即返回(不会挂死)", async () => {
    const d = new JobDispatcher({ log: () => {} });
    await expect(d.drain()).resolves.toBeUndefined();
  });

  it("非法并发值(0/负/NaN)→ 夹到 1(串行),不出现「零并发死锁」或无限并发", () => {
    expect(new JobDispatcher({ maxConcurrent: 0, log: () => {} }).maxConcurrent).toBe(1);
    expect(new JobDispatcher({ maxConcurrent: -3, log: () => {} }).maxConcurrent).toBe(1);
    expect(new JobDispatcher({ maxConcurrent: NaN, log: () => {} }).maxConcurrent).toBe(1);
    expect(new JobDispatcher({ maxConcurrent: 2.9, log: () => {} }).maxConcurrent).toBe(2);
    expect(new JobDispatcher({ log: () => {} }).maxConcurrent).toBe(1);
  });

  it("run 同步抛错(非 promise)也不炸 drain", async () => {
    const d = new JobDispatcher({ maxConcurrent: 1, log: () => {} });
    d.enqueue("a", (() => { throw new Error("sync boom"); }) as unknown as () => Promise<void>);
    await expect(d.drain()).resolves.toBeUndefined();
  });

  it("dispatch 返回本项 settle 的 promise:只等自己派发的,不等别人的在飞任务", async () => {
    const d = new JobDispatcher({ maxConcurrent: 2, log: () => {} });
    const gate = deferred();
    d.enqueue("other", () => gate.promise);      // 别人(或上一轮)的活,永远挂着
    const mine = deferred();
    const p = d.dispatch("mine", () => mine.promise);
    mine.resolve();
    await expect(p).resolves.toBeUndefined();     // 不被 other 拖住
    gate.resolve();
    await d.drain();
  });

  it("dispatch 命中活动去重 → 立即 resolve(本轮不必等那一场)", async () => {
    const d = new JobDispatcher({ maxConcurrent: 2, log: () => {} });
    const gate = deferred();
    d.enqueue("x", () => gate.promise);
    await expect(d.dispatch("x", async () => {})).resolves.toBeUndefined();
    gate.resolve();
    await d.drain();
  });
});
