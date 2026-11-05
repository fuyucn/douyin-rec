// plan 046 PR1: atomic upload done -> cleanup pending; rollback, idempotency, lease and CAS.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PART_KINDS, jobIdOf, type PartCtx, type ProcessJob } from "@drec/core";
import { ProcQueueStore, type CompleteAndChainResult } from "@drec/proc-queue";
import { makeEnv, type Env } from "./helpers.js";

let env: Env;
beforeEach(() => { env = makeEnv(); });
afterEach(() => env.cleanup());

const roots = () => ({ allowedRoots: [env.root] });
const ctxFor = (file: string, over: Partial<PartCtx> = {}): PartCtx => ({
  v: 1, orderKey: "same-broadcast", index: 1, file,
  fp: { size: 1, mtimeMs: 1 }, ...over,
});
const uploadJob = (file: string): ProcessJob => {
  const logicalKey = "same-broadcast:part-1";
  return {
    jobId: jobIdOf(PART_KINDS.upload, logicalKey, 1), kind: PART_KINDS.upload, logicalKey,
    generation: 1, inputs: [file], params: { ctx: ctxFor(file) }, replaceInputs: false,
    owner: { taskId: 1 }, createdAt: env.clock.t, orderKey: "same-broadcast", seq: 1,
  };
};
const chain = (file: string, over: Partial<PartCtx> = {}) => ({
  logicalKey: "same-broadcast:part-1", generation: 1,
  ctx: { ...ctxFor(file), bv: "DRAFT", ...over }, owner: { taskId: 1 },
});
const runningUpload = (): { store: ProcQueueStore; jobId: string; file: string } => {
  const store = env.open();
  const job = uploadJob(env.file("a_000.ts"));
  const jobId = store.enqueue(job, roots()).jobId;
  expect(store.acquireLease(PART_KINDS.upload, "A", { pid: process.pid }).acquired).toBe(true);
  expect(store.claim({ kinds: [PART_KINDS.upload], owner: "A" })?.jobId).toBe(jobId);
  expect(store.setBv(jobId, "DRAFT")).toBe(true);
  return { store, jobId, file: job.inputs[0] };
};
/** toMatchObject 对 regex 值不做子串校验(实测),错误片段必须显式 toContain 钉死。 */
const expectChainError = (r: CompleteAndChainResult, fragment: string): void => {
  if (r.ok) throw new Error("expected failure, got ok: " + r.nextJobId);
  expect(r.error).toContain(fragment);
};

describe("completeAndChain", () => {
  it("finishes the upload and inserts exactly one cleanup row", () => {
    const { store, jobId, file } = runningUpload();
    const r = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots());
    expect(r).toMatchObject({ ok: true, chained: true });
    expect(store.get(jobId)?.state).toBe("done");
    expect(store.get((r as { nextJobId: string }).nextJobId)).toMatchObject({ kind: PART_KINDS.cleanup, state: "pending" });
    expect(store.get((r as { nextJobId: string }).nextJobId)?.params.ctx).toMatchObject({ bv: "DRAFT" });
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(1);
  });

  it("a throw after done but before insert rolls both writes back; the row stays running", () => {
    const { store, jobId, file } = runningUpload();
    const injected = new Error("crash between done and insert");
    expect(() => store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, {
      ...chain(file), beforeInsert: () => { throw injected; },
    }, roots())).toThrow(injected);
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
    store.close();
    const reopened = env.open();
    expect(reopened.get(jobId)?.state).toBe("running");
    expect(reopened.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("duplicate calls are idempotent and never create a second successor", () => {
    const { store, jobId, file } = runningUpload();
    const first = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots());
    const second = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots());
    expect(second).toMatchObject({ ok: true, chained: false, nextJobId: (first as { nextJobId: string }).nextJobId });
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(1);
  });

  it("crash re-entry after lease expiry accepts done+successor without a valid lease and without a duplicate row", () => {
    const { store, jobId, file } = runningUpload();
    const first = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots());
    expect(first).toMatchObject({ ok: true, chained: true });
    env.clock.t += 31_000; // LEASE_MS 已过:崩溃重入的常态
    const again = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots());
    expect(again).toMatchObject({ ok: true, chained: false, nextJobId: (first as { nextJobId: string }).nextJobId });
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(1);
  });

  it("rejects re-entry when the row is done but no successor exists (a chain step must not be lost silently)", () => {
    const { store, jobId, file } = runningUpload();
    expect(store.finish(jobId, "A", { state: "done", outputs: [] })).toBe(true);
    env.clock.t += 31_000;
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots()), "done without successor");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("rejects chaining from a predecessor that is not an upload-part", () => {
    const store = env.open();
    const job = env.job("a.ts"); // kind = fake,非 upload-part
    const jobId = store.enqueue(job, roots()).jobId;
    expect(store.acquireLease("fake", "A", { pid: process.pid }).acquired).toBe(true);
    expect(store.claim({ kinds: ["fake"], owner: "A" })?.jobId).toBe(jobId);
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(job.inputs[0]), roots()), "predecessor is not an upload-part");
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("overwrites the caller-supplied successor bv with the confirmed upload row's bv", () => {
    const { store, jobId, file } = runningUpload();
    const r = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file, { bv: "DIFFERENT" }), roots());
    expect(r).toMatchObject({ ok: true });
    expect(store.get((r as { nextJobId: string }).nextJobId)?.params.ctx).toMatchObject({ bv: "DRAFT" });
  });

  it("stamps the successor row with the store clock; a smuggled caller createdAt never lands", () => {
    const { store, jobId, file } = runningUpload();
    env.clock.t += 7_000;
    const smuggled = { ...chain(file), createdAt: 123_456 } as Parameters<ProcQueueStore["completeAndChain"]>[3];
    const r = store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, smuggled, roots());
    expect(r).toMatchObject({ ok: true });
    expect(store.get((r as { nextJobId: string }).nextJobId)?.createdAt).toBe(env.clock.t);
  });

  it("rejects a stale attempts CAS, a lost owner and an expired lease without changing either row", () => {
    const { store, jobId, file } = runningUpload();
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), { ...roots(), attempts: 99 }), "generation CAS mismatch");
    expectChainError(store.completeAndChain(jobId, "B", { state: "done", outputs: [] }, chain(file), roots()), "lease owner mismatch");
    env.clock.t += 31_000;
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots()), "lease invalid or expired");
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("rejects a mismatched successor ctx and an unconfirmed upload; neither row changes", () => {
    const { store, jobId, file } = runningUpload();
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file, { index: 2 }), roots()), "successor ctx does not match the confirmed upload");
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("rejects a finished upload without a draft identifier", () => {
    const { store, jobId, file } = runningUpload();
    expect(store.setBv(jobId, "")).toBe(true);
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots()), "confirmed upload has no draft identifier");
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("rejects a pre-existing successor while its predecessor is still running", () => {
    const { store, jobId, file } = runningUpload();
    const cleanup = {
      ...uploadJob(file), kind: PART_KINDS.cleanup,
      jobId: jobIdOf(PART_KINDS.cleanup, "same-broadcast:part-1", 1),
      params: {}, orderKey: undefined, seq: undefined,
    };
    expect(store.enqueue(cleanup, roots()).state).toBe("pending");
    expectChainError(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots()), "successor exists while predecessor is still running");
    expect(store.get(jobId)?.state).toBe("running");
  });
});
