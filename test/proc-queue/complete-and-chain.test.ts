// plan 046 PR1: atomic upload done -> cleanup pending; rollback, idempotency, lease and CAS.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PART_KINDS, jobIdOf, type PartCtx, type ProcessJob } from "@drec/core";
import { ProcQueueStore } from "@drec/proc-queue";
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
  ctx: { ...ctxFor(file, over), bv: "DRAFT" }, owner: { taskId: 1 }, createdAt: env.clock.t,
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

  it("rejects a stale attempts CAS, a lost owner and an expired lease without changing either row", () => {
    const { store, jobId, file } = runningUpload();
    expect(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), { ...roots(), attempts: 99 })).toMatchObject({ ok: false });
    expect(store.completeAndChain(jobId, "B", { state: "done", outputs: [] }, chain(file), roots())).toMatchObject({ ok: false });
    env.clock.t += 31_000;
    expect(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots())).toMatchObject({ ok: false });
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("rejects a mismatched successor ctx and an unconfirmed upload; neither row changes", () => {
    const { store, jobId, file } = runningUpload();
    expect(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file, { index: 2 }), roots()))
      .toMatchObject({ ok: false, error: /ctx/ });
    expect(store.get(jobId)?.state).toBe("running");
    expect(store.list({ kind: PART_KINDS.cleanup })).toHaveLength(0);
  });

  it("rejects a finished upload without a draft identifier", () => {
    const { store, jobId, file } = runningUpload();
    expect(store.setBv(jobId, "")).toBe(true);
    expect(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots()))
      .toMatchObject({ ok: false, error: /draft/ });
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
    expect(store.completeAndChain(jobId, "A", { state: "done", outputs: [] }, chain(file), roots()))
      .toMatchObject({ ok: false, error: /still running/ });
    expect(store.get(jobId)?.state).toBe("running");
  });
});
