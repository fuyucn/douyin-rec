// plan 038 T12: uploadPlan persistence + two-phase prep -> biliup dispatch against a fake node.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { EnqueueRequest, EnqueueResponse, ProcessJob, ProcessReceipt } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import {
  advanceUpload, ensureUploadPlan, planJobIds, type BiliupMeta, type DispatchInput, type PrepSpec,
} from "../../packages/orchestrator/src/node-upload-queue.js";
import { ProcUnsupported, type Transport } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:1:2026-10-17";
const dbPath = (): string => join(mkdtempSync(join(tmpdir(), "nuq-")), "j.db");
const fresh = (): SyncLedger => { const l = new SyncLedger(dbPath()); l.upsertPending(KEY); return l; };

const prep: PrepSpec = {
  segments: ["/n/recordings/a.ts", "/n/recordings/b.ts"], stageDir: "/n/stage/k", stem: "s",
  mergeSegments: true, segmentGroupSec: 3600, minSegmentSec: 2, tsDirect: false,
};
const meta: BiliupMeta = { cookies: "/n/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 900 };
const input = (over: Partial<BiliupMeta> = {}): DispatchInput => ({ prep, meta: { ...meta, ...over }, owner: { streamKey: KEY }, now: () => 1000 });

/** In-memory stand-in for a node: idempotent enqueue, receipts on demand, optional "accepted but timed out". */
function fakeNode(): Transport & {
  jobs: Map<string, ProcessJob>; receipts: Map<string, ProcessReceipt>; calls: ProcessJob[]; failNextEnqueue: "before" | "after" | null;
} {
  const n = {
    id: "n1", jobs: new Map<string, ProcessJob>(), receipts: new Map<string, ProcessReceipt>(), calls: [] as ProcessJob[],
    failNextEnqueue: null as "before" | "after" | null,
    async enqueue(req: EnqueueRequest): Promise<EnqueueResponse> {
      const mode = n.failNextEnqueue;
      n.failNextEnqueue = null;
      if (mode === "before") throw new Error("ssh timeout");
      for (const j of req.jobs) {
        n.calls.push(j);
        if (!n.jobs.has(j.jobId)) {
          n.jobs.set(j.jobId, j);
          n.receipts.set(j.jobId, { jobId: j.jobId, state: "pending", leaseAlive: true });
        }
      }
      if (mode === "after") throw new Error("ssh timeout");
      return { v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId, state: n.receipts.get(j.jobId)!.state as "pending" })) };
    },
    async procStatus(ids: string[]): Promise<ProcessReceipt[]> { return ids.flatMap((id) => (n.receipts.has(id) ? [n.receipts.get(id)!] : [])); },
  };
  return n as never;
}

