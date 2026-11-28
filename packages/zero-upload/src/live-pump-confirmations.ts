import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync,
  statSync, writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { isLivePumpPartObserved, readLivePumpState, requiresLivePumpProof } from "./live-pump-state.js";

/** Missing state has no work; unreadable state is unknown and must block cleanup. */
export function livePumpHasUnconfirmed(path: string): boolean {
  if (!existsSync(path)) return false;
  const state = readLivePumpState(path);
  if (!state) return true;
  if (requiresLivePumpProof(state))
    return !!state.pending || state.parts.some(part => !isLivePumpPartObserved(part));
  // T-221: the queue records confirmations in the journal, not in the state (the pump owns the
  // state file while it keeps recording). A part the journal already confirmed is settled even
  // though the state row still says unconfirmed.
  const journal = readConfirmedJournal(path, state.createdAt);
  return !!(state.pending && !journal.has(state.pending.partIndex))
    || state.parts.some((p) => !p?.confirmed && !journal.has(p.index));
}

/** One queue-proven confirmation, scoped to the original session by createdAt. */
export interface ConfirmedJournalEntry {
  index: number;
  bv: string;
  at: number;
  /** The original state.createdAt; old sessions must never confirm new indexes at the same path. */
  createdAt: number;
}

/** Queue confirmations live beside the recorder-owned state, one JSON record per line. */
export function confirmedJournalPath(statePath: string): string {
  return `${statePath}.confirmed`;
}

/** Read valid records independently; the last record per index wins within the requested session. */
export function readConfirmedJournal(statePath: string, expectedCreatedAt?: number): Map<number, ConfirmedJournalEntry> {
  const map = new Map<number, ConfirmedJournalEntry>();
  const file = confirmedJournalPath(statePath);
  if (!existsSync(file)) return map;
  let raw: string;
  try {
    raw = readFileSync(file, "utf-8");
  } catch {
    return map;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as ConfirmedJournalEntry;
      if (typeof e?.index !== "number" || typeof e?.bv !== "string" || !e.bv) continue;
      // Session isolation (review P1): entries from a previous session (rolled-over state,
      // same path, same indexes) must not confirm this session's parts. Entries written before
      // this field existed are ignored as well — never claim an unproven part.
      if (expectedCreatedAt !== undefined && e.createdAt !== expectedCreatedAt) continue;
      map.set(e.index, e);
    } catch { /* skip the bad line; the rest of the journal stays valid */ }
  }
  return map;
}

/** Only a proven newline or empty file can omit the separator; unknown tails fail closed. */
export function needsConfirmedJournalSeparator(probe: { size: number; lastByte: number | undefined } | undefined): boolean {
  if (!probe) return true; // could not inspect the journal: fail-closed
  if (!(probe.size > 0)) return false; // empty journal: nothing to terminate
  return probe.lastByte !== 0x0a;
}

function readJournalLastByte(journal: string, size: number): number | undefined {
  const fd = openSync(journal, "r");
  try {
    const tail = Buffer.alloc(1);
    return readSync(fd, tail, 0, 1, size - 1) === 1 ? tail[0] : undefined;
  } finally {
    closeSync(fd);
  }
}

function probeJournalTail(
  journal: string, fd: number,
): { size: number; lastByte: number | undefined } | undefined {
  try {
    const size = fstatSync(fd).size;
    return { size, lastByte: size > 0 ? readJournalLastByte(journal, size) : 0x0a };
  } catch {
    return undefined; // An unreadable tail still requires a separator.
  }
}

/** Fsync before returning: successful confirmation permits the chained spool cleanup. */
export function appendConfirmedJournal(statePath: string, entry: ConfirmedJournalEntry): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const journal = confirmedJournalPath(statePath);
  // fsync before returning: the caller deletes the spool right after (cleanup chain), so a
  // lost page cache would leave a confirmed-in-queue part that nothing can settle again.
  const fd = openSync(journal, "a");
  const writeAll = (data: Buffer): void => {
    // POSIX writeSync may return a short count without throwing (review P2): a partial line that
    // survives fsync would be skipped by the reader and the confirmation lost. Write to completion.
    let off = 0;
    while (off < data.length) {
      const n = writeSync(fd, data.subarray(off));
      if (!(n > 0)) throw new Error(`journal writeSync 返回 ${n},写入未推进`);
      off += n;
    }
  };
  try {
    // Terminate a torn tail so the next durable record remains independently readable.
    const probe = probeJournalTail(journal, fd);
    if (needsConfirmedJournalSeparator(probe)) writeAll(Buffer.from("\n", "utf-8"));
    writeAll(Buffer.from(JSON.stringify(entry) + "\n", "utf-8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The queue writes only this journal, never the recorder-owned state.
 * Cleanup is allowed only after a matching part is durably confirmed. */
export function confirmLivePumpPart(
  statePath: string,
  index: number,
  bv: string,
  fp: { size: number; mtimeMs: number },
): { ok: true } | { ok: false; error: string } {
  if (!bv) return { ok: false, error: "confirmLivePumpPart requires a confirmed bv" };
  const state = readLivePumpState(statePath);
  if (!state) return { ok: false, error: "live state missing or unreadable: " + statePath };
  if (requiresLivePumpProof(state))
    return { ok: false, error: "protected live delivery requires native per-part observation; queue ACK cannot confirm it" };
  const part = state.parts.find((p) => p.index === index);
  if (!part) return { ok: false, error: "live state has no part index " + index };
  const journal = readConfirmedJournal(statePath, state.createdAt);
  if (state.bvid && state.bvid !== bv) {
    return { ok: false, error: "live state bvid does not match the queue result: " + state.bvid + " vs " + bv };
  }
  if (part.confirmed || journal.has(index)) {
    // Idempotent re-confirm: the same part proven twice (queue retry after a lost ack) must not
    // duplicate the journal line's effect. A DIFFERENT bv for the same index is still an error.
    const prev = journal.get(index);
    if (prev && prev.bv !== bv) {
      return { ok: false, error: "live part already confirmed under another bv: " + prev.bv + " vs " + bv };
    }
    if (!part.confirmed) {
      // A readable journal hit may still be unsynced after a failed append. Re-sync before cleanup.
      try {
        appendConfirmedJournal(statePath, { index, bv, at: prev?.at ?? Date.now(), createdAt: prev?.createdAt ?? state.createdAt });
      } catch (e) {
        return { ok: false, error: "confirmation journal re-sync failed: " + String((e as Error)?.message ?? e) };
      }
    }
    return { ok: true };
  }
  let now: { size: number; mtimeMs: number };
  try {
    const s = statSync(part.spoolPath);
    now = { size: s.size, mtimeMs: s.mtimeMs };
  } catch (e) {
    return { ok: false, error: "live part spool cannot be stat-ed: " + String((e as Error)?.message ?? e) };
  }
  if (now.size !== fp.size || now.mtimeMs !== fp.mtimeMs) {
    return { ok: false, error: "live part fingerprint changed after queue upload" };
  }
  try {
    appendConfirmedJournal(statePath, { index, bv, at: Date.now(), createdAt: state.createdAt });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: "confirmation journal append failed: " + String((e as Error)?.message ?? e) };
  }
}
