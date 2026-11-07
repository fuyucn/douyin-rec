import { describe, expect, it } from "vitest";
import { buildQueueFlow, queueFlowSteps } from "../../packages/web/src/lib/queue-flow.js";
import { queueRowSummary } from "../../packages/web/src/lib/queue-summary.js";
import type { HubBlockedBroadcastDTO, QueueItemDTO } from "../../packages/core/src/api-types.js";

function row(patch: Partial<QueueItemDTO> & Pick<QueueItemDTO, "streamKey" | "phase">): QueueItemDTO {
  return {
    platform: "douyin",
    roomSlug: "1",
    anchorName: "Alice",
    state: "pending",
    resource: null,
    queuePosition: null,
    currentNode: null,
    doneSteps: [],
    nextSteps: [],
    currentStepSec: null,
    etaSec: null,
    winnerWorker: null,
    fails: 0,
    updatedAt: 100,
    error: null,
    bv: null,
    videoDurationSec: null,
    finishedAt: null,
    enqueuedAt: 100,
    nodeUpload: null,
    ...patch,
  };
}

describe("queue flow steps", () => {
  it("keeps done, current and next in ledger order and de-duplicates repeated steps", () => {
    const item = row({
      streamKey: "douyin:1:2026-11-06",
      phase: "running",
      doneSteps: [
        { step: "select", phase: "done", at: 1 },
        { step: "pull", phase: "done", at: 2 },
        { step: "pull", phase: "done", at: 3 },
      ],
      currentNode: "merge",
      nextSteps: ["pull", "burn_danmu", "upload_plain"],
    });
    expect(queueFlowSteps(item).map((s) => [s.step, s.state])).toEqual([
      ["select", "done"],
      ["pull", "done"],
      ["merge", "current"],
      ["burn_danmu", "next"],
      ["upload_plain", "next"],
    ]);
  });

  it("shows skipped steps with a distinct state and does not repeat a done step", () => {
    const item = row({
      streamKey: "douyin:1:2026-11-06",
      phase: "running",
      doneSteps: [
        { step: "select", phase: "done", at: 1 },
        { step: "burn_danmu", phase: "skipped", at: 2 },
      ],
      currentNode: "upload_plain",
      nextSteps: ["cleanup"],
    });
    expect(queueFlowSteps(item).map((s) => [s.step, s.state])).toEqual([
      ["select", "done"],
      ["burn_danmu", "skipped"],
      ["upload_plain", "current"],
      ["cleanup", "next"],
    ]);
  });
});

