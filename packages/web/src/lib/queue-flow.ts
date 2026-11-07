/**
 * queue-flow.ts — the single ordered task stream behind the Queue page.
 *
 * Every row comes from the existing hub queue snapshot. This module decides only where a row is
 * shown and which facts form its step timeline; it never invents a backend state or progress.
 */
import type { HubBlockedBroadcastDTO, QueueItemDTO, QueuePhase } from "../api/client";
import { STAGE_READY } from "@drec/hub-ledger-contract";

export type QueueGroupId = "attention" | "running" | "queued" | "settling" | "done";

export interface QueueFlowStep {
  key: string;
  step: string;
  state: "done" | "current" | "next";
}

export interface QueueAction {
  key: string;
  kind: "row" | "blocked";
  streamKey: string;
  platform: string;
  roomSlug: string;
  anchorName: string | null;
  title: string;
  reason: string;
  severity: "error" | "warning" | "neutral";
  fails: number;
  needsAck: boolean;
  item?: QueueItemDTO;
  blocked?: HubBlockedBroadcastDTO;
}

export interface QueueFlowRow {
  key: string;
  item: QueueItemDTO;
  steps: QueueFlowStep[];
  currentStep: string | null;
  stepIndex: number;
  stepCount: number;
  elapsedSec: number | null;
  etaSec: number | null;
  queuePosition: number | null;
  resource: QueueItemDTO["resource"];
  finishedAt: number | null;
  videoDurationSec: number | null;
  bv: string | null;
  waitsFromMs: number | null;
}

export interface QueueFlowGroups {
  actions: QueueAction[];
  running: QueueFlowRow[];
  queued: QueueFlowRow[];
  settling: QueueFlowRow[];
  done: QueueFlowRow[];
  /** Zero-disk live lanes rendered under running (counted into `counts.running`). */
  delivering: number;
  counts: {
    running: number;
    queued: number;
    actions: number;
    done: number;
    settling: number;
  };
}

/**
 * Every QueuePhase belongs to exactly one section. Typed as a total map so adding a backend phase
 * without deciding where it renders is a compile error, never a row silently dropped from the page.
 */
const PHASE_SECTION: Record<QueuePhase, QueueGroupId> = {
  running: "running",
  queued: "queued",
  waiting_settle: "settling",
  waiting_manual: "attention",
  waiting_upload: "attention",
  stopped: "attention",
  failed: "attention",
  done: "done",
};

function rowWaitStart(item: QueueItemDTO): number | null {
  return item.enqueuedAt ?? (item.updatedAt > 0 ? item.updatedAt : null);
}

function dedupeSteps(steps: readonly string[]): string[] {
  return [...new Set(steps.filter(Boolean))];
}

/**
 * Build the compact done / current / next line from ledger steps only. The current node is
 * kept out of the done list so a retried node never renders as two same-named steps.
 */
export function queueFlowSteps(item: QueueItemDTO): QueueFlowStep[] {
  const done = dedupeSteps(item.doneSteps.map((step) => step.step))
    .filter((step) => step !== item.currentNode);
  const next = dedupeSteps(item.nextSteps).filter((step) => !done.includes(step) && step !== item.currentNode);
  const out: QueueFlowStep[] = [];
  for (const step of done) out.push({ key: `done-${step}`, step, state: "done" });
  if (item.currentNode) out.push({ key: `current-${item.currentNode}`, step: item.currentNode, state: "current" });
  for (const step of next) out.push({ key: `next-${step}`, step, state: "next" });
  return out;
}

function flowRow(item: QueueItemDTO, now: number, dataAt: number): QueueFlowRow {
  const drift = Math.max(0, Math.round((now - dataAt) / 1000));
  const steps = queueFlowSteps(item);
  const currentIndex = steps.findIndex((step) => step.state === "current");
  return {
    key: item.streamKey,
    item,
    steps,
    currentStep: item.currentNode,
    stepIndex: currentIndex >= 0 ? currentIndex + 1 : steps.filter((step) => step.state === "done").length,
    stepCount: steps.length,
    elapsedSec: item.currentStepSec == null ? null : Math.max(0, Math.round(item.currentStepSec + drift)),
    etaSec: item.etaSec == null ? null : Math.max(0, Math.round(item.etaSec - drift)),
    queuePosition: item.queuePosition,
    resource: item.resource,
    finishedAt: item.finishedAt,
    videoDurationSec: item.videoDurationSec,
    bv: item.bv,
    waitsFromMs: rowWaitStart(item),
  };
}

function attentionSeverity(item: QueueItemDTO): QueueAction["severity"] {
  if (item.phase === "failed" || item.phase === "waiting_manual") return "error";
  if (item.phase === "waiting_upload" || item.phase === "stopped") return "neutral";
  return "warning";
}

