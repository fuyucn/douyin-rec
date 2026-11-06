// plan 046 PR5: master part-chain plan (v2), atomic upload-part enqueue and completion mapping.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnqueueRequest, EnqueueResponse, ProcessJob, ProcessReceipt } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { advanceUpload, ensureUploadPlan, partJobIds, type BiliupMeta, type PrepSpec, type UploadInput } from "../../packages/orchestrator/src/node-upload-queue.js";
import { mapUploadOutcome } from "../../packages/orchestrator/src/node-upload-complete.js";
import { createUploadQueuePoller } from "../../packages/orchestrator/src/node-upload-poll.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:1:2026-10-17";
const dbPath = (): string => join(mkdtempSync(join(tmpdir(), "nuq5-")), "j.db");
const fresh = (): SyncLedger => { const l = new SyncLedger(dbPath()); l.upsertPending(KEY); return l; };
const prep: PrepSpec = {
  segments: ["/n/recordings/a.ts"], stageDir: "/n/stage/k", stem: "s",
  mergeSegments: true, segmentGroupSec: 3600, minSegmentSec: 2, tsDirect: false,
};
const meta: BiliupMeta = { cookies: "/n/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 900 };
const input = (): UploadInput => ({ prep, meta, owner: { streamKey: KEY } });

function fakeNode(o: { rejectSecond?: boolean } = {}) {
  const receipts = new Map<string, ProcessReceipt>();
  const jobs: ProcessJob[] = [];
  const requests: EnqueueRequest[] = [];
  const n = {
    id: "n1",
    enqueue: vi.fn(async (req: EnqueueRequest): Promise<EnqueueResponse> => {
      requests.push(req);
      const results = req.jobs.map((job, i) => {
        if (o.rejectSecond && i === 1) return { jobId: job.jobId, state: "rejected" as const, error: "bad" };
        jobs.push(job);
        receipts.set(job.jobId, { jobId: job.jobId, state: "pending", leaseAlive: true });
        return { jobId: job.jobId, state: "pending" as const };
      });
      return { v: 1, results };
    }),
    procStatus: vi.fn(async (ids: string[]) => ids.map((id) => receipts.get(id)).filter(Boolean) as ProcessReceipt[]),
  };
  return { n: n as unknown as Transport, receipts, jobs, requests };
}

describe("part-chain plan (v2)", () => {
  it("enqueues every upload-part atomically after prep, persists deterministic ids, then maps all done to done", async () => {
    const l = fresh();
    const plan = ensureUploadPlan(l, KEY, "n1", input(), 1, { partChain: true });
    expect(plan).toMatchObject({ v: 2, mode: "part-chain", uploadJobIds: [] });
    const { n, receipts, jobs, requests } = fakeNode();
    const persist = (p: typeof plan): void => l.setUploadPlan(KEY, JSON.stringify(p));
    expect(await advanceUpload(n, plan, { now: () => 1000, persist })).toMatchObject({ phase: "prep-enqueued" });
    receipts.set(plan.prepJobId, { jobId: plan.prepJobId, state: "done", outputs: ["/n/stage/one.mp4", "/n/stage/two.mp4"], leaseAlive: true });
    const d = await advanceUpload(n, plan, { now: () => 2000, persist });
    expect(d.phase).toBe("part-chain-enqueued");
    expect(requests[1]?.batch).toBe(true);
    const parts = jobs.filter((j) => j.kind === "upload-part");
    expect(parts.map((j) => j.seq)).toEqual([1, 2]);
    expect(parts[0]?.params).toMatchObject({ partWorkflow: "whole-order", ctx: { index: 1, file: "/n/stage/one.mp4" } });
    expect(parts[1]?.params).toMatchObject({ ctx: { index: 2, file: "/n/stage/two.mp4" } });
    expect(parts.map((j) => j.jobId)).toEqual(partJobIds(KEY, 1, 2));
    const saved = JSON.parse(l.getUploadPlan(KEY)!) as typeof plan;
    expect(saved.uploadJobIds).toEqual(partJobIds(KEY, 1, 2));
    const ids = saved.uploadJobIds!;
    for (const id of ids) receipts.set(id, { jobId: id, state: "pending", leaseAlive: true });
    expect(ensureUploadPlan(l, KEY, "n1", input(), 1, { partChain: true })).toEqual(saved);
    await advanceUpload(n, saved, { now: () => 2500, persist });
    expect(requests).toHaveLength(2);
    receipts.set(ids[0]!, { jobId: ids[0]!, state: "done", bv: "BVa", leaseAlive: true }); // issue-guard: allow
    receipts.set(ids[1]!, { jobId: ids[1]!, state: "done", bv: "BVb", leaseAlive: true }); // issue-guard: allow
    const done = await advanceUpload(n, saved, { now: () => 3000, persist });
    expect(done.phase).toBe("part-chain");
    expect(mapUploadOutcome(done)).toEqual({ action: "done", bv: "BVb" }); // issue-guard: allow
  });

  it("a rejected part rolls the whole batch back and does not persist upload ids", async () => {
    const l = fresh();
    const plan = ensureUploadPlan(l, KEY, "n1", input(), 1, { partChain: true });
    const { n, receipts } = fakeNode({ rejectSecond: true });
    receipts.set(plan.prepJobId, { jobId: plan.prepJobId, state: "done", outputs: ["/n/stage/one.mp4", "/n/stage/two.mp4"], leaseAlive: true });
    const d = await advanceUpload(n, plan, { now: () => 1000, persist: (p) => l.setUploadPlan(KEY, JSON.stringify(p)) });
    expect(d).toMatchObject({ phase: "part-chain-failed", state: "rejected" });
    expect((JSON.parse(l.getUploadPlan(KEY)!) as typeof plan).uploadJobIds).toEqual([]);
  });

  it("a rate-limited upload-part still waits (pending), not needs_manual", () => {
    expect(mapUploadOutcome({ phase: "part-chain-waiting", receipts: [
      { jobId: "a", state: "done", bv: "BVa", leaseAlive: true }, // issue-guard: allow
      { jobId: "b", state: "pending", notBefore: 1, leaseAlive: true },
    ] })).toEqual({ action: "checkpoint", bv: "BVa" }); // issue-guard: allow
    expect(mapUploadOutcome({ phase: "part-chain-waiting", receipts: [{ jobId: "c", state: "pending", leaseAlive: true }] }))
      .toEqual({ action: "none" });
  });

  it("poller parses a persisted v2 plan after a master restart without duplicating part rows", async () => {
    const l = fresh();
    const plan = ensureUploadPlan(l, KEY, "n1", input(), 1, { partChain: true });
    const { n, receipts, requests } = fakeNode();
    receipts.set(plan.prepJobId, { jobId: plan.prepJobId, state: "done", outputs: ["/n/stage/only.mp4"], leaseAlive: true });
    const opts = { ledger: l, transports: () => new Map([["n1", n]]), unreachableAlertMs: 1e9 };
    await createUploadQueuePoller(opts).poll();
    expect(requests).toHaveLength(1);
    await createUploadQueuePoller(opts).poll();
    expect(requests).toHaveLength(1);
  });

  it("failed and missing parts are conservative manual outcomes, never failed/retried", () => {
    expect(mapUploadOutcome({ phase: "part-chain-failed", state: "failed", error: "x" })).toMatchObject({ action: "needs_manual" });
    expect(mapUploadOutcome({ phase: "part-chain-failed", state: "missing", error: "lost" })).toMatchObject({ action: "needs_manual" });
    expect(mapUploadOutcome({ phase: "part-chain-enqueued", results: [{ jobId: "a", state: "rejected", error: "bad" }] }))
      .toMatchObject({ action: "needs_manual" });
  });
});

