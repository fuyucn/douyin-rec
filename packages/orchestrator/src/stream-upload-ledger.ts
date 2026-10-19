/**
 * Record a zero-disk streaming upload in the hub ledger (plans/039).
 *
 * A zero-disk task produces no recording files, so the normal pipeline (scan → select → merge →
 * upload) has nothing to work on and the room would sit in the ledger with no outcome at all.
 * This writes the *upload result* directly: the archive identity is the deliverable, so the
 * ledger shows the room as done with a BV instead of silently stalling.
 *
 * Deliberately narrow: it only moves a job to a terminal state and never touches files, source
 * cleanup, or the reconciler. Zero-disk tasks are still rejected as hub rule sources (they cannot
 * be scanned); this is for bookkeeping of what a zero-disk run actually uploaded.
 */
import { SyncLedger } from "./ledger.js";

export interface RecordStreamUploadOpts {
  /** `<root>/db/douyin-rec-sync.db` (the sibling of the main db). */
  syncDbPath: string;
  /** `{platform}:{roomSlug}:{date}` — the ledger's job key. */
  streamKey: string;
  bvid: string;
  /** Parts that reached the archive, for the event detail line. */
  parts: number;
  now?: number;
}

export interface RecordStreamUploadResult {
  ok: boolean;
  error?: string;
  bvid?: string;
  /** True when the job was already terminal (write was a no-op). */
  alreadyTerminal?: boolean;
}

/**
 * Best effort from the caller's perspective: returns a result instead of throwing, because the
 * archive already exists and a ledger failure must not fail a successful upload.
 */
export function recordStreamUpload(o: RecordStreamUploadOpts): RecordStreamUploadResult {
  let ledger: SyncLedger | undefined;
  try {
    ledger = new SyncLedger(o.syncDbPath);
    const before = ledger.get(o.streamKey);
    // Idempotent: an existing job keeps its history, a new one starts pending.
    ledger.upsertPending(o.streamKey);
    const beforeTerminal = before !== null && ["done", "failed", "needs_manual"].includes(before.state);
    if (beforeTerminal) {
      // Already terminal. Bilibili has no delete API, so overwriting the BV would point the
      // ledger at an archive the user cannot un-publish while the real one stays hidden.
      // Leave it alone and report what is actually recorded.
      return { ok: true, bvid: before?.bv ?? o.bvid, alreadyTerminal: true };
    }
    // markDone is the only terminal transition that carries the BV, and it is CAS-guarded:
    // a concurrent writer reaching a terminal state first leaves the row untouched.
    ledger.markDone(o.streamKey, o.bvid);
    return { ok: true, bvid: o.bvid, alreadyTerminal: false };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  } finally {
    try { ledger?.close(); } catch { /* close is best effort */ }
  }
}
