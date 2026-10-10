/**
 * sync-gate.test.ts — T-2 force 通道的时序语义。
 *
 * 关注点只有一个:**force 不能丢**。用户的「强制应用」若在同步在途时到达,必须落在
 * 合并后的补跑那一轮,否则节点守卫照旧拒绝 → 静默失败(自审发现的原始缺陷)。
 */
import { describe, it, expect, vi } from "vitest";
import { SyncGate } from "../../packages/cli/src/sync-gate.js";

describe("SyncGate", () => {
  it("就绪后 request → 返回 true,force 由 beginRun 消费一次", () => {
    const g = new SyncGate();
    const run = vi.fn().mockResolvedValue(undefined);
    g.bind(run);
    expect(g.request(true)).toBe(true);
    expect(g.beginRun()).toBe(true);   // 本轮确实带 force
    expect(g.beginRun()).toBe(false);  // 标志已清,下一轮不再误升格
  });

  it("**在途 force 不丢**:run 未结束时 request(force) → 补跑那一轮带 force", async () => {
    const g = new SyncGate();
    const seen: Array<boolean | undefined> = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const run = vi.fn(async (o?: { force?: boolean }) => {
      seen.push(o?.force);
      if (run.mock.calls.length === 1) await gate; // 第一轮卡住 = 构造 in-flight 窗口
    });
    g.bind(run);

    // 第一轮:普通周期 tick(模拟 cli 的 in-flight:running=true 后才发请求)
    expect(g.request()).toBe(true);
    g.running = true;
    const first = run({ force: g.beginRun() });
    await Promise.resolve();

    // 在途期间来了「强制应用」
    expect(g.request(true)).toBe(false);
    expect(g.rerunRequested).toBe(true);

    // 第一轮结束 → 补跑
    g.running = false;
    expect(g.endRun()).toBe(true);
    await run({ force: g.beginRun() });

    release();
    await first;
    expect(seen).toEqual([false, true]);   // 补跑那一轮拿到了 force
  });

  it("在途非 force 请求不把下一轮升格为 force", async () => {
    const g = new SyncGate();
    const run = vi.fn().mockResolvedValue(undefined);
    g.bind(run);
    expect(g.request()).toBe(true);
    g.running = true;
    expect(g.beginRun()).toBe(false);
    expect(g.request()).toBe(false);        // 合并,不涉及 force
    expect(g.endRun()).toBe(true);
    expect(g.beginRun()).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("执行体未就绪:请求挂起,bind 时补跑并带上累积的 force", () => {
    const g = new SyncGate();
    const run = vi.fn().mockResolvedValue(undefined);
    expect(g.request(true)).toBe(false);
    expect(g.pending).toBe(true);
    g.bind(run);
    expect(run).toHaveBeenCalledWith({ force: true });
    expect(g.pending).toBe(false);
  });

  it("unbind 后 request 不再执行(旧 runner 已停,不能被打到)", () => {
    const g = new SyncGate();
    const run = vi.fn().mockResolvedValue(undefined);
    g.bind(run);
    g.unbind();
    expect(g.request(true)).toBe(false);
    expect(g.pending).toBe(true);   // 停机后的请求挂起,不执行
    expect(run).not.toHaveBeenCalled();
  });

  it("多轮在途请求只补跑一次(rerunRequested 是布尔,不是计数器)", () => {
    const g = new SyncGate();
    g.bind(vi.fn().mockResolvedValue(undefined));
    g.running = true;
    g.request(); g.request(); g.request();
    expect(g.endRun()).toBe(true);
    expect(g.endRun()).toBe(false);
  });
});
