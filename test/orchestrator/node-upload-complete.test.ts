// plan 038 T13c: queue observations -> ledger. Success needs a BV; everything else is needs_manual; no deletion.
import { describe, it, expect, vi } from "vitest";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifyEvent, ProcessReceipt } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { applyUploadOutcome, completeFromDispatch, mapUploadOutcome } from "../../packages/orchestrator/src/node-upload-complete.js";
import { createUploadQueuePoller } from "../../packages/orchestrator/src/node-upload-poll.js";
import { ensureUploadPlan, planJobIds, type UploadDispatch, type UploadInput } from "../../packages/orchestrator/src/node-upload-queue.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:1:2026-10-17";
const BV = "BV1abcdefghi"; // issue-guard: allow (fake BV fixture)
const receipt = (over: Partial<ProcessReceipt>): ProcessReceipt => ({ jobId: "j", state: "done", leaseAlive: true, ...over });
const biliup = (over: Partial<ProcessReceipt>): UploadDispatch => ({ phase: "biliup", receipt: receipt(over) });

function uploadingLedger(): SyncLedger {
  const l = new SyncLedger(join(mkdtempSync(join(tmpdir(), "nuc-")), "j.db"));
  l.upsertPending(KEY);
  l.setState(KEY, "syncing"); l.setState(KEY, "merging"); l.setState(KEY, "uploading");
  return l;
}

describe("mapUploadOutcome", () => {
  it("done with a BV completes; done without a BV needs a human", () => {
    expect(mapUploadOutcome(biliup({ state: "done", bv: BV }))).toEqual({ action: "done", bv: BV });
    expect(mapUploadOutcome(biliup({ state: "done" }))).toMatchObject({ action: "needs_manual", reason: expect.stringMatching(/without reporting a BV/) });
  });

  it("pending/running only checkpoints a known BV", () => {
    expect(mapUploadOutcome(biliup({ state: "running", bv: BV }))).toEqual({ action: "checkpoint", bv: BV });
    expect(mapUploadOutcome(biliup({ state: "pending" }))).toEqual({ action: "none" });
  });

  it.each(["failed", "uncertain", "cancelled"] as const)("%s needs a human and keeps the error, step and draft hint", (state) => {
    const o = mapUploadOutcome(biliup({ state, error: "boom", step: "submit", bv: BV }));
    expect(o).toMatchObject({ action: "needs_manual" });
    const reason = (o as { reason: string }).reason;
    expect(reason).toContain(state);
    expect(reason).toContain("boom");
    expect(reason).toContain("submit");
    expect(reason).toContain("recover-order --bv");
  });

  it("prep failure, blocked prep and rejected/stale enqueues need a human; in-progress phases do nothing", () => {
    expect(mapUploadOutcome({ phase: "prep-failed", state: "failed", error: "x" })).toMatchObject({ action: "needs_manual", reason: expect.stringContaining("recover-order --prep") });
    expect(mapUploadOutcome({ phase: "blocked", reason: "no outputs" })).toEqual({ action: "needs_manual", reason: "no outputs" });
    expect(mapUploadOutcome({ phase: "biliup-enqueued", result: { jobId: "j", state: "rejected", error: "bad", existingState: "failed" } }))
      .toMatchObject({ action: "needs_manual", reason: expect.stringMatching(/rejected: bad.*existing row failed/) });
    expect(mapUploadOutcome({ phase: "prep-enqueued", result: { jobId: "j", state: "stale" } })).toMatchObject({ action: "needs_manual" });
    expect(mapUploadOutcome({ phase: "prep-enqueued", result: { jobId: "j", state: "pending" } })).toEqual({ action: "none" });
    expect(mapUploadOutcome({ phase: "prep-waiting", state: "running" })).toEqual({ action: "none" });
  });
});

describe("applyUploadOutcome", () => {
  it("done writes the BV and marks the order done", () => {
    const l = uploadingLedger();
    completeFromDispatch(l, KEY, biliup({ state: "done", bv: BV }));
    expect(l.get(KEY)).toMatchObject({ state: "done", bv: BV });
  });

  it("failure maps to needs_manual (never failed) and notifies exactly once across repeated polls", () => {
    const l = uploadingLedger();
    const notify = vi.fn<(e: NotifyEvent) => void>();
    for (let i = 0; i < 3; i++) completeFromDispatch(l, KEY, biliup({ state: "uncertain", error: "submit unknown" }), notify);
    expect(l.get(KEY)).toMatchObject({ state: "needs_manual", error: expect.stringContaining("submit unknown") });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("a checkpoint records the BV without changing state", () => {
    const l = uploadingLedger();
    applyUploadOutcome(l, KEY, { action: "checkpoint", bv: BV });
    expect(l.get(KEY)).toMatchObject({ state: "uploading", bv: BV });
  });
});

describe("queue completion never touches recordings", () => {
  it("poller -> completion on done leaves the source files and node channels untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nuc-rec-"));
    const rec = join(dir, "a.ts");
    writeFileSync(rec, "x");
    const l = uploadingLedger();
    const input: UploadInput = {
      prep: { segments: [rec], stageDir: join(dir, "stage"), stem: "s", mergeSegments: true, segmentGroupSec: 0, minSegmentSec: 2, tsDirect: false },
      meta: { cookies: "/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 60 },
      owner: { streamKey: KEY },
    };
    const plan = ensureUploadPlan(l, KEY, "n1", input);
    const ids = planJobIds(KEY, 1);
    const calls: string[] = [];
    const t = {
      id: "n1",
      procStatus: async (): Promise<ProcessReceipt[]> => { calls.push("procStatus"); return [receipt({ jobId: ids.biliupJobId, state: "done", bv: BV })]; },
      enqueue: async () => { calls.push("enqueue"); return { v: 1 as const, results: [] }; },
      pull: async () => { calls.push("pull"); },
      abortNodePipeline: async () => { calls.push("abort"); return { aborted: true }; },
    } as unknown as Transport;
    const poller = createUploadQueuePoller({
      ledger: l, transports: () => new Map([["n1", t]]), unreachableAlertMs: 1e9,
      onDispatch: (k, _p, d) => completeFromDispatch(l, k, d),
    });
    await poller.poll();
    expect(plan.nodeId).toBe("n1");
    expect(l.get(KEY)).toMatchObject({ state: "done", bv: BV });
    expect(existsSync(rec)).toBe(true);
    expect(calls).toEqual(["procStatus"]);
  });
});
