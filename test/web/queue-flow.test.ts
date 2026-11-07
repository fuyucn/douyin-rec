import { describe, expect, it } from "vitest";
import { STAGE_READY } from "../../packages/core/src/hub-ledger-contract.js";
import { QUEUE_PHASES, type HubBlockedBroadcastDTO, type QueueItemDTO, type QueuePhase } from "../../packages/core/src/api-types.js";
import { buildQueueFlow, queueFlowSteps, type QueueFlowGroups } from "../../packages/web/src/lib/queue-flow.js";
import { queueRowSummary } from "../../packages/web/src/lib/queue-summary.js";

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

/** Every row that reaches the page: actions carry a row too, blocked rows have no ledger row. */
function renderedRowCount(flow: QueueFlowGroups): number {
  return flow.actions.filter((a) => a.kind === "row").length
    + flow.actions.filter((a) => a.kind === "blocked").length
    + flow.running.length
    + flow.queued.length
    + flow.settling.length
    + flow.done.length;
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

  it("does not render a retried node twice (done + current)", () => {
    const item = row({
      streamKey: "douyin:1:2026-11-06",
      phase: "running",
      doneSteps: [{ step: "merge", phase: "done", at: 1 }],
      currentNode: "merge",
      nextSteps: [],
    });
    expect(queueFlowSteps(item).map((s) => [s.step, s.state])).toEqual([["merge", "current"]]);
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
      row({ streamKey: "i", phase: "stopped", error: "用户停止" }),
    ], [], 0, 1000, 1000);
    expect(flow.counts).toEqual({ running: 1, queued: 2, actions: 4, done: 1, settling: 1 });
    expect(flow.actions.map((a) => a.key)).toEqual(["row-a", "row-f", "row-g", "row-i"]);
    expect(flow.queued.map((r) => r.key)).toEqual(["d", "c"]);
    expect(flow.running[0]?.elapsedSec).toBe(83);
    expect(flow.running[0]?.etaSec).toBe(120);
    expect(flow.done[0]?.bv).toBe("BV1");
  });

  it("places every QueuePhase in exactly one group and never drops a row", () => {
    const rows = QUEUE_PHASES.map((phase: QueuePhase, index) => row({
      streamKey: `p-${phase}`,
      phase,
      enqueuedAt: index,
      finishedAt: phase === "done" ? 1000 + index : null,
      ...(phase === "waiting_manual" ? { error: "boom" } : {}),
    }));
    const flow = buildQueueFlow(rows, [], 0, 1000, 1000);
    expect(renderedRowCount(flow)).toBe(QUEUE_PHASES.length);
    expect(flow.counts.running + flow.counts.queued + flow.counts.actions + flow.counts.done + flow.counts.settling)
      .toBe(QUEUE_PHASES.length);
    expect(flow.counts).toEqual({ running: 1, queued: 1, actions: 4, done: 1, settling: 1 });
  });

  it("counts blocked broadcasts as actions with a reason and preserves their workers", () => {
    const blocked: HubBlockedBroadcastDTO = {
      streamKey: "douyin:9:2026-11-06", platform: "douyin", roomSlug: "9", workers: ["node-a"],
      sinceMs: 1, rounds: 2, threshold: 6,
    };
    const flow = buildQueueFlow([], [blocked], 0, 1000, 1000);
    expect(flow.actions).toHaveLength(1);
    expect(flow.actions[0]).toMatchObject({ kind: "blocked", severity: "error", needsAck: false });
    expect(flow.actions[0]?.blocked?.workers).toEqual(["node-a"]);
  });

  it("counts the running header from rows plus rendered live lanes only", () => {
    const rows = [row({ streamKey: "r", phase: "running" })];
    const withLanes = buildQueueFlow(rows, [], 2, 0, 0);
    expect(withLanes.counts.running).toBe(3);
    expect(withLanes.running.length + withLanes.delivering).toBe(withLanes.counts.running);
    const noLanes = buildQueueFlow(rows, [], 0, 0, 0);
    expect(noLanes.counts.running).toBe(1);
    expect(noLanes.delivering).toBe(0);
  });

  it("uses snapshot age for local elapsed and ETA without going negative", () => {
    const flow = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentStepSec: 10, etaSec: 20 }),
    ], [], 0, 15_000, 0);
    expect(flow.running[0]?.elapsedSec).toBe(25);
    expect(flow.running[0]?.etaSec).toBe(5);
    const late = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentStepSec: 10, etaSec: 20 }),
    ], [], 0, 60_000, 0);
    expect(late.running[0]?.etaSec).toBe(0);
  });

  it("keeps newest finished runs first by default and can flip to oldest", () => {
    const rows = [
      row({ streamKey: "old", phase: "done", finishedAt: 100 }),
      row({ streamKey: "new", phase: "done", finishedAt: 900, videoDurationSec: 7938 }),
    ];
    const newest = buildQueueFlow(rows, [], 0, 1000, 1000);
    expect(newest.done.map((r) => r.key)).toEqual(["new", "old"]);
    expect(newest.done[0]?.videoDurationSec).toBe(7938);
    expect(buildQueueFlow(rows, [], 0, 1000, 1000, "oldest").done.map((r) => r.key)).toEqual(["old", "new"]);
  });
});

