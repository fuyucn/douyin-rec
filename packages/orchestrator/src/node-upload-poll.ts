/**
 * Master-side poller for queue-managed uploads (plan 038 T13).
 *
 * One call advances every open order by at most one step (enqueue prep, enqueue biliup, or just observe).
 * It only reads node state and enqueues rows; it never aborts a node, never uploads directly and never
 * deletes files. A transport failure means "unknown": nothing changes and the next tick tries again.
 */
import type { NotifyEvent } from "@drec/core";
import type { SyncLedger } from "./ledger.js";
import { advanceUpload, type UploadDispatch, type UploadPlan } from "./node-upload-queue.js";
import { ProcUnsupported, type Transport } from "./transport.js";
import { uploadStatusOf } from "./node-upload-status.js";

export interface UploadPollerOpts {
  ledger: Pick<SyncLedger, "listUploadPlans" | "touch" | "setUploadStatus">;
  /** Getter, not a map: the hub reloads transports from config between ticks. */
  transports: () => Map<string, Transport>;
  unreachableAlertMs: number;
  notify?: (e: NotifyEvent) => void;
  log?: (m: string) => void;
  now?: () => number;
  /** Receives every observation so callers can map terminal queue states onto the ledger. */
  onDispatch?: (streamKey: string, plan: UploadPlan, d: UploadDispatch) => void | Promise<void>;
}

interface NodeHealth { since: number; alerted: boolean }

function parsePlan(json: string): UploadPlan | null {
  try {
    const p = JSON.parse(json) as UploadPlan;
    return p?.v === 1 && typeof p.nodeId === "string" && p.input ? p : null;
  } catch { return null; }
}

export function createUploadQueuePoller(o: UploadPollerOpts): { poll(): Promise<void> } {
  const now = o.now ?? Date.now;
  const down = new Map<string, NodeHealth>();

  const fail = (nodeId: string, streamKey: string, why: string, rolledBack: boolean): void => {
    const h = down.get(nodeId) ?? { since: now(), alerted: false };
    down.set(nodeId, h);
    o.log?.(`[upload-queue] ${streamKey} on ${nodeId}: ${why}`);
    // A rolled-back node will not recover by waiting, so alert at once; a flaky link only after the grace period.
    if (h.alerted || (!rolledBack && now() - h.since < o.unreachableAlertMs)) return;
    h.alerted = true;
    o.notify?.({ kind: "error", stage: "同步", message: `${nodeId} upload queue unavailable: ${why}. Orders stay pinned to it; no state was changed.` });
  };

  const step = async (streamKey: string, plan: UploadPlan): Promise<void> => {
    const t = o.transports().get(plan.nodeId);
    if (!t) return fail(plan.nodeId, streamKey, "node is not in the current hub config", false);
    let d: UploadDispatch;
    try {
      d = await advanceUpload(t, plan, { now });
    } catch (e) {
      return fail(plan.nodeId, streamKey, (e as Error).message, e instanceof ProcUnsupported);
    }
    down.delete(plan.nodeId);
    // Display only: a failed snapshot write must never stop the outcome mapping below.
    try { o.ledger.setUploadStatus(streamKey, JSON.stringify(uploadStatusOf(plan, d, now()))); }
    catch (e) { o.log?.(`[upload-queue] ${streamKey}: status snapshot not saved: ${(e as Error).message}`); }
    // Any observation of a live order is proof of life; terminal outcomes are the callback's business.
    if (d.phase !== "prep-failed" && d.phase !== "blocked") o.ledger.touch(streamKey);
    await o.onDispatch?.(streamKey, plan, d);
  };

  return {
    async poll(): Promise<void> {
      for (const row of o.ledger.listUploadPlans()) {
        const plan = parsePlan(row.uploadPlan);
        if (!plan) { o.log?.(`[upload-queue] ${row.streamKey}: persisted uploadPlan is malformed, skipped`); continue; }
        try { await step(row.streamKey, plan); }
        catch (e) { o.log?.(`[upload-queue] ${row.streamKey}: ${(e as Error).message}`); }
      }
    },
  };
}
