/**
 * app/rolling-queue.ts — plan 046 PR6 (方案 A): the recorder's seal hook only enqueues upload-part rows.
 *
 * The switch (settings.ROLLING_QUEUE_MODE_SETTING, default off) is read once per factory build. When off,
 * nothing here runs and the legacy rolling-upload path stays byte-identical. When on:
 *   - the recorder never spawns biliup, never takes the node upload slot or the account gate;
 *   - each sealed part becomes one deterministic upload-part row (params.partWorkflow = "rolling" so the
 *     confirmed upload chains cleanup-part);
 *   - the serve runner is the only uploader, and cleanup-part (PR2) is the only deleter;
 *   - hub-owned rooms write only a skipped(hub-owned) row (same job id as the upload row would have had);
 *   - the legacy sidecar is imported once per confirmed part as a done row (idempotent) and, while its
 *     source still exists, gets a cleanup-part row via the normal deletion path.
 */
import { existsSync, statSync } from "node:fs";
import {
  PART_KINDS, ROLLING_QUEUE_MODE_SETTING, jobIdOf, partLogicalKey, rollingSidecarPathOf,
  type PartCtx, type ProcessJob,
} from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { TaskStore } from "./store.js";
import { drecRoot } from "./paths.js";
import { resolveDbPath } from "./db.js";
import { nodeAllowedRoots } from "./node-enqueue.js";

export interface QueueMeta {
  /** Resolved upload metadata (same values the legacy path sends to biliup). */
  cookies: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  public: boolean;
  seasonSectionId?: number;
}

export interface QueuePartInput {
  file: string;
  /** 0-based part index as the recorder numbers segments; queue seq is index + 1. */
  index: number;
  /** Explicit queue seq across sessions of the same broadcast (defaults to index + 1). */
  seq?: number;
  orderKey: string;
  bv?: string;
  meta: QueueMeta;
  expectedDurationSec?: number;
  taskId?: number;
  log?: (message: string) => void;
}

/**
 * Explicit-on parser for this switch. parseBoolFlag is deliberately fail-open (an unknown flag means "on"),
 * which is wrong for a switch that disables the recorder's only upload path: a typo must mean OFF.
 */
export function rollingQueueModeEnabled(dbPath: string = resolveDbPath()): boolean {
  try {
    if (!existsSync(dbPath)) return false;
    const store = new TaskStore(dbPath);
    try {
      const raw = (store.getSetting(ROLLING_QUEUE_MODE_SETTING) ?? "").trim().toLowerCase();
      return raw === "1" || raw === "true" || raw === "on" || raw === "yes" || raw === "y";
    } finally { store.close(); }
  } catch {
    return false;
  }
}

function openQueue(log?: (m: string) => void): ProcQueueStore | null {
  try { return new ProcQueueStore(procQueueDbPath(drecRoot())); }
  catch (e) { log?.("[rolling-queue] 任务表不可用: " + String((e as Error)?.message ?? e)); return null; }
}

function partJob(input: QueuePartInput, generation: number, seq: number, fp: { size: number; mtimeMs: number }): ProcessJob {
  const logicalKey = partLogicalKey(input.orderKey, seq);
  const ctx: PartCtx = {
    v: 1, orderKey: input.orderKey, index: seq, file: input.file, fp,
    ...(input.bv ? { bv: input.bv } : {}),
  };
  const m = input.meta;
  return {
    jobId: jobIdOf(PART_KINDS.upload, logicalKey, generation),
    kind: PART_KINDS.upload, logicalKey, generation, inputs: [input.file],
    params: {
      ctx, partWorkflow: "rolling",
      cookies: m.cookies, title: m.title, tid: m.tid, tag: m.tag, public: m.public,
      ...(m.desc ? { desc: m.desc } : {}),
      ...(m.seasonSectionId ? { seasonSectionId: m.seasonSectionId } : {}),
      ...(input.expectedDurationSec && input.expectedDurationSec > 0 ? { expectedDurationSec: input.expectedDurationSec } : {}),
      // One derivation shared with the processor and the job contract (core.rollingSidecarPathOf).
      sidecarPath: rollingSidecarPathOf(input.file),
      sidecarIndex: input.index,
      queueOrderKey: input.orderKey,
    },
    replaceInputs: false,
    owner: { ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), streamKey: input.orderKey },
    createdAt: Date.now(), orderKey: input.orderKey, seq,
  };
}

