/**
 * T-221 (sol P1-4): translate the node queue's enqueue result into an early-handoff receipt.
 *
 * The pump must never treat "the helper ran" as "the queue owns the backlog". A cookie / SQLite
 * read failure, a zero-row result, or an order hole all leave the spool as the only copy; those
 * must go back through uploadPending / exit 75 (TaskManager backoff) or be surfaced for a human.
 *
 * The split between `retryable` and `blocked` is NOT inferred from how many rows were taken: an
 * all-needs-manual backlog (truncated / missing spool, terminal-failed queue row) must be
 * `blocked` so the pump keeps recording instead of exiting 75 forever on a condition no retry
 * can settle.
 */
import type { EnqueueLivePumpResult } from "@drec/app";
import type { LivePumpHandoffReceipt } from "@drec/zero-upload";

export function livePumpHandoffReceipt(
  queued: EnqueueLivePumpResult | undefined,
  error?: unknown,
): LivePumpHandoffReceipt {
  if (queued?.blocked !== undefined) return { status: "blocked", detail: queued.blocked };
  if (error !== undefined) {
    return { status: "retryable", detail: String((error as Error)?.message ?? error) };
  }
  if (!queued) return { status: "retryable", detail: "enqueue helper returned no result" };
  if (queued.error) return { status: "retryable", detail: queued.error };
  if ((queued.needsManual ?? 0) > 0) {
    // A row a human must fix can never settle by retrying. `blocked` keeps the pump recording
    // (the spool and the intent survive) and the idle/stop exit still reports uploadPending.
    return {
      status: "blocked",
      detail: `${queued.needsManual} 个分 P 需要人工处理(截断/缺失 spool 或终态失败队列行)`,
    };
  }
  if (queued.failed > 0) {
    // Pure deferred rows (still unsealed, missing the positive marker, pending intent, or blocked
    // behind an earlier row). Only a TOTAL miss is worth the exit-75 retry; a partial handoff
    // keeps the rows it already owned and waits for the next round / human repair.
    return {
      status: queued.queued + queued.already === 0 ? "retryable" : "blocked",
      detail: `${queued.failed} 个分 P 未被队列接管(顺序空洞/未封口/缺本地校验标记)`,
    };
  }
  if (queued.queued + queued.already === 0) {
    return { status: "retryable", detail: "待补分 P 未被队列接管(零行)" };
  }
  return { status: "owned" };
}
