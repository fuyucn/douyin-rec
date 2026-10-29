// plan 038 PR5: queue poll snapshot for the queue page (display only).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NodeUploadStatusDTO, ProcessReceipt } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { createUploadQueuePoller } from "../../packages/orchestrator/src/node-upload-poll.js";
import { ensureUploadPlan, type UploadInput } from "../../packages/orchestrator/src/node-upload-queue.js";
import { uploadStatusOf } from "../../packages/orchestrator/src/node-upload-status.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:1:2026-10-17";
const input: UploadInput = {
  prep: { segments: ["/n/recordings/a.ts"], stageDir: "/n/stage/k", stem: "s", mergeSegments: true, segmentGroupSec: 0, minSegmentSec: 2, tsDirect: false },
  meta: { cookies: "/n/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 600 },
  owner: { streamKey: KEY },
};
const plan = { nodeId: "n1" };

describe("uploadStatusOf", () => {
  it("maps every dispatch phase", () => {
    expect(uploadStatusOf(plan, { phase: "prep-enqueued", result: { jobId: "p", state: "pending" } }, 5)).toMatchObject({ phase: "prep", state: "pending", polledAt: 5 });
    expect(uploadStatusOf(plan, { phase: "prep-waiting", state: "running" }, 5)).toMatchObject({ phase: "prep", state: "running" });
    expect(uploadStatusOf(plan, { phase: "prep-failed", state: "failed", error: "x" }, 5)).toMatchObject({ phase: "prep", error: "x" });
    expect(uploadStatusOf(plan, { phase: "blocked", reason: "why" }, 5)).toMatchObject({ phase: "blocked", state: null, error: "why" });
    expect(uploadStatusOf(plan, { phase: "biliup-enqueued", result: { jobId: "b", state: "rejected", error: "no" } }, 5)).toMatchObject({ phase: "biliup", state: "rejected", error: "no" });
    const receipt: ProcessReceipt = {
      jobId: "b", state: "running", step: "transfer", leaseAlive: true, attempts: 2, notBefore: null, heartbeatAt: 4,
      progress: { doneBytes: 1, totalBytes: 2, bps: 3, at: 4 },
    };
    expect(uploadStatusOf(plan, { phase: "biliup", receipt }, 5)).toEqual({
      nodeId: "n1", phase: "biliup", state: "running", step: "transfer", attempts: 2, notBefore: null, heartbeatAt: 4,
      leaseAlive: true, progress: { doneBytes: 1, totalBytes: 2, bps: 3, at: 4 }, bv: null, error: null, polledAt: 5,
    } satisfies NodeUploadStatusDTO);
  });

  it("an old node receipt without the new fields maps them to null", () => {
    expect(uploadStatusOf(plan, { phase: "biliup", receipt: { jobId: "b", state: "pending", leaseAlive: false } }, 5))
      .toMatchObject({ attempts: null, heartbeatAt: null, progress: null, notBefore: null });
  });
});

describe("poller stores the snapshot", () => {
  function setup(procStatus: Transport["procStatus"]) {
    const ledger = new SyncLedger(join(mkdtempSync(join(tmpdir(), "nus-")), "j.db"));
    ledger.upsertPending(KEY);
    ensureUploadPlan(ledger, KEY, "n1", input);
    const enqueue = vi.fn(async (req: { jobs: { jobId: string }[] }) => ({ v: 1 as const, results: req.jobs.map((j) => ({ jobId: j.jobId, state: "pending" as const })) }));
    const t = { id: "n1", procStatus, enqueue } as unknown as Transport;
    const clock = { t: 1_000 };
    return { ledger, clock, transports: () => new Map([["n1", t]]) };
  }
  const snap = (l: SyncLedger) => JSON.parse(l.get(KEY)!.uploadStatus ?? "null") as NodeUploadStatusDTO | null;

  it("writes the observation; an unreachable poll keeps the last one (its polledAt shows the age)", async () => {
    let up = true;
    const s = setup(async () => { if (!up) throw new Error("ssh timeout"); return []; });
    const poller = createUploadQueuePoller({ ledger: s.ledger, transports: s.transports, unreachableAlertMs: 1, now: () => s.clock.t });
    await poller.poll();
    expect(snap(s.ledger)).toMatchObject({ nodeId: "n1", phase: "prep", state: "pending", polledAt: 1_000 });
    up = false;
    s.clock.t = 2_000;
    await poller.poll();
    expect(snap(s.ledger)?.polledAt).toBe(1_000);
  });

  it("a failed snapshot write never blocks the outcome callback", async () => {
    const s = setup(async () => []);
    const ledger = new Proxy(s.ledger, {
      get: (target, k) => k === "setUploadStatus" ? () => { throw new Error("disk full"); } : (target as never)[k as never],
    });
    const onDispatch = vi.fn();
    const log = vi.fn();
    const poller = createUploadQueuePoller({ ledger, transports: s.transports, unreachableAlertMs: 1, onDispatch, log });
    await poller.poll();
    expect(onDispatch).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.some(([m]) => /status snapshot not saved/.test(String(m)))).toBe(true);
  });
});