describe("queue flow groups", () => {
  it("orders action, running, queued, settle and done without mixing phases", () => {
    const flow = buildQueueFlow([
      row({ streamKey: "h", phase: "done", finishedAt: 1000, bv: "BV1", videoDurationSec: 7938 }),
      row({ streamKey: "e", phase: "waiting_settle", enqueuedAt: 10 }),
      row({ streamKey: "c", phase: "queued", queuePosition: 2, resource: "cpu" }),
      row({ streamKey: "d", phase: "queued", queuePosition: 1, resource: "upload" }),
      row({ streamKey: "b", phase: "running", currentNode: "merge", currentStepSec: 83, etaSec: 120 }),
      row({ streamKey: "a", phase: "waiting_manual", error: "upload failed", fails: 3 }),
      row({ streamKey: "f", phase: "failed", error: "ffmpeg failed" }),
      row({ streamKey: "g", phase: "waiting_upload" }),
      row({ streamKey: "i", phase: "stopped", error: "user stopped" }),
    ], [], [], 1000, 1000);
    expect(flow.counts).toEqual({ running: 1, queued: 2, actions: 4, done: 1, settling: 1 });
    expect(flow.actions.map((a) => a.key)).toEqual(["row-a", "row-f", "row-g", "row-i"]);
    expect(flow.queued.map((r) => r.key)).toEqual(["d", "c"]);
    expect(flow.running[0]?.elapsedSec).toBe(83);
    expect(flow.running[0]?.etaSec).toBe(120);
    expect(flow.done[0]?.bv).toBe("BV1");
  });

  it("counts blocked broadcasts as actions with a reason and preserves their workers", () => {
    const blocked: HubBlockedBroadcastDTO = {
      streamKey: "douyin:9:2026-11-06", platform: "douyin", roomSlug: "9", workers: ["node-a"],
      sinceMs: 1, rounds: 2, threshold: 6,
    };
    const flow = buildQueueFlow([], [blocked], [], 1000, 1000);
    expect(flow.actions).toHaveLength(1);
    expect(flow.actions[0]).toMatchObject({ kind: "blocked", severity: "error", needsAck: false });
    expect(flow.actions[0]?.blocked?.workers).toEqual(["node-a"]);
  });

  it("uses snapshot age for local elapsed and ETA without going negative", () => {
    const flow = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentStepSec: 10, etaSec: 20 }),
    ], [], [], 15_000, 0);
    expect(flow.running[0]?.elapsedSec).toBe(25);
    expect(flow.running[0]?.etaSec).toBe(5);
    const late = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentStepSec: 10, etaSec: 20 }),
    ], [], [], 60_000, 0);
    expect(late.running[0]?.etaSec).toBe(0);
  });

  it("keeps newest finished runs first and exposes duration for a conclusion", () => {
    const flow = buildQueueFlow([
      row({ streamKey: "old", phase: "done", finishedAt: 100 }),
      row({ streamKey: "new", phase: "done", finishedAt: 900, videoDurationSec: 7938 }),
    ], [], [], 1000, 1000);
    expect(flow.done.map((r) => r.key)).toEqual(["new", "old"]);
    expect(flow.done[0]?.videoDurationSec).toBe(7938);
  });
});

describe("queue row summaries", () => {
  it("describes the current step, ETA, resource position, wait and finished result", () => {
    const running = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentNode: "merge", doneSteps: [{ step: "select", phase: "done", at: 1 }], nextSteps: ["burn"], etaSec: 120 }),
    ], [], [], 0, 0).running[0]!;
    expect(queueRowSummary(running, "running", 0)).toEqual({
      key: "queue.flow.summary.runningEta",
      vars: { step: "merge", current: 2, total: 3, eta: 120 },
    });
    const queued = buildQueueFlow([
      row({ streamKey: "q", phase: "queued", queuePosition: 2, resource: "cpu" }),
    ], [], [], 0, 0).queued[0]!;
    expect(queueRowSummary(queued, "queued", 0)).toEqual({
      key: "queue.flow.summary.queued",
      vars: { resource: "cpu", position: 2 },
    });
    const settling = buildQueueFlow([
      row({ streamKey: "s", phase: "waiting_settle", enqueuedAt: 0 }),
    ], [], [], 180_000, 0).settling[0]!;
    expect(queueRowSummary(settling, "settling", 180_000)).toEqual({
      key: "queue.flow.summary.settlingFor",
      vars: { since: 180 },
    });
    const done = buildQueueFlow([
      row({ streamKey: "d", phase: "done", bv: "BV1", videoDurationSec: 7938, finishedAt: 1000 }),
    ], [], [], 0, 0).done[0]!;
    expect(queueRowSummary(done, "done", 0)).toEqual({
      key: "queue.flow.summary.done",
      vars: { duration: 7938, bv: "BV1", time: 1000 },
    });
  });

  it("uses a no-ETA sentence and a missing-retry note without inventing values", () => {
    const running = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentNode: "merge", etaSec: null }),
    ], [], [], 0, 0).running[0]!;
    expect(queueRowSummary(running, "running", 0)).toEqual({
      key: "queue.flow.summary.running",
      vars: { step: "merge", current: 1, total: 1 },
    });
    const settling = buildQueueFlow([
      row({ streamKey: "s", phase: "waiting_settle", enqueuedAt: null, updatedAt: 0 }),
    ], [], [], 0, 0).settling[0]!;
    expect(queueRowSummary(settling, "settling", 0)).toEqual({ key: "queue.flow.summary.settling", vars: {} });
  });
});