describe("attention reasons", () => {
  const reasonOf = (item: QueueItemDTO): string =>
    buildQueueFlow([item], [], 0, 0, 0).actions[0]!.reason;

  it("localizes the stage-ready and stopped sentinels instead of leaking the raw ledger text", () => {
    expect(reasonOf(row({ streamKey: "s", phase: "waiting_upload", error: STAGE_READY }))).toBe("queue.flow.reason.stageReady");
    expect(reasonOf(row({ streamKey: "s2", phase: "waiting_upload", error: "用户停止" }))).toBe("queue.flow.reason.stageReady");
    expect(reasonOf(row({ streamKey: "t", phase: "stopped", error: "用户停止" }))).toBe("queue.flow.reason.stopped");
    expect(reasonOf(row({ streamKey: "t2", phase: "stopped", error: null }))).toBe("queue.flow.reason.stopped");
  });

  it("keeps a real failure message and uses a label for a reason-less failure", () => {
    expect(reasonOf(row({ streamKey: "f", phase: "failed", error: "ffmpeg exited 1" }))).toBe("ffmpeg exited 1");
    expect(reasonOf(row({ streamKey: "f2", phase: "failed", error: null }))).toBe("queue.flow.reason.failed");
    expect(reasonOf(row({ streamKey: "m", phase: "waiting_manual", error: null }))).toBe("queue.flow.reason.manual");
  });
});

describe("queue row summaries", () => {
  it("describes the current step, ETA, resource position, wait and finished result", () => {
    const running = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentNode: "merge", doneSteps: [{ step: "select", phase: "done", at: 1 }], nextSteps: ["burn"], etaSec: 120 }),
    ], [], 0, 0, 0).running[0]!;
    expect(queueRowSummary(running, "running", 0)).toEqual({
      key: "queue.flow.summary.runningEta",
      vars: { step: "merge", current: 2, total: 3, eta: 120 },
    });
    const queued = buildQueueFlow([
      row({ streamKey: "q", phase: "queued", queuePosition: 2, resource: "cpu" }),
    ], [], 0, 0, 0).queued[0]!;
    expect(queueRowSummary(queued, "queued", 0)).toEqual({
      key: "queue.flow.summary.queued",
      vars: { resource: "cpu", position: 2 },
    });
    const settling = buildQueueFlow([
      row({ streamKey: "s", phase: "waiting_settle", enqueuedAt: 0 }),
    ], [], 0, 180_000, 0).settling[0]!;
    expect(queueRowSummary(settling, "settling", 180_000)).toEqual({
      key: "queue.flow.summary.settlingFor",
      vars: { since: 180 },
    });
    const done = buildQueueFlow([
      row({ streamKey: "d", phase: "done", bv: "BV1", videoDurationSec: 7938, finishedAt: 1000 }),
    ], [], 0, 0, 0).done[0]!;
    expect(queueRowSummary(done, "done", 0)).toEqual({
      key: "queue.flow.summary.done",
      vars: { duration: 7938, bv: "BV1", time: 1000 },
    });
  });

  it("never leaves a dangling resource word or an empty BV", () => {
    const queued = buildQueueFlow([
      row({ streamKey: "q", phase: "queued", queuePosition: 1, resource: null }),
    ], [], 0, 0, 0).queued[0]!;
    expect(queueRowSummary(queued, "queued", 0)).toEqual({
      key: "queue.flow.summary.queuedNoResource",
      vars: { position: 1 },
    });
    const done = buildQueueFlow([
      row({ streamKey: "d", phase: "done", bv: null, videoDurationSec: 60, finishedAt: 500 }),
    ], [], 0, 0, 0).done[0]!;
    expect(queueRowSummary(done, "done", 0)).toEqual({
      key: "queue.flow.summary.doneNoBv",
      vars: { duration: 60, time: 500 },
    });
  });

  it("uses a no-ETA sentence and a missing-retry note without inventing values", () => {
    const running = buildQueueFlow([
      row({ streamKey: "r", phase: "running", currentNode: "merge", etaSec: null }),
    ], [], 0, 0, 0).running[0]!;
    expect(queueRowSummary(running, "running", 0)).toEqual({
      key: "queue.flow.summary.running",
      vars: { step: "merge", current: 1, total: 1 },
    });
    const settling = buildQueueFlow([
      row({ streamKey: "s", phase: "waiting_settle", enqueuedAt: null, updatedAt: 0 }),
    ], [], 0, 0, 0).settling[0]!;
    expect(queueRowSummary(settling, "settling", 0)).toEqual({ key: "queue.flow.summary.settling", vars: {} });
  });
});
