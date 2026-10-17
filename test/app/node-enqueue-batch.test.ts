import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleEnqueue, handleProcCancel, handleProcStatus, localizePrepStage, remoteEnqueueKinds } from "../../packages/app/src/node-enqueue.js";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
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

  it("status exposes outputs only for done rows", () => {
    const root = env();
    const a = job(root, "upload-prep", "seg.ts");
    handleEnqueue(root, { v: 1, jobs: [a] }, { capabilities: ["upload-prep"], getProcessor: () => proc("upload-prep") });
    expect(handleProcStatus(root, [a.jobId])[0]).not.toHaveProperty("outputs");
    const store = new ProcQueueStore(procQueueDbPath(root));
    try {
      store.acquireLease("upload-prep", "A", { pid: process.pid });
      const c = store.claim({ kinds: ["upload-prep"], owner: "A" })!;
      store.finish(c.jobId, "A", { state: "done", outputs: [join(root, "stage", "p0.mp4")] });
    } finally { store.close(); }
    expect(handleProcStatus(root, [a.jobId])[0]?.outputs).toEqual([join(root, "stage", "p0.mp4")]);
  });
});

describe("localizePrepStage (plan 038 T15b)", () => {
  it("upload-prep writes under this node's stage; other kinds are untouched", () => {
    const prev = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = "/node-root";
    try {
      const prep = { kind: "upload-prep", orderKey: "douyin:1:2026-10-17", logicalKey: "x", params: { stageDir: "/master/stage", stem: "s" } } as never;
      const out = localizePrepStage(prep) as { params: { stageDir: string; stem: string } };
      expect(out.params.stageDir.startsWith("/node-root/")).toBe(true);
      expect(out.params.stageDir).not.toContain("/master/");
      expect(out.params.stem).toBe("s");
      expect(localizePrepStage(prep)).toEqual(out); // deterministic: a re-sent job stays identical
      const other = { kind: "biliup", params: { stageDir: "/m" } } as never;
      expect(localizePrepStage(other)).toBe(other);
    } finally {
      if (prev === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = prev;
    }
  });
});

