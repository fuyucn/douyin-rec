/**
 * finalizeAfterUpload 的收口口径(issue #92):**上传是否成功只看 biliup 返回码**。
 * 走到收口 = 上传已确认,清理无条件执行;回读 B站分 P 数降为**延迟的旁路校验**,
 * 只记录/告警,绝不影响清理、不转人工。
 */
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SIDE_CHECK_DELAY_MS, finalizeAfterUpload } from "./pipeline.js";
import type { SyncLedger } from "./ledger.js";

/** 假台账:记录调用,便于断言「没有把 job 打成 needs_manual / 没有留 pending」。 */
function fakeLedger(parts: Record<string, number[]>) {
  const calls = {
    setState: [] as Array<{ state: string; error?: string }>,
    nodeState: [] as Array<{ node: string; state: string; error?: string | null }>,
    logStep: [] as Array<{ step: string; phase: string; detail?: string }>,
  };
  const ledger = {
    doneParts: (_k: string, g: string) => new Set(parts[g] ?? []),
    setState: (k: string, state: string, patch?: { error?: string }) => { calls.setState.push({ state, error: patch?.error }); },
    syncNodeState: (k: string, node: string, state: string, patch?: { error?: string | null }) => { calls.nodeState.push({ node, state, error: patch?.error }); },
    logStep: (k: string, step: string, phase: string, detail?: string) => { calls.logStep.push({ step, phase, detail }); },
  } as unknown as SyncLedger;
  return { ledger, calls };
}

const ALL_ON = { plain: true, danmu: true, livechat: true };

interface Harness {
  deps: Parameters<typeof finalizeAfterUpload>[0]["deps"];
  countCalls: () => number;
  scheduled: Array<{ fn: () => void; ms: number }>;
}
function harness(ledger: SyncLedger, actual: number | null | "throw" | "no-count", extra: Record<string, unknown> = {}): Harness {
  let n = 0;
  const scheduled: Harness["scheduled"] = [];
  const d: Record<string, unknown> = {
    ledger,
    // 核验重查默认 5 次 × 3s 退避;测试注入 no-op 免真等。
    sleep: async () => {},
    scheduleSideCheck: (fn: () => void, ms: number) => { scheduled.push({ fn, ms }); },
    ...extra,
  };
  if (actual !== "no-count") {
    d.countParts = async () => {
      n++;
      if (actual === "throw") throw new Error("net down");
      return actual;
    };
  }
  return { deps: d as unknown as Harness["deps"], countCalls: () => n, scheduled };
}

async function run(h: Harness, notify: (e: unknown) => void = () => {}) {
  let cleaned = 0;
  const r = await finalizeAfterUpload({
    streamKey: "k", bv: "BV1", deps: h.deps, log: () => {},
    cleanupSources: async () => { cleaned++; return { ok: true, failed: [] }; },
    on: ALL_ON,
    notify: notify as never,
  });
  return { r, cleaned: () => cleaned };
}

describe("finalizeAfterUpload:上传确认后无条件清理,回读不是闸门(#92)", () => {
  it.each([
    ["回读少于期望(期望3/实际1)", 1],
    ["回读取不到数据", null],
    ["回读一致", 3],
    ["回读多于期望", 5],
    ["回读抛错", "throw"],
    ["未注入分P查询", "no-count"],
  ] as const)("%s → 照常清理源,cleanConfirmed / stageCleanConfirmed 为真,无 needs_manual", async (_n, actual) => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, actual);
    const { r, cleaned } = await run(h);
    expect(cleaned()).toBe(1);
    expect(r.cleanConfirmed).toBe(true);
    expect(r.stageCleanConfirmed).toBe(true);
    expect(r.verifyBlocked).toBeUndefined();
    expect(calls.setState).toHaveLength(0);
  });

  it("收口时**不同步回读**(回读在延迟后旁路执行),且不留 clean_verify=pending(否则补跑会反复重入)", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, null);
    await run(h);
    expect(h.countCalls()).toBe(0);
    expect(calls.nodeState.some((n) => n.node === "clean_verify" && n.state === "done")).toBe(true);
    expect(calls.nodeState.some((n) => n.state === "pending")).toBe(false);
  });

  it("清理失败不影响返回(照常返回 outcome,不抛)", async () => {
    const { ledger } = fakeLedger({ plain: [0] });
    const h = harness(ledger, 1);
    const r = await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: h.deps, log: () => {},
      cleanupSources: async () => ({ ok: false, failed: [{ target: "x", error: "e" }] } as never),
      on: ALL_ON, notify: () => {},
    });
    expect(r.ok).toBe(false);
  });
});

describe("旁路校验:延迟回读,只记录/告警(#92)", () => {
  it("默认延迟 10 分钟;可用 sideCheckDelayMs 配置", async () => {
    const { ledger } = fakeLedger({ plain: [0, 1, 2] });
    const h1 = harness(ledger, 3);
    await run(h1);
    expect(h1.scheduled).toHaveLength(1);
    expect(h1.scheduled[0].ms).toBe(DEFAULT_SIDE_CHECK_DELAY_MS);
    expect(DEFAULT_SIDE_CHECK_DELAY_MS).toBe(600_000);
    const h2 = harness(ledger, 3, { sideCheckDelayMs: 42 });
    await run(h2);
    expect(h2.scheduled[0].ms).toBe(42);
  });

  it("未注入分 P 查询 → 不排旁路校验", async () => {
    const { ledger } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, "no-count");
    await run(h);
    expect(h.scheduled).toHaveLength(0);
  });

  it("到点回读不符 → 记台账备注 + 发一条告警,**不改任何状态**、不再清理", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, 1);
    const notify = vi.fn();
    const { cleaned } = await run(h, notify);
    expect(h.countCalls()).toBe(0);
    h.scheduled[0].fn();
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    const msg = String((notify.mock.calls[0][0] as { message: string }).message);
    expect(msg).toContain("期望 3");
    expect(msg).toContain("回读 1");
    expect(msg).toContain("仅记录");
    const step = calls.logStep.find((s) => s.step === "clean_verify" && /旁路校验/.test(s.detail ?? ""));
    expect(step?.detail).toContain("仅记录");
    expect(calls.setState).toHaveLength(0);
    expect(cleaned()).toBe(1); // 旁路不触发第二次清理
  });

  it("到点回读一致 → 只记日志,不告警", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, 3);
    const notify = vi.fn();
    await run(h, notify);
    h.scheduled[0].fn();
    await vi.waitFor(() => expect(calls.logStep.some((s) => /旁路校验通过/.test(s.detail ?? ""))).toBe(true));
    expect(notify).not.toHaveBeenCalled();
  });

  it.each([["取不到数据", null], ["抛错", "throw"]] as const)("到点回读%s → 不告警、不抛、不改状态", async (_n, actual) => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, actual);
    const notify = vi.fn();
    await run(h, notify);
    h.scheduled[0].fn();
    await vi.waitFor(() => expect(h.countCalls()).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 5));
    expect(notify).not.toHaveBeenCalled();
    expect(calls.setState).toHaveLength(0);
  });

  it("无基线(台账没有已传分 P)→ 回读也不告警", async () => {
    const { ledger } = fakeLedger({});
    const h = harness(ledger, 3);
    const notify = vi.fn();
    await run(h, notify);
    h.scheduled[0].fn();
    await new Promise((r) => setTimeout(r, 5));
    expect(notify).not.toHaveBeenCalled();
  });
});
