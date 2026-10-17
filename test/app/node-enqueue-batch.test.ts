import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEnqueue, handleProcCancel, handleProcStatus, remoteEnqueueKinds } from "../../packages/app/src/node-enqueue.js";
import { jobIdOf, registerProcessor, _resetProcessors, type Processor } from "@drec/core";

function env() {
  const root = mkdtempSync(join(tmpdir(), "enq-"));
  mkdirSync(join(root, "stage"), { recursive: true });
  mkdirSync(join(root, "recordings"), { recursive: true });
  return root;
}
const proc = (kind: string): Processor => ({
  kind, resource: "cpu", lane: "copy", retryable: true, interruptible: true,
  validate: () => null, estimateDiskBytes: () => 0, run: async () => ({ outputs: [] }),
});
const job = (root: string, kind: string, name: string, gen = 1) => {
  const f = join(root, "stage", name);
  writeFileSync(f, "x");
  return {
    jobId: jobIdOf(kind, `k:${name}`, gen), kind, logicalKey: `k:${name}`, generation: gen,
    inputs: [f], params: {}, replaceInputs: false, owner: {}, createdAt: 1,
  };
};

describe("remote enqueue capabilities and batch (plan 038 T10a)", () => {
  it("capability list gates upload-prep/biliup;remux always allowed", () => {
    expect(remoteEnqueueKinds([])).toEqual(["remux"]);
    expect(remoteEnqueueKinds(["upload-prep"])).toContain("upload-prep");
    expect(remoteEnqueueKinds(["upload-prep"])).not.toContain("biliup");
    expect(remoteEnqueueKinds(["upload-prep", "biliup"])).toContain("biliup");
  });

  it("batch: one invalid job enqueues none", () => {
    _resetProcessors();
    registerProcessor(proc("biliup"));
    const root = env();
    const good = job(root, "biliup", "a.mp4");
    const bad = { ...job(root, "biliup", "b.mp4"), inputs: [join(root, "recordings", "missing.mp4")] };
    expect(() => handleEnqueue(root, { v: 1, jobs: [good, bad] }, { batch: true, capabilities: ["biliup"], getProcessor: () => proc("biliup") })).toThrow();
    expect(handleProcStatus(root, [good.jobId])).toEqual([]);
  });

  it("batch: all valid → all pending", () => {
    const root = env();
    const a = job(root, "biliup", "a.mp4");
    const b = job(root, "biliup", "b.mp4", 1);
    const res = handleEnqueue(root, { v: 1, jobs: [a, b] }, { batch: true, capabilities: ["biliup"], getProcessor: () => proc("biliup") });
    expect(res.results.map((r) => r.state)).toEqual(["pending", "pending"]);
  });

  it("cancel pending → cancelled;status includes bv/step", () => {
    const root = env();
    const a = job(root, "biliup", "a.mp4");
    handleEnqueue(root, { v: 1, jobs: [a] }, { batch: true, capabilities: ["biliup"], getProcessor: () => proc("biliup") });
    handleProcCancel(root, [a.jobId]);
    const st = handleProcStatus(root, [a.jobId]);
    expect(st[0]?.state).toBe("cancelled");
  });
});
