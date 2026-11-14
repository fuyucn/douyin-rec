/**
 * zero-upload → node proc-queue handoff (T-220).
 *
 * When a zero-disk pump has to stop because an archive upload could not settle (the pump exits 75),
 * the recorded spool files are intact. This helper moves exactly those sealed, unconfirmed parts
 * into the existing `upload-part` queue:
 *
 *   - one deterministic row per live part (`partWorkflow: "live-pump"`);
 *   - the first row creates, later rows inherit the predecessor bv from the queue runner;
 *   - `params.liveStatePath` lets the processor confirm the part into the pump's WAL before the
 *     runner chains `cleanup-part`, so a spool is never deleted while the state still says
 *     "unconfirmed";
 *   - `queueManaged` is written BEFORE the atomic batch, so a pump restart never whole-file
 *     resubmits the same parts while the queue is working. It is cleared by the processor once
 *     every part and the WAL are settled.
 *
 * The caller (CLI) only invokes this on the structured upload-pending result, never on a local
 * failure (missing/unreadable spool, untrusted state, held gap).
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  PART_KINDS, jobIdOf, partLogicalKey, type PartCtx, type ProcessJob,
} from "@drec/core";
import { biliupCookieHeader } from "@drec/bilibili-api";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { readLivePumpState, writeLivePumpState } from "@drec/zero-upload";
import { drecRoot } from "./paths.js";
import { nodeAllowedRoots } from "./node-enqueue.js";

export interface EnqueueLivePumpInput {
  statePath: string;
  /** biliup cookies.json path; the queue processor needs a Cookie header. */
  cookiesPath: string;
  taskId?: number;
  seasonSectionId?: number;
  log?: (message: string) => void;
}

export interface EnqueueLivePumpResult {
  queued: number;
  already: number;
  failed: number;
  error?: string;
}

/** Only sealed, complete, unconfirmed video parts are eligible. */
function eligible(file: string): boolean {
  return existsSync(file) && statSync(file).size > 0;
}

/**
 * Move the state's unconfirmed sealed parts into the queue.
 *
 * `queueManaged` is persisted before the batch. If the batch is rejected the marker is cleared
 * again (no row exists, so the pump may safely resubmit); a crash between the two leaves the
 * marker set, which is fail-closed: the pump waits instead of duplicating an upload.
 */
export function enqueueLivePumpPending(input: EnqueueLivePumpInput): EnqueueLivePumpResult {
  const log = input.log ?? (() => {});
  const state = readLivePumpState(input.statePath);
  if (!state) return { queued: 0, already: 0, failed: 0, error: "live state missing or unreadable" };
  if (!state.parts.some((p) => !p.confirmed)) return { queued: 0, already: 0, failed: 0 };

  let cookieHeader: string | null;
  try {
    cookieHeader = biliupCookieHeader(JSON.parse(readFileSync(input.cookiesPath, "utf-8")));
  } catch (e) {
    return { queued: 0, already: 0, failed: 0, error: "cannot read cookies: " + String((e as Error)?.message ?? e) };
  }
  if (!cookieHeader) return { queued: 0, already: 0, failed: 0, error: "cookies have no usable pairs" };

  // A queue row can only carry a complete sealed video. If any unconfirmed row is not eligible
  // (open-time placeholder, truncated spool, missing file), enqueue NOTHING: the pump's normal
  // recovery/fail path owns that state and a mixed handoff would either duplicate or strand parts.
  const blocked = state.parts.filter((p) => !p.confirmed
    && (p.sealed === false || p.spoolIncomplete || !eligible(p.spoolPath)));
  if (blocked.length > 0) {
    return { queued: 0, already: state.parts.filter((p) => p.confirmed).length, failed: blocked.length,
      error: "a sealed part is missing/incomplete; leaving the state to the pump's recovery path" };
  }

  const orderKey = `${state.room}:${state.createdAt}`;
  const store = new ProcQueueStore(procQueueDbPath(drecRoot()));
  try {
    const generation = store.currentOrderGeneration(orderKey);
    const rows: ProcessJob[] = [];
    let already = state.parts.filter((p) => p.confirmed).length;
    let failed = 0;

    // Queue order is the FULL state's sorted position, not the pending subset: a just-confirmed
    // earlier part must keep its seq reserved, otherwise the next part would collide with its
    // done row and be treated as "already queued". `liveStateIndex` carries the real state index
    // for the confirmation write.
    const orderedParts = [...state.parts].sort((a, b) => a.index - b.index);
    const pendingParts = orderedParts.filter((p) => !p.confirmed);
    for (const part of pendingParts) {
      const seq = orderedParts.findIndex((p) => p.index === part.index) + 1;
      const logicalKey = partLogicalKey(orderKey, seq);
      const existing = store.rowsForOrderSeq(orderKey, seq, PART_KINDS.upload, generation);
      if (existing.length > 0) {
        const terminal = existing.some((r) => r.state === "done" || r.state === "skipped");
        if (terminal) { already++; continue; }
        const active = existing.some((r) => r.state === "pending" || r.state === "running" || r.state === "reconciling");
        if (active) { already++; continue; }
        // failed / cancelled / uncertain: retrying it would only spam; leave it visible for a human.
        failed++;
        log("[live-queue] 分 P " + part.index + " 已有终态失败行(" + existing.map((r) => r.state).join(",") + "),不再入队");
        continue;
      }

      const st = statSync(part.spoolPath);
      const fp = { size: st.size, mtimeMs: st.mtimeMs };
      const ctx: PartCtx = {
        v: 1, orderKey, index: seq, file: part.spoolPath, fp,
        ...(state.bvid ? { bv: state.bvid } : {}),
      };
      rows.push({
        jobId: jobIdOf(PART_KINDS.upload, logicalKey, generation),
        kind: PART_KINDS.upload, logicalKey, generation, inputs: [part.spoolPath],
        params: {
          ctx,
          partWorkflow: "live-pump",
          liveStatePath: input.statePath,
          liveStateIndex: part.index,
          cookies: cookieHeader,
          title: state.title,
          tid: state.tid,
          tag: state.tag,
          public: !state.private,
          ...(state.desc ? { desc: state.desc } : {}),
          ...(input.seasonSectionId ? { seasonSectionId: input.seasonSectionId } : {}),
          ...(part.durationSec > 0 ? { expectedDurationSec: part.durationSec } : {}),
        },
        replaceInputs: false,
        owner: { ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), streamKey: orderKey },
        createdAt: Date.now(), orderKey, seq,
      });
    }

    if (rows.length === 0) {
      // Active/done rows already prove the queue owns this part; keep the pump from resubmitting it.
      if (already > 0) writeLivePumpState(input.statePath, { ...state, queueManaged: true });
      return { queued: 0, already, failed };
    }

    // Fail-closed ordering: marker first, then the atomic batch. The pump will not resubmit during
    // the queue's work; if the batch is rejected we clear the marker before returning.
    writeLivePumpState(input.statePath, { ...state, queueManaged: true });
    try {
      store.enqueueBatch(rows, { allowedRoots: nodeAllowedRoots(drecRoot()) });
    } catch (e) {
      try {
        const cur = readLivePumpState(input.statePath);
        if (cur) writeLivePumpState(input.statePath, { ...cur, queueManaged: undefined });
      } catch { /* the original error is the useful one */ }
      return { queued: 0, already, failed, error: "queue enqueue rejected: " + String((e as Error)?.message ?? e) };
    }
    log("[live-queue] 已入队 " + rows.length + " 个直传分 P (" + orderKey + ")");
    return { queued: rows.length, already, failed };
  } finally {
    store.close();
  }
}
