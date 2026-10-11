/**
 * finalizeAfterUpload 的**核验收口闸门**测试(T32 观察期)。
 *
 * 为什么单独测:核验的「判定」在 verify.ts(已有测试),但真正决定
 * 「是否 needs_manual / 是否删源」的是 pipeline.finalizeAfterUpload —— 它此前**无任何测试**,
 * 也就是「核验阻塞删源」这个行为一直没有单测兜着。观察期要改的正是这里。
 */
import { describe, it, expect, vi } from "vitest";
import { finalizeAfterUpload } from "./pipeline.js";
import { verifyBlocksOnMismatch } from "./verify.js";
import type { SyncLedger } from "./ledger.js";

/** 假台账:记录调用,便于断言「没有把 job 打成 needs_manual」。 */
function fakeLedger(parts: Record<string, number[]>) {
  const calls = {
    setState: [] as Array<{ state: string; error?: string }>,
    nodeState: [] as Array<{ node: string; state: string }>,
    logStep: [] as Array<{ step: string; phase: string; detail?: string }>,
  };
  const ledger = {
    doneParts: (_k: string, g: string) => new Set(parts[g] ?? []),
    setState: (k: string, state: string, patch?: { error?: string }) => { calls.setState.push({ state, error: patch?.error }); },
    syncNodeState: (k: string, node: string, state: string) => { calls.nodeState.push({ node, state }); },
    logStep: (k: string, step: string, phase: string, detail?: string) => { calls.logStep.push({ step, phase, detail }); },
  } as unknown as SyncLedger;
  return { ledger, calls };
}

const ALL_ON = { plain: true, danmu: true, livechat: true };

function deps(ledger: SyncLedger, actual: number | null) {
  return {
    ledger,
    countParts: async () => actual,
    // 核验重查默认 5 次 × 3s 退避(≈45s);测试注入 no-op 免真等。
    sleep: async () => {},
  } as unknown as Parameters<typeof finalizeAfterUpload>[0]["deps"];
}

describe("finalizeAfterUpload:观察期核验只记录,不阻塞", () => {
  it("mismatch(期望3/实际1)→ **不**转 needs_manual、**照常删源**,但台账/日志留痕", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    let cleaned = 0;
    const r = await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: deps(ledger, 1), log: () => {},
      cleanupSources: async () => { cleaned++; return { ok: true, failed: [] }; },
      on: ALL_ON,
      notify: () => {},
    });
    expect(verifyBlocksOnMismatch()).toBe(false); // 观察期
    expect(r.verifyBlocked).toBeUndefined();
    expect(cleaned).toBe(1);                        // 源照常删(不再被核验卡住)
    expect(calls.setState).toHaveLength(0);         // 没被打成 needs_manual
    // 但必须留痕:clean_verify 步骤记下期望/实际 + 「仅记录」
    const step = calls.logStep.find((s) => s.step === "clean_verify");
    expect(step?.detail).toContain("期望 3");
    expect(step?.detail).toContain("实际 1");
    expect(step?.detail).toContain("仅记录");
  });

  it("ok → 照常删源、无 needs_manual", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    let cleaned = 0;
    const r = await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: deps(ledger, 3), log: () => {},
      cleanupSources: async () => { cleaned++; return { ok: true, failed: [] }; },
      on: ALL_ON, notify: () => {},
    });
    expect(r.verifyBlocked).toBeUndefined();
    expect(cleaned).toBe(1);
    expect(calls.setState).toHaveLength(0);
  });

  it("unknown(查不到实际数)→ **仍然不删源**(观察期只放宽 mismatch,不放宽 unknown)", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    let cleaned = 0;
    await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: deps(ledger, null), log: () => {},
      cleanupSources: async () => { cleaned++; return { ok: true, failed: [] }; },
      on: ALL_ON, notify: () => {},
    });
    expect(cleaned).toBe(0);
    expect(calls.nodeState.some((n) => n.state === "pending")).toBe(true);
  });

  it("mismatch 仍发一条通知(留痕用),措辞标明「仅记录,未阻塞」", async () => {
    const { ledger } = fakeLedger({ plain: [0, 1, 2] });
    const notify = vi.fn();
    await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: deps(ledger, 1), log: () => {},
      cleanupSources: async () => ({ ok: true, failed: [] }),
      on: ALL_ON, notify,
    });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String((notify.mock.calls[0][0] as { message: string }).message)).toContain("观察期仅记录");
  });
});
