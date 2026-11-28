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
import { isLivePumpPartObserved, readConfirmedJournal, readLivePumpState, requiresLivePumpProof, writeLivePumpState } from "@drec/zero-upload";
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
  /**
   * T-221 (sol P1-4): WHY a row was refused, split by whether a human must act. `needsManual`
   * (truncated / missing spool, terminal-failed queue row) can never settle by retrying, so the
   * CLI classifier must report `blocked` and let the pump KEEP RECORDING. `deferred` (still
   * unsealed, missing the positive marker, pending submit intent, blocked behind an earlier row)
   * may settle on a later round, so a zero-take result is worth the exit-75 retry.
   */
  needsManual?: number;
  deferred?: number;
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
  if (requiresLivePumpProof(state)) {
    const unresolved = state.parts.filter(part => !isLivePumpPartObserved(part)).length;
    const held = Math.max(unresolved, state.pending ? 1 : 0);
    return { queued: 0, already: 0, failed: held, needsManual: held,
      ...(held ? { error: "protected live delivery retains its original UPOS owner; biliup queue handoff is unsupported" } : {}) };
  }
  if (!state.parts.some((p) => !p.confirmed)) return { queued: 0, already: 0, failed: 0 };

  let cookieHeader: string | null;
  try {
    cookieHeader = biliupCookieHeader(JSON.parse(readFileSync(input.cookiesPath, "utf-8")));
  } catch (e) {
    return { queued: 0, already: 0, failed: 0, error: "cannot read cookies: " + String((e as Error)?.message ?? e) };
  }
  if (!cookieHeader) return { queued: 0, already: 0, failed: 0, error: "cookies have no usable pairs" };

  // T-221: enqueue is per-index, not all-or-nothing. While the pump keeps recording (spool
  // mode) the state ALWAYS holds an open placeholder (the part being recorded) and possibly a
  // pending submit intent — a whole-batch block would leave the queue permanently idle. Each
  // rule below skips exactly the rows it names and hands the rest to the queue.
  const journal = readConfirmedJournal(input.statePath, state.createdAt);
  const pendingIndex = state.pending?.partIndex;
  const unconfirmedParts = [...state.parts]
    .sort((a, b) => a.index - b.index)
    .filter((p) => !p.confirmed && !journal.has(p.index));

  const orderKey = `${state.room}:${state.createdAt}`;
  const store = new ProcQueueStore(procQueueDbPath(drecRoot()));
  try {
    const generation = store.currentOrderGeneration(orderKey);
    const rows: ProcessJob[] = [];
    let already = state.parts.filter((p) => p.confirmed).length + state.parts.filter((p) => !p.confirmed && journal.has(p.index)).length;
    let failed = 0;
    let needsManual = 0;
    let deferred = 0;

    // Queue order is the FULL state's sorted position, not the pending subset: a just-confirmed
    // earlier part must keep its seq reserved, otherwise the next part would collide with its
    // done row and be treated as "already queued". `liveStateIndex` carries the real state index
    // for the confirmation write.
    const orderedParts = [...state.parts].sort((a, b) => a.index - b.index);
    // Order hole (review P1): a part the queue cannot take YET (pending intent, still unsealed,
    // failed row, truncated spool) must block every LATER part from entering the queue now —
    // the runner appends in seq order, and a later part appended first would produce a
    // permanently out-of-order draft. Blocked parts stay unconfirmed; the next exit-75 retries.
    let orderBlocked = false;
    for (const part of unconfirmedParts) {
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
        needsManual++;
        log("[live-queue] 分 P " + part.index + " 已有终态失败行(" + existing.map((r) => r.state).join(",") + "),不再入队;后续分 P 暂缓以保分 P 顺序");
        orderBlocked = true;
        continue;
      }
      if (part.index === pendingIndex) {
        // An irreversible submit (create/append) is still unresolved for this part: the queue
        // must not blindly repeat it (duplicate draft / duplicate P). The pump's recover() or the
        // next run disambiguates it first.
        failed++;
        deferred++;
        log("[live-queue] 分 P " + part.index + " 有未决提交意图(pending),先由 pump 消歧,暂不入队;后续分 P 暂缓以保分 P 顺序");
        orderBlocked = true;
        continue;
      }
      // T-221 (sol P1-2): DEFAULT-DENY on the POSITIVE marker. A seal-time WAL row has real
      // bytes/duration but was never probed + DTS-scanned; a SIGKILL before finalize must not
      // make it look deliverable. The legacy negative marker stays an extra blocker.
      const humanBlocked = part.spoolIncomplete === true || !eligible(part.spoolPath);
      if (part.sealed === false || humanBlocked || part.validated !== true || part.needsValidation) {
        failed++;
        if (humanBlocked) needsManual++; else deferred++;
        log("[live-queue] 分 P " + part.index + (part.sealed === false
          ? " 尚未封口(正在录制),不入队;后续分 P 暂缓以保分 P 顺序"
          : part.validated !== true || part.needsValidation
            ? " 未通过本地产物校验(缺 validated 标记),不入队(下次启动补验);后续分 P 暂缓以保分 P 顺序"
            : part.spoolIncomplete
              ? " spool 截断,不入队(需人工);后续分 P 暂缓以保分 P 顺序"
              : " spool 缺失,不入队(需人工);后续分 P 暂缓以保分 P 顺序"));
        orderBlocked = true;
        continue;
      }
      if (orderBlocked) {
        failed++;
        deferred++; // the blocker itself already counted its (human or deferred) reason
        log("[live-queue] 分 P " + part.index + " 因前序分 P 受阻暂不入队(下一轮重试)");
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
      // Nothing new to hand over. The marker is NEVER invented here (review P2): active/done rows
      // were created by a previous enqueue that already set it; confirmed/journal-settled parts
      // do not need it. Leave the state file untouched in this branch.
      return { queued: 0, already, failed, ...(needsManual ? { needsManual } : {}), ...(deferred ? { deferred } : {}) };
    }

    // Fail-closed ordering: marker first, then the atomic batch. The pump will not resubmit during
    // the queue's work. If the batch is rejected, only undo a marker WE set in this call (review
    // P1): an existing marker means earlier parts are already queue-owned and must stay owned.
    const hadMarker = state.queueManaged === true;
    if (!hadMarker) writeLivePumpState(input.statePath, { ...state, queueManaged: true });
    try {
      store.enqueueBatch(rows, { allowedRoots: nodeAllowedRoots(drecRoot()) });
    } catch (e) {
      if (!hadMarker) {
        try {
          const cur = readLivePumpState(input.statePath);
          if (cur) writeLivePumpState(input.statePath, { ...cur, queueManaged: undefined });
        } catch { /* the original error is the useful one */ }
      }
      return { queued: 0, already, failed, error: "queue enqueue rejected: " + String((e as Error)?.message ?? e) };
    }
    log("[live-queue] 已入队 " + rows.length + " 个直传分 P (" + orderKey + ")");
    return { queued: rows.length, already, failed, ...(needsManual ? { needsManual } : {}), ...(deferred ? { deferred } : {}) };
  } finally {
    store.close();
  }
}
