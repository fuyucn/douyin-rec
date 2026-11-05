// plan 046 PR3: reconciling out-edges are write-gated, lease/CAS-checked and default shadow-mode.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { PART_KINDS, canTransition, jobIdOf, registerProcessor, _resetProcessors, type ProcessJob } from "@drec/core";
import { ProcQueueStore, ProcRunner } from "@drec/proc-queue";
import { makeEnv, fakeProcessor, type Env } from "./helpers.js";

let env: Env;
beforeEach(() => { env = makeEnv(); _resetProcessors(); });
afterEach(() => { _resetProcessors(); env.cleanup(); });

const roots = () => ({ allowedRoots: [env.root] });
const partJob = (kind: string, confirmedAt: number): ProcessJob => {
  const file = env.file("a_000.ts");
  return {
    jobId: jobIdOf(kind, "same-broadcast:part-1", 1), kind, logicalKey: "same-broadcast:part-1", generation: 1,
    inputs: [file], params: { confirmedAt, ctx: { v: 1, orderKey: "same-broadcast", index: 1, file, fp: { size: 1, mtimeMs: 1 } } },
    replaceInputs: false, owner: { taskId: 1 }, createdAt: confirmedAt,
  };
};
const running = (kind = PART_KINDS.upload) => {
  const store = env.open();
  const jobId = store.enqueue(partJob(kind, env.clock.t), roots()).jobId;
  expect(store.acquireLease(kind, "A", { pid: process.pid }).acquired).toBe(true);
  expect(store.claim({ kinds: [kind], owner: "A" })?.jobId).toBe(jobId);
  return { store, jobId };
};

describe("reconciling write API", () => {
  it("startReconciliation is the only running -> reconciling writer; legacy finish stays refused", () => {
    const { store, jobId } = running();
    expect(store.finish(jobId, "A", { state: "reconciling", error: "submit", reason: "reconcile-start" })).toBe(false);
    expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
    expect(store.get(jobId)).toMatchObject({ state: "reconciling", claimedBy: null });
    expect(store.getLease(PART_KINDS.upload)).toBeTruthy();
  });

  it("rejects wrong owner, non-running rows and expired leases", () => {
    const { store, jobId } = running();
    expect(store.startReconciliation(jobId, "B", { error: "x" })).toBe(false);
    env.clock.t += 31_000;
    expect(store.startReconciliation(jobId, "A", { error: "x" })).toBe(false);
    env.clock.t -= 31_000;
    expect(store.startReconciliation(jobId, "A", { error: "x" })).toBe(true);
    expect(store.startReconciliation(jobId, "A", { error: "again" })).toBe(false);
  });

  it("settles yes/unknown/timeout and rejects illegal reasons by construction", () => {
    const { store, jobId } = running();
    expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
    expect(store.settleReconciling(jobId, "A", "unknown")).toBe(true);
    expect(store.get(jobId)?.state).toBe("reconciling");
    expect(canTransition("reconciling", "done", { reason: "reconcile-unknown" })).toBe(false);
    expect(store.settleReconciling(jobId, "A", "no")).toBe(true);
    expect(store.get(jobId)?.state).toBe("reconciling");
    expect(store.settleReconciling(jobId, "A", "timeout")).toBe(true);
    expect(store.get(jobId)).toMatchObject({ state: "failed", error: "对账时间盒耗尽,转人工核对" });
  });

  it("no-resend is disabled by default and opt-in is explicit", () => {
    const { store, jobId } = running();
    expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
    expect(store.settleReconciling(jobId, "A", "no")).toBe(true);
    expect(store.get(jobId)?.state).toBe("reconciling");
    expect(store.settleReconciling(jobId, "A", "no", { allowResend: true })).toBe(true);
    expect(store.get(jobId)?.state).toBe("pending");
  });

  it("concurrent repeated settle is idempotent", () => {
    const { store, jobId } = running();
    expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
    expect(store.settleReconciling(jobId, "A", "yes")).toBe(true);
    expect(store.settleReconciling(jobId, "A", "yes")).toBe(false);
    expect(store.get(jobId)?.state).toBe("done");
  });

  it("claim never sees reconciling and gc never deletes it", () => {
    const { store, jobId } = running();
    expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
    expect(store.claim({ kinds: [PART_KINDS.upload], owner: "A" })).toBeNull();
    env.clock.t += 8 * 24 * 3600_000;
    expect(store.gc()).toBe(0);
    expect(store.get(jobId)?.state).toBe("reconciling");
  });
});

describe("runner reconciliation shadow mode", () => {
  const mkRunner = (over: Partial<ConstructorParameters<typeof ProcRunner>[0]> = {}) => {
    const logs: string[] = [];
    const alerts: string[] = [];
    const store = env.open();
    const runner = new ProcRunner({
      store, owner: "A", diskMinGB: () => 0, alert: (_t, m) => alerts.push(m),
      log: (m) => logs.push(m), timers: false, ...over,
    });
    runner.start();
    return { runner, store, logs, alerts };
  };
  const reconciling = (store: ProcQueueStore, confirmedAt: number) => {
    const j = partJob(PART_KINDS.reconcile, confirmedAt);
    const jobId = store.enqueue(j, roots()).jobId;
    store.acquireLease(PART_KINDS.reconcile, "A", { pid: process.pid });
    store.claim({ kinds: [PART_KINDS.reconcile], owner: "A" });
    expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
    return jobId;
  };

  it("default is read-only: no store writes, structured shadow log, no alerts", async () => {
    registerProcessor(fakeProcessor({ kind: PART_KINDS.reconcile }));
    const { runner, store, logs, alerts } = mkRunner({ reconcileQuery: async () => "yes" });
    const jobId = reconciling(store, Date.now());
    const writeSpy = vi.spyOn(store, "settleReconciling");
    runner.tick();
    await vi.waitFor(() => expect(logs.some((m) => m.includes("DREC_RECONCILE_SHADOW"))).toBe(true));
    expect(writeSpy).not.toHaveBeenCalled();
    expect(store.get(jobId)?.state).toBe("reconciling");
    expect(alerts).toHaveLength(0);
    expect(logs.join("\n")).toContain('"wouldBe":"done"');
  });

  it("timeout advances to failed once and alerts once in explicit write mode", async () => {
    registerProcessor(fakeProcessor({ kind: PART_KINDS.reconcile }));
    const old = Date.now() - 25 * 3600_000;
    const { runner, store, alerts } = mkRunner({ reconcileShadowMode: false, reconcileMaxMs: 24 * 3600_000 });
    const jobId = reconciling(store, old);
    runner.tick();
    await vi.waitFor(() => expect(store.get(jobId)?.state).toBe("failed"));
    runner.tick();
    await vi.waitFor(() => expect(alerts.filter((m) => m.includes("reconcile timeout"))).toHaveLength(1));
    expect(alerts.filter((m) => m.includes("reconcile timeout"))).toHaveLength(1);
  });
});