describe("ensureUploadPlan", () => {
  it("persists on first call and reuses it afterwards, never recomputing the generation", () => {
    const l = fresh();
    const a = ensureUploadPlan(l, KEY, "n1");
    expect(a).toMatchObject({ v: 1, nodeId: "n1", orderKey: KEY, generation: 1, ...planJobIds(KEY, 1) });
    expect(ensureUploadPlan(l, KEY, "n1", 7)).toEqual(a);
    expect(JSON.parse(l.getUploadPlan(KEY)!)).toEqual(a);
  });

  it("refuses to move a pinned order to another node", () => {
    const l = fresh();
    ensureUploadPlan(l, KEY, "n1");
    expect(() => ensureUploadPlan(l, KEY, "n2")).toThrow(/pinned to node n1/);
  });

  it("throws when the ledger has no row, or the stored plan is malformed", () => {
    expect(() => ensureUploadPlan(new SyncLedger(dbPath()), "ghost", "n1")).toThrow(/no ledger row/);
    const l = fresh();
    l.setUploadPlan(KEY, JSON.stringify({ v: 1, nodeId: "n1" }));
    expect(() => ensureUploadPlan(l, KEY, "n1")).toThrow(/malformed/);
  });

  it("an old sync_jobs table gains uploadPlan; old rows read as null and can claim", () => {
    const p = dbPath();
    const raw = new DatabaseSync(p);
    raw.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL, winnerWorker TEXT, bv TEXT,
      error TEXT, fails INTEGER NOT NULL DEFAULT 0, startMs INTEGER, updatedAt INTEGER NOT NULL)`);
    raw.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, 'done', 1)").run(KEY);
    raw.close();
    const l = new SyncLedger(p);
    expect(l.get(KEY)?.uploadPlan ?? null).toBeNull();
    expect(l.getUploadPlan(KEY)).toBeNull();
    expect(ensureUploadPlan(l, KEY, "n1").generation).toBe(1);
  });
});

describe("advanceUpload", () => {
  it("enqueues prep first with fixed ids, ordering fields and no source replacement", async () => {
    const node = fakeNode();
    const plan = ensureUploadPlan(fresh(), KEY, "n1");
    const out = await advanceUpload(node, plan, input());
    expect(out).toMatchObject({ phase: "prep-enqueued", result: { jobId: plan.prepJobId, state: "pending" } });
    expect(node.calls).toHaveLength(1);
    expect(node.calls[0]).toMatchObject({
      kind: "upload-prep", jobId: plan.prepJobId, orderKey: KEY, seq: 1, replaceInputs: false, inputs: prep.segments,
      params: { stageDir: "/n/stage/k", stem: "s", mergeSegments: true, tsDirect: false },
    });
  });

  it("re-entry after an accepted-but-timed-out enqueue creates no duplicate job", async () => {
    const node = fakeNode();
    const plan = ensureUploadPlan(fresh(), KEY, "n1");
    node.failNextEnqueue = "after";
    await expect(advanceUpload(node, plan, input())).rejects.toThrow(/timeout/);
    expect(await advanceUpload(node, plan, input())).toMatchObject({ phase: "prep-waiting", state: "pending" });
    expect(node.jobs.size).toBe(1);
    expect(node.calls).toHaveLength(1);
  });

  it("re-entry after a rejected-before-accept timeout enqueues the same job id", async () => {
    const node = fakeNode();
    const plan = ensureUploadPlan(fresh(), KEY, "n1");
    node.failNextEnqueue = "before";
    await expect(advanceUpload(node, plan, input())).rejects.toThrow(/timeout/);
    await advanceUpload(node, plan, input());
    expect([...node.jobs.keys()]).toEqual([plan.prepJobId]);
  });

  it("waits while prep runs, reports prep failure, and blocks when a done receipt has no outputs", async () => {
    const node = fakeNode();
    const plan = ensureUploadPlan(fresh(), KEY, "n1");
    await advanceUpload(node, plan, input());
    const set = (r: Partial<ProcessReceipt>): void => { node.receipts.set(plan.prepJobId, { jobId: plan.prepJobId, state: "pending", leaseAlive: true, ...r }); };
    set({ state: "running" });
    expect(await advanceUpload(node, plan, input())).toEqual({ phase: "prep-waiting", state: "running" });
    set({ state: "failed", error: "boom" });
    expect(await advanceUpload(node, plan, input())).toEqual({ phase: "prep-failed", state: "failed", error: "boom" });
    set({ state: "done" });
    expect(await advanceUpload(node, plan, input())).toMatchObject({ phase: "blocked" });
    expect(node.jobs.has(plan.biliupJobId)).toBe(false);
  });

  it("after prep is done, enqueues biliup bound to the prep outputs, then reports its receipt", async () => {
    const node = fakeNode();
    const plan = ensureUploadPlan(fresh(), KEY, "n1");
    await advanceUpload(node, plan, input());
    const parts = ["/n/stage/k/s_000.mp4", "/n/stage/k/s_001.mp4"];
    node.receipts.set(plan.prepJobId, { jobId: plan.prepJobId, state: "done", outputs: parts, leaseAlive: true });
    const out = await advanceUpload(node, plan, input());
    expect(out).toMatchObject({ phase: "biliup-enqueued", result: { jobId: plan.biliupJobId } });
    const job = node.jobs.get(plan.biliupJobId)!;
    expect(job).toMatchObject({
      kind: "biliup", orderKey: KEY, seq: 2, prepJobId: plan.prepJobId, inputs: parts, replaceInputs: false,
      params: { cookies: "/n/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 900 },
    });
    // Next poll: the node knows the biliup row, so nothing is enqueued again.
    const again = await advanceUpload(node, plan, input());
    expect(again).toMatchObject({ phase: "biliup", receipt: { jobId: plan.biliupJobId, state: "pending" } });
    expect(node.calls.filter((j) => j.kind === "biliup")).toHaveLength(1);
  });

  it("refuses without expectedDurationSec before touching the node, and needs enqueue/status channels", async () => {
    const node = fakeNode();
    const plan = ensureUploadPlan(fresh(), KEY, "n1");
    await expect(advanceUpload(node, plan, input({ expectedDurationSec: 0 }))).rejects.toThrow(/expectedDurationSec/);
    expect(node.calls).toHaveLength(0);
    await expect(advanceUpload({ id: "x" } as Transport, plan, input())).rejects.toBeInstanceOf(ProcUnsupported);
    const noEnqueue = { id: "x", procStatus: async () => [] } as unknown as Transport;
    await expect(advanceUpload(noEnqueue, plan, input())).rejects.toBeInstanceOf(ProcUnsupported);
  });
});
