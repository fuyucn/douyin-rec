/**
 * Snapshot of one queue poll for the queue page (plan 038 PR5).
 *
 * Display only: the ledger state machine never reads it. Stored as JSON on `sync_jobs.uploadStatus` so the
 * web layer can show node, step, heartbeat and byte progress without its own SSH round trip.
 */
import type { NodeUploadStatusDTO, ProcessReceipt } from "@drec/core";
import type { UploadDispatch, UploadPlan } from "./node-upload-queue.js";

const EMPTY = {
  state: null, step: null, attempts: null, notBefore: null, heartbeatAt: null, leaseAlive: null, progress: null, bv: null, error: null,
} as const;

function fromReceipt(r: ProcessReceipt): Omit<NodeUploadStatusDTO, "nodeId" | "phase" | "polledAt"> {
  return {
    state: r.state, step: r.step ?? null, attempts: r.attempts ?? null, notBefore: r.notBefore ?? null,
    heartbeatAt: r.heartbeatAt ?? null, leaseAlive: r.leaseAlive, progress: r.progress ?? null, bv: r.bv ?? null, error: r.error ?? null,
  };
}

export function uploadStatusOf(plan: Pick<UploadPlan, "nodeId">, d: UploadDispatch, polledAt: number): NodeUploadStatusDTO {
  const base = { nodeId: plan.nodeId, polledAt };
  switch (d.phase) {
    case "prep-enqueued": return { ...base, ...EMPTY, phase: "prep", state: d.result.state, error: d.result.error ?? null };
    case "prep-waiting": return { ...base, ...EMPTY, phase: "prep", state: d.state };
    case "prep-failed": return { ...base, ...EMPTY, phase: "prep", state: d.state, error: d.error ?? null };
    case "blocked": return { ...base, ...EMPTY, phase: "blocked", error: d.reason };
    case "biliup-enqueued": return { ...base, ...EMPTY, phase: "biliup", state: d.result.state, error: d.result.error ?? null };
    case "biliup": return { ...base, phase: "biliup", ...fromReceipt(d.receipt) };
  }
}