function attentionReason(item: QueueItemDTO): string {
  // Known sentinel states localize first so a non-zh UI never leaks the backend constants;
  // only a genuine failure message falls through to the raw ledger error.
  if (item.phase === "waiting_upload" || item.error === STAGE_READY) return "queue.flow.reason.stageReady";
  if (item.phase === "stopped") return "queue.flow.reason.stopped";
  if (item.error) return item.error;
  if (item.phase === "failed") return "queue.flow.reason.failed";
  if (item.phase === "waiting_manual") return "queue.flow.reason.manual";
  return "queue.flow.reason.stopped";
}

function rowAction(item: QueueItemDTO): QueueAction {
  return {
    key: `row-${item.streamKey}`,
    kind: "row",
    streamKey: item.streamKey,
    platform: item.platform,
    roomSlug: item.roomSlug,
    anchorName: item.anchorName,
    title: item.anchorName ?? item.roomSlug,
    reason: attentionReason(item),
    severity: attentionSeverity(item),
    fails: item.fails,
    needsAck: item.state === "needs_manual",
    item,
  };
}

function blockedAction(blocked: HubBlockedBroadcastDTO): QueueAction {
  return {
    key: `blocked-${blocked.streamKey}`,
    kind: "blocked",
    streamKey: blocked.streamKey,
    platform: blocked.platform,
    roomSlug: blocked.roomSlug,
    anchorName: blocked.anchorName ?? null,
    title: blocked.anchorName ?? blocked.roomSlug,
    reason: "queue.flow.reason.blocked",
    severity: "error",
    fails: blocked.rounds,
    needsAck: false,
    blocked,
  };
}

const ACTION_RANK: Record<QueueAction["severity"], number> = { error: 0, warning: 1, neutral: 2 };

function sortActions(actions: readonly QueueAction[]): QueueAction[] {
  return [...actions].sort((a, b) =>
    ACTION_RANK[a.severity] - ACTION_RANK[b.severity]
    || b.fails - a.fails
    || a.streamKey.localeCompare(b.streamKey));
}

function sortRows(rows: readonly QueueFlowRow[]): QueueFlowRow[] {
  return [...rows].sort((a, b) =>
    (a.queuePosition ?? Number.MAX_SAFE_INTEGER) - (b.queuePosition ?? Number.MAX_SAFE_INTEGER)
    || (a.waitsFromMs ?? a.item.updatedAt) - (b.waitsFromMs ?? b.item.updatedAt)
    || a.key.localeCompare(b.key));
}

function sortDone(rows: readonly QueueFlowRow[], sort: "newest" | "oldest"): QueueFlowRow[] {
  return [...rows].sort((a, b) => {
    const newest = (b.finishedAt ?? b.item.updatedAt) - (a.finishedAt ?? a.item.updatedAt);
    return (sort === "newest" ? newest : -newest) || a.key.localeCompare(b.key);
  });
}

/**
 * Split a snapshot into the five sections of one queue. Blocked broadcasts are actions because
 * they need a person even when no ledger row exists yet.
 */
export function buildQueueFlow(
  rows: readonly QueueItemDTO[],
  blocked: readonly HubBlockedBroadcastDTO[],
  deliveringCount: number,
  now: number,
  dataAt: number,
  sort: "newest" | "oldest" = "newest",
): QueueFlowGroups {
  const actions: QueueAction[] = [];
  const running: QueueFlowRow[] = [];
  const queued: QueueFlowRow[] = [];
  const settling: QueueFlowRow[] = [];
  const done: QueueFlowRow[] = [];
  for (const item of rows) {
    switch (PHASE_SECTION[item.phase]) {
      case "attention": actions.push(rowAction(item)); break;
      case "running": running.push(flowRow(item, now, dataAt)); break;
      case "queued": queued.push(flowRow(item, now, dataAt)); break;
      case "settling": settling.push(flowRow(item, now, dataAt)); break;
      case "done": done.push(flowRow(item, now, dataAt)); break;
    }
  }
  for (const item of blocked) actions.push(blockedAction(item));
  return {
    delivering: deliveringCount,
    actions: sortActions(actions),
    running: sortRows(running),
    queued: sortRows(queued),
    settling: sortRows(settling),
    done: sortDone(done, sort),
    // The running header counts exactly what renders: ledger rows plus the zero-disk lanes.
    counts: { running: running.length + deliveringCount, queued: queued.length, actions: actions.length, done: done.length, settling: settling.length },
  };
}

/** Group-level empty-state key, so the page never invents a second set of labels. */
export function queueEmptyKey(group: QueueGroupId): string {
  return `queue.flow.empty.${group}`;
}
