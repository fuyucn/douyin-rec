// plan 046 PR3: shadow mode still enforces the time box so no reconciling row can be stranded.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PART_KINDS, _resetProcessors, jobIdOf, registerProcessor, type ProcessJob } from "@drec/core";
import { ProcRunner } from "@drec/proc-queue";
import { makeEnv, fakeProcessor, type Env } from "./helpers.js";

let env: Env;
beforeEach(() => { env = makeEnv(); _resetProcessors(); });
afterEach(() => { _resetProcessors(); env.cleanup(); });

it("shadow-mode timeout writes failed once and alerts once", async () => {
  registerProcessor(fakeProcessor({ kind: PART_KINDS.reconcile }));
  const store = env.open();
  const file = env.file("a_000.ts");
  const old = Date.now() - 25 * 3600_000;
  const job: ProcessJob = {
    jobId: jobIdOf(PART_KINDS.reconcile, "same-broadcast:part-1", 1), kind: PART_KINDS.reconcile,
    logicalKey: "same-broadcast:part-1", generation: 1, inputs: [file],
    params: { confirmedAt: old, ctx: { v: 1, orderKey: "same-broadcast", index: 1, file, fp: { size: 1, mtimeMs: 1 } } },
    replaceInputs: false, owner: { taskId: 1 }, createdAt: old,
  };
  const jobId = store.enqueue(job, { allowedRoots: [env.root] }).jobId;
  store.acquireLease(PART_KINDS.reconcile, "A", { pid: process.pid });
  store.claim({ kinds: [PART_KINDS.reconcile], owner: "A" });
  expect(store.startReconciliation(jobId, "A", { error: "submit" })).toBe(true);
  const alerts: string[] = [];
  const runner = new ProcRunner({
    store, owner: "A", diskMinGB: () => 0, alert: (_t, m) => alerts.push(m), timers: false,
    reconcileMaxMs: 24 * 3600_000,
  });
  runner.start();
  runner.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(store.get(jobId)?.state).toBe("failed");
  runner.tick();
  await new Promise((r) => setTimeout(r, 10));
  expect(alerts.filter((m) => m.includes("reconcile timeout"))).toHaveLength(1);
});