/** Seal a part: pending/running/done/skipped all mean "this part needs no more enqueue work". */
export type EnqueuePartResult = "queued" | "already" | "failed" | "terminal";

function classify(r: { state: string; error?: string; existingState?: string }): EnqueuePartResult {
  if (r.state === "pending" || r.state === "running") return "queued";
  if (r.state === "done" || r.state === "skipped") return "already";
  // A row already finished by another producer (e.g. skipped(hub-owned)) means this segment is handled.
  if (r.state === "rejected" && (r.existingState === "done" || r.existingState === "skipped")) return "already";
  // failed/cancelled/uncertain rows are terminal for automation: retrying forever would only spam.
  if (r.state === "rejected" && (r.existingState === "failed" || r.existingState === "cancelled" || r.existingState === "uncertain")) return "terminal";
  return "failed";
}

/**
 * Resolve the existing row for this segment before any file/empty classification (deleted source + done
 * row). Scoped to the live generation: an older generation's row must neither mask this part nor make a
 * second job id for the same (orderKey, seq). Every row of the pair counts as handled — a pending/running
 * row under an older logical-key spelling must not be enqueued twice.
 */
function existingRow(input: QueuePartInput, seq: number): { state: string } | null {
  const store = openQueue(input.log);
  if (!store) return null;
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const rows = store.rowsForOrderSeq(input.orderKey, seq, PART_KINDS.upload, generation);
    if (rows.length > 0) {
      const states = new Set(rows.map((r) => r.state));
      if (states.has("done")) return { state: "done" };
      if (states.has("skipped")) return { state: "skipped" };
      if (states.has("running") || states.has("pending") || states.has("reconciling")) return { state: "pending" };
      return { state: rows[0]!.state };
    }
    return store.get(jobIdOf(PART_KINDS.upload, partLogicalKey(input.orderKey, seq), generation));
  } catch {
    return null;
  } finally { store.close(); }
}

function fpOf(file: string): { size: number; mtimeMs: number } | null {
  try { const s = statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; }
}

/** Enqueue one sealed part. "failed" is the only result the caller must treat as retryable. */
export function enqueueRollingUploadPart(input: QueuePartInput): EnqueuePartResult {
  const seq = input.seq ?? input.index + 1;
  // The recorder may still list a segment cleanup-part already deleted: an existing terminal row wins
  // over every file-based check (otherwise a deleted source would be retried forever).
  const prior = existingRow(input, seq);
  if (prior) {
    if (prior.state === "done" || prior.state === "skipped") return "already";
    // A pending/running/reconciling row already owns this part (maybe under an older key spelling):
    // enqueueing again would create a second claimable job id for the same segment.
    if (prior.state === "pending" || prior.state === "running" || prior.state === "reconciling") return "queued";
    if (prior.state === "failed" || prior.state === "cancelled") return "terminal";
  }
  const fp = fpOf(input.file);
  if (!fp) {
    input.log?.("[rolling-queue] 入队失败:源文件无法 stat: " + input.file);
    return "failed";
  }
  const store = openQueue(input.log);
  if (!store) return "failed";
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const r = store.enqueue(partJob(input, generation, seq, fp), { allowedRoots: nodeAllowedRoots(drecRoot()) });
    const out = classify(r);
    if (out === "failed") input.log?.("[rolling-queue] 段 " + input.index + " 入队被拒(" + r.state + "): " + (r.error ?? ""));
    return out;
  } catch (e) {
    input.log?.("[rolling-queue] 段 " + input.index + " 入队异常: " + String((e as Error)?.message ?? e));
    return "failed";
  } finally { store.close(); }
}

