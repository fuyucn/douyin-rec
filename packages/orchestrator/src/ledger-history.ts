/**
 * Ledger history deletion — the single writer of the hub ledger's history rows.
 *
 * The ledger schema (sync_jobs / sync_job_events / sync_candidates / ...) belongs to this package
 * (SyncLedger writes it). app used to open a second, write-capable sqlite connection to delete a
 * room's history, which made one schema have two owners (audit 2026-11-10 C). The web layer now
 * calls this function through an injected dependency instead.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, rmSync } from "node:fs";
import { HUB_TABLE_NAMES, jobLogPathCandidates } from "@drec/core";

/** Budget for waiting on the writers' lock; without it a busy ledger silently fails the request. */
const LEDGER_BUSY_TIMEOUT_MS = 3000;

export interface DeleteHubHistoryResult {
  /** Number of deleted runs (counted by sync_jobs rows; tables missing in an old db are skipped). */
  deleted: number;
  /** Stream keys of the deleted runs (empty when the db has no sync_jobs table yet). */
  streamKeys: string[];
}

export interface DeleteHubHistoryOptions {
  syncDbPath: string;
  /** Room key `{platform}.{roomSlug}`. */
  roomKey: string;
  /** Stage root and job-log root; both are resolved by the caller (same order as hub startup). */
  stageDir: string;
  logsDir: string;
}

/** room key `{platform}.{roomSlug}` → streamKey prefix `{platform}:{roomSlug}:` (first dot only). */
export function roomKeyToStreamPrefix(roomKey: string): string {
  return `${roomKey.replace(".", ":")}:`;
}

/**
 * Delete every history run of a room: the ledger tables plus each run's job.log.
 *
 * Write connection (issue #428): this runs concurrently with SyncLedger writers, so it waits on the
 * lock (`busy_timeout`) and wraps the five DELETEs in one `BEGIN IMMEDIATE` transaction — a
 * mid-way failure rolls back instead of leaving half a room's history deleted.
 */
export function deleteHubHistory(o: DeleteHubHistoryOptions): DeleteHubHistoryResult {
  const prefix = roomKeyToStreamPrefix(o.roomKey);
  if (!existsSync(o.syncDbPath)) return { deleted: 0, streamKeys: [] };
  const db = new DatabaseSync(o.syncDbPath);
  let rows: { streamKey: string }[] = [];
  try {
    try { db.exec(`PRAGMA busy_timeout=${LEDGER_BUSY_TIMEOUT_MS}`); } catch { /* very old sqlite: keep the default */ }
    db.exec("BEGIN IMMEDIATE");
    try {
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[]).map((r) => r.name),
      );
      try {
        rows = db.prepare("SELECT streamKey FROM sync_jobs WHERE streamKey LIKE ?").all(prefix + "%") as unknown as { streamKey: string }[];
      } catch { /* old db without sync_jobs → still delete from the tables that exist */ }
      for (const table of HUB_TABLE_NAMES) {
        if (!tables.has(table)) continue;
        db.prepare(`DELETE FROM ${table} WHERE streamKey LIKE ?`).run(prefix + "%");
      }
      db.exec("COMMIT");
    } catch (e) {
      try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
      throw e;
    }
  } finally {
    db.close();
  }
  const streamKeys = rows.map((r) => r.streamKey);
  for (const key of streamKeys) {
    // Both locations: the log may be in the new logs dir, or in stage for sessions older than the move.
    for (const p of jobLogPathCandidates(o.stageDir, key, o.logsDir)) {
      try { rmSync(p, { force: true }); } catch { /* missing / permission → never block the delete */ }
    }
  }
  return { deleted: streamKeys.length, streamKeys };
}
