/**
 * T-221 (sol P1-4): translate the node queue's enqueue result into an early-handoff receipt.
 *
 * The pump must never treat "the helper ran" as "the queue owns the backlog". A cookie / SQLite
 * read failure, a zero-row result, or an order hole all leave the spool as the only copy; those
 * must go back through uploadPending / exit 75 (TaskManager backoff) or be surfaced for a human.
 */
import type { EnqueueLivePumpResult } from "@drec/app";
import type { LivePumpHandoffReceipt } from "@drec/zero-upload";

export function livePumpHandoffReceipt(
  queued: EnqueueLivePumpResult | undefined,
  error?: unknown,
): LivePumpHandoffReceipt {
  if (error !== undefined) {
    return { status: "retryable", detail: String((error as Error)?.message ?? error) };
  }
  if (!queued) return { status: "retryable", detail: "enqueue helper returned no result" };
  if (queued.error) return { status: "retryable", detail: queued.error };
  if (queued.failed > 0) {
    const detail = `${queued.failed} 个分 P 未被队列接管(顺序空洞/未封口/缺本地校验标记/需人工)`;
    // A partial handoff still owns the rows it enqueued. Only a TOTAL miss is worth an exit-75
    // retry; mixed results keep the existing ownership and wait for human/next-startup repair.
    return {
      status: queued.queued + queued.already === 0 ? "retryable" : "blocked",
      detail,
    };
  }
  if (queued.queued + queued.already === 0) {
    return { status: "retryable", detail: "待补分 P 未被队列接管(零行)" };
  }
  return { status: "owned" };
}
