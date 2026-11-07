import type { QueueFlowRow, QueueGroupId } from "./queue-flow";

export interface QueueRowSummary {
  key: string;
  vars: Record<string, string | number>;
}

export type QueueRowGroup = Exclude<QueueGroupId, "attention">;

/** Human-readable one-line conclusion for each group; all values come from the DTO. */
export function queueRowSummary(row: QueueFlowRow, group: QueueRowGroup, now: number): QueueRowSummary {
  if (group === "running") {
    const vars: Record<string, string | number> = {
      step: row.currentStep ?? "preparing",
      current: row.stepIndex || 1,
      total: row.stepCount || 1,
    };
    return row.etaSec == null
      ? { key: "queue.flow.summary.running", vars }
      : { key: "queue.flow.summary.runningEta", vars: { ...vars, eta: row.etaSec } };
  }
  if (group === "queued") {
    if (row.resource == null) return { key: "queue.flow.summary.queuedNoResource", vars: { position: row.queuePosition ?? 1 } };
    return { key: "queue.flow.summary.queued", vars: { resource: row.resource, position: row.queuePosition ?? 1 } };
  }
  if (group === "settling") {
    if (row.waitsFromMs == null) return { key: "queue.flow.summary.settling", vars: {} };
    return { key: "queue.flow.summary.settlingFor", vars: { since: Math.max(0, Math.round((now - row.waitsFromMs) / 1000)) } };
  }
  if (!row.bv) return { key: "queue.flow.summary.doneNoBv", vars: { duration: row.videoDurationSec ?? -1, time: row.finishedAt ?? 0 } };
  return {
    key: "queue.flow.summary.done",
    vars: { duration: row.videoDurationSec ?? -1, bv: row.bv, time: row.finishedAt ?? 0 },
  };
}
