/**
 * finalizeAfterUpload gate (issue #327, supersedes the #92 "read-back never affects cleanup" rule).
 * Upload success is still decided by the biliup exit code alone (no retry / re-append anywhere); but before the
 * LAST copy of the video is deleted, the part count is re-read with delays. Match -> clean up; still short / higher /
 * unreadable after the window -> keep all sources, needs_manual, one notify, cleanup never called.
 */
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_SIDE_CHECK_DELAY_MS, finalizeAfterUpload } from "./pipeline.js";
import type { SyncLedger } from "./ledger.js";

function fakeLedger(parts: Record<string, number[]>) {
  const calls = {
    setState: [] as Array<{ state: string; error?: string; force?: boolean }>,
    nodeState: [] as Array<{ node: string; state: string; error?: string | null }>,
    logStep: [] as Array<{ step: string; phase: string; detail?: string }>,
  };
  const ledger = {
    doneParts: (_k: string, g: string) => new Set(parts[g] ?? []),
    setState: (_k: string, state: string, patch?: { error?: string }, opts?: { force?: boolean }) => {
      calls.setState.push({ state, error: patch?.error, force: opts?.force });
    },
    syncNodeState: (_k: string, node: string, state: string, patch?: { error?: string | null }) => { calls.nodeState.push({ node, state, error: patch?.error }); },
    logStep: (_k: string, step: string, phase: string, detail?: string) => { calls.logStep.push({ step, phase, detail }); },
  } as unknown as SyncLedger;
  return { ledger, calls };
}

const ALL_ON = { plain: true, danmu: true, livechat: true };

/** Scripted countParts + fake sleep (records requested waits, never really waits). */
function harness(ledger: SyncLedger, reads: Array<number | null | "throw"> | "no-count", extra: Record<string, unknown> = {}) {
  const waits: number[] = [];
  let n = 0;
  const d: Record<string, unknown> = { ledger, sleep: async (ms: number) => { waits.push(ms); }, ...extra };
  if (reads !== "no-count") {
    d.countParts = async () => {
      const r = reads[Math.min(n, reads.length - 1)];
      n++;
      if (r === "throw") throw new Error("net down");
      return r;
    };
  }
  return { deps: d as unknown as Parameters<typeof finalizeAfterUpload>[0]["deps"], waits, reads: () => n };
}

async function run(h: ReturnType<typeof harness>, notify: (e: unknown) => void = () => {}, commitDone?: () => void) {
  const cleanup = vi.fn(async () => ({ ok: true as const, failed: [] as never[] }));
  const r = await finalizeAfterUpload({
    streamKey: "k", bv: "BV1", deps: h.deps, log: () => {},
    cleanupSources: cleanup, on: ALL_ON, notify: notify as never, commitDone,
  });
  return { r, cleanup };
}

describe("finalizeAfterUpload: delayed read-back gate before cleanup (#327)", () => {
  it("first read short, later read correct -> cleanup proceeds, no alert, done committed after the gate", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [2, 2, 3]);
    const notify = vi.fn();
    const commit = vi.fn();
    const { r, cleanup } = await run(h, notify, commit);
    expect(r.blocked).toBeUndefined();
    expect(h.reads()).toBe(3);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
    expect(calls.setState).toEqual([]);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.invocationCallOrder[0]).toBeLessThan(cleanup.mock.invocationCallOrder[0]);
  });

  it("reads wait 2/2/2/4 minutes of the default 10-minute window", async () => {
    const { ledger } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [1]);
    await run(h);
    expect(h.waits).toEqual([120_000, 120_000, 120_000, 240_000]);
    expect(h.waits.reduce((a, b) => a + b, 0)).toBe(DEFAULT_SIDE_CHECK_DELAY_MS);
  });

  it("window is the existing sideCheckDelayMs knob", async () => {
    const { ledger } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [3], { sideCheckDelayMs: 1000 });
    await run(h);
    expect(h.waits).toEqual([200]); // matched on the first read, only the first wait happened
  });

  it("persistent short -> sources kept, needs_manual (Chinese reason with expected/read-back), one notify, no commit", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [2]);
    const notify = vi.fn();
    const commit = vi.fn();
    const { r, cleanup } = await run(h, notify, commit);
    expect(cleanup).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(r.blocked).toContain("期望 3");
    expect(r.blocked).toContain("回读 2");
    expect(calls.setState).toHaveLength(1);
    expect(calls.setState[0]).toMatchObject({ state: "needs_manual", force: false });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(h.reads()).toBe(4);
  });

  it.each([["null", null], ["throws", "throw"]] as const)("unreadable (%s) every time -> same as short", async (_n, v) => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [v]);
    const notify = vi.fn();
    const { r, cleanup } = await run(h, notify, () => {});
    expect(cleanup).not.toHaveBeenCalled();
    expect(r.blocked).toContain("无法回读");
    expect(calls.setState[0]?.state).toBe("needs_manual");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("read-back higher than expected -> kept + needs_manual (possible duplicate)", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [5]);
    const notify = vi.fn();
    const { r, cleanup } = await run(h, notify, () => {});
    expect(cleanup).not.toHaveBeenCalled();
    expect(r.blocked).toContain("多于期望");
    expect(calls.setState[0]?.state).toBe("needs_manual");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("already-done job (no commitDone, cleanup backfill) -> needs_manual is forced", async () => {
    const { ledger, calls } = fakeLedger({ plain: [0, 1, 2] });
    const h = harness(ledger, [1]);
    await run(h);
    expect(calls.setState[0]).toMatchObject({ state: "needs_manual", force: true });
  });

  it("no countParts or no baseline -> no wait, cleanup as before (node-side path unchanged)", async () => {
    const a = fakeLedger({ plain: [0, 1, 2] });
    const h1 = harness(a.ledger, "no-count");
    expect((await run(h1)).cleanup).toHaveBeenCalledTimes(1);
    expect(h1.waits).toEqual([]);
    const b = fakeLedger({});
    const h2 = harness(b.ledger, [1]);
    const r2 = await run(h2);
    expect(r2.cleanup).toHaveBeenCalledTimes(1);
    expect(h2.waits).toEqual([]);
    expect(h2.reads()).toBe(0);
  });

  it("cleanup failure is returned, never thrown (unchanged)", async () => {
    const { ledger } = fakeLedger({ plain: [0] });
    const h = harness(ledger, [1]);
    const r = await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: h.deps, log: () => {},
      cleanupSources: async () => ({ ok: false, failed: [{ target: "x", error: "e" }] } as never),
      on: ALL_ON, notify: () => {},
    });
    expect(r.ok).toBe(false);
  });
});
