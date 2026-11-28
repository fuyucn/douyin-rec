import {
  closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";
import { hasUnobservedLivePumpWork, readLivePumpState } from "./live-pump-state.js";

/** Missing state has no work; unreadable state is unknown and must block cleanup. */
export function livePumpHasUnconfirmed(path: string): boolean {
  if (!existsSync(path)) return false;
  const state = readLivePumpState(path);
  if (!state) return true;
  return hasUnobservedLivePumpWork(state);
}

/** A historical queue acknowledgement, scoped to the original session by createdAt. */
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

/** Durable historical ACKs are retained, but do not authorize source cleanup. */
export function appendConfirmedJournal(statePath: string, entry: ConfirmedJournalEntry): void {
  mkdirSync(dirname(statePath), { recursive: true });
  const journal = confirmedJournalPath(statePath);
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

/** Historical ACKs are not qualified native per-part observations. */
export function confirmLivePumpPart(
  statePath: string,
  _index: number,
  bv: string,
  _fp: { size: number; mtimeMs: number },
): { ok: true } | { ok: false; error: string } {
  if (!bv) return { ok: false, error: "confirmLivePumpPart requires a confirmed bv" };
  const state = readLivePumpState(statePath);
  if (!state) return { ok: false, error: "live state missing or unreadable: " + statePath };
  return { ok: false, error: "live delivery requires native per-part observation; queue ACK cannot confirm it" };
}