/** Empty/fragment sealed part: a skipped placeholder keeps seq gapless for later parts. */
export function enqueueRollingSkipPart(input: QueuePartInput): EnqueuePartResult {
  const seq = input.seq ?? input.index + 1;
  const prior = existingRow(input, seq);
  if (prior) {
    if (prior.state === "done" || prior.state === "skipped") return "already";
    if (prior.state === "pending" || prior.state === "running" || prior.state === "reconciling") return "queued";
    if (prior.state === "failed" || prior.state === "cancelled") return "terminal";
  }
  const fp = fpOf(input.file);
  if (!fp) return "failed";
  const store = openQueue(input.log);
  if (!store) return "failed";
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const r = store.enqueueSourceGone(partJob(input, generation, seq, fp), { allowedRoots: nodeAllowedRoots(drecRoot()) });
    const out: EnqueuePartResult = r.state === "skipped" || r.state === "done" ? "already"
      : r.state === "pending" || r.state === "running" ? "queued" : "failed";
    if (out === "failed") input.log?.("[rolling-queue] 段 " + input.index + " 占位被拒(" + r.state + "): " + (r.error ?? ""));
    return out;
  } catch (e) {
    input.log?.("[rolling-queue] 段 " + input.index + " 占位异常: " + String((e as Error)?.message ?? e));
    return "failed";
  } finally { store.close(); }
}

/**
 * Backward-compat import: a part the legacy uploader already confirmed becomes a done row so later parts
 * inherit its bv. If its source still exists, also enqueue cleanup-part (the normal deletion path) so a
 * legacy confirm whose delete failed does not leave the file forever.
 */
export function importRollingConfirmedPart(
  input: QueuePartInput & { bv: string; withCleanup?: boolean },
): EnqueuePartResult {
  const seq = input.seq ?? input.index + 1;
  const fp = fpOf(input.file);
  if (!fp) return "already"; // source already deleted by the legacy path
  const store = openQueue(input.log);
  if (!store) return "failed";
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const ctx: PartCtx = { v: 1, orderKey: input.orderKey, index: seq, file: input.file, fp, bv: input.bv };
    // Same logical key as completeAndChain's cleanup successor: one cleanup job id per part.
    const cleanup: ProcessJob | undefined = input.withCleanup === true
      ? {
        jobId: jobIdOf(PART_KINDS.cleanup, partLogicalKey(input.orderKey, seq), generation),
        kind: PART_KINDS.cleanup, logicalKey: partLogicalKey(input.orderKey, seq), generation, inputs: [input.file],
        params: { ctx }, replaceInputs: false,
        owner: { ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), streamKey: input.orderKey },
        createdAt: Date.now(),
      }
      : undefined;
    const done = store.importConfirmedPart(partJob({ ...input, bv: input.bv }, generation, seq, fp), {
      allowedRoots: nodeAllowedRoots(drecRoot()), bv: input.bv, ...(cleanup ? { cleanupJob: cleanup } : {}),
    });
    if (done.state !== "done") {
      input.log?.("[rolling-queue] 段 " + input.index + " 兼容导入未成功(" + done.state + "): " + (done.error ?? ""));
      return "failed";
    }
    return "already";
  } catch (e) {
    input.log?.("[rolling-queue] 段 " + input.index + " 兼容导入异常: " + String((e as Error)?.message ?? e));
    return "failed";
  } finally { store.close(); }
}

/** Rollback guard: does this order key already have upload-part rows (any state / generation)? */
export function queueOrderHasRows(orderKey: string): boolean {
  const store = openQueue();
  if (!store) throw new Error("proc-queue unavailable"); // unreadable queue must not look empty
  try {
    return store.countOrderRows(orderKey, PART_KINDS.upload) > 0;
  } finally { store.close(); }
}

/** Highest seq already recorded for one order key (restart / same-broadcast continuation base). */
export function rollingQueueMaxSeq(orderKey: string): number {
  const store = openQueue();
  if (!store) return 0;
  try {
    return store.maxPartSeq(orderKey);
  } catch {
    return 0;
  } finally { store.close(); }
}
