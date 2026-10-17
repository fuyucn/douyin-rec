/**
 * Map queue observations onto the ledger (plan 038 T13c).
 *
 * Only the ledger and a notifier are reachable from here, on purpose: finishing or failing a queued upload
 * must never delete recordings (source cleanup stays with the existing, explicitly configured cleanup path).
 * Every non-success outcome goes to needs_manual, never to failed: `failed` would let the reconciler retry
 * and a retry after a possibly-created draft is how duplicate drafts happen.
 */
import type { NotifyEvent } from "@drec/core";
import type { SyncLedger } from "./ledger.js";
import type { UploadDispatch } from "./node-upload-queue.js";

export type UploadOutcome =
  | { action: "none" }
  /** BV known but the order is not finished yet (checkpoint only). */
  | { action: "checkpoint"; bv: string }
  | { action: "done"; bv: string }
  | { action: "needs_manual"; reason: string };

const manual = (reason: string): UploadOutcome => ({ action: "needs_manual", reason });

function enqueueFailure(what: string, r: { state: string; error?: string; existingState?: string }): UploadOutcome | null {
  if (r.state === "rejected") return manual(`${what} enqueue rejected: ${r.error ?? "unknown"}${r.existingState ? ` (existing row ${r.existingState})` : ""}`);
  if (r.state === "stale") return manual(`${what} enqueue is stale: its earlier outputs are gone`);
  return null;
}

/** Pure mapping from one poll observation to the action the ledger should take. */
export function mapUploadOutcome(d: UploadDispatch): UploadOutcome {
  switch (d.phase) {
    case "prep-enqueued": return enqueueFailure("prep", d.result) ?? { action: "none" };
    case "biliup-enqueued": return enqueueFailure("biliup", d.result) ?? { action: "none" };
    case "prep-waiting": return { action: "none" };
    case "prep-failed": return manual(`prep ${d.state}${d.error ? `: ${d.error}` : ""} (recover with recover-order --prep)`);
    case "blocked": return manual(d.reason);
    case "biliup": return mapReceipt(d.receipt);
  }
}

function mapReceipt(r: { state: string; bv?: string; error?: string; step?: string }): UploadOutcome {
  switch (r.state) {
    case "done":
      return r.bv ? { action: "done", bv: r.bv } : manual("biliup finished without reporting a BV; verify on the creator center");
    case "pending":
    case "running":
      return r.bv ? { action: "checkpoint", bv: r.bv } : { action: "none" };
    default: {
      const where = r.step ? ` at step ${r.step}` : "";
      const bv = r.bv ? ` (draft ${r.bv} exists; use recover-order --bv)` : "";
      return manual(`biliup ${r.state}${where}${r.error ? `: ${r.error}` : ""}${bv}`);
    }
  }
}

/** Apply an outcome to the ledger. Notifies only when the ledger actually moved to needs_manual. */
export function applyUploadOutcome(
  ledger: Pick<SyncLedger, "get" | "markDone" | "setBv" | "setState">, streamKey: string, o: UploadOutcome, notify?: (e: NotifyEvent) => void,
): void {
  // The ledger accepts same-state writes, so guard here: a settled order is never re-notified or rewritten.
  const cur = ledger.get(streamKey)?.state;
  if (o.action !== "none" && (cur === "done" || (cur === "needs_manual" && o.action !== "done"))) return;
  switch (o.action) {
    case "none": return;
    case "checkpoint": ledger.setBv(streamKey, o.bv); return;
    case "done": ledger.setBv(streamKey, o.bv); ledger.markDone(streamKey, o.bv); return;
    case "needs_manual":
      if (ledger.setState(streamKey, "needs_manual", { error: o.reason })) {
        notify?.({ kind: "error", stage: "同步", message: `${streamKey} queued upload needs manual handling: ${o.reason}` });
      }
  }
}

/** Poller callback: observation -> outcome -> ledger. */
export function completeFromDispatch(
  ledger: Pick<SyncLedger, "get" | "markDone" | "setBv" | "setState">, streamKey: string, d: UploadDispatch, notify?: (e: NotifyEvent) => void,
): void {
  applyUploadOutcome(ledger, streamKey, mapUploadOutcome(d), notify);
}
