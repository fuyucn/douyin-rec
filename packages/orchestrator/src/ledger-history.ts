/**
 * Ledger history deletion — the single writer of the hub ledger's history rows.
 *
 * The ledger schema (sync_jobs / sync_job_events / sync_candidates / ...) belongs to this package
 * (SyncLedger writes it). app used to open a second, write-capable sqlite connection to delete a
 * room's history, which made one schema have two owners (audit 2026-11-10 C). The web layer now
 * calls this function through an injected dependency instead.
 */
import { DatabaseSync } from "node:sqlite";
import { rmSync, statSync } from "node:fs";
import {
  HUB_TABLE_NAMES, HUB_ROOM_STREAM_PREDICATE, HUB_TERMINAL_STATES, jobLogPathCandidates, roomKeyToStreamPrefix,
} from "@drec/core";

export { roomKeyToStreamPrefix } from "@drec/core";

/** Budget for waiting on the writers' lock; without it a busy ledger silently fails the request. */
const LEDGER_BUSY_TIMEOUT_MS = 3000;
const TERMINAL_STATES = new Set<string>(HUB_TERMINAL_STATES);

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

type HistoryRun = { streamKey: string; state: string | null };

function deleteHistoryRows(db: DatabaseSync, prefix: string): string[] {
  db.exec("BEGIN IMMEDIATE");
  try {
    const objects = db.prepare(
      `SELECT name, type FROM sqlite_master WHERE lower(name) IN (${HUB_TABLE_NAMES.map(() => "?").join(",")})`,
    ).all(...HUB_TABLE_NAMES) as unknown as { name: string; type: string }[];
    const tables = new Set<string>();
    for (const object of objects) {
      if (object.type !== "table") {
        throw new Error(`Unexpected schema object type for ${object.name}: ${object.type}`);
      }
      tables.add(object.name.toLowerCase());
    }
    let rows: HistoryRun[] = [];
    if (tables.has("sync_jobs")) {
      rows = db.prepare(`SELECT streamKey, state FROM sync_jobs WHERE ${HUB_ROOM_STREAM_PREDICATE}`)
        .all(prefix, prefix) as unknown as HistoryRun[];
      const active = rows.find((row) => row.state === null || !TERMINAL_STATES.has(row.state));
      if (active) throw new Error(`Cannot delete room history while a hub run is active or unknown: ${active.streamKey}`);
    }
    for (const table of HUB_TABLE_NAMES) {
      if (!tables.has(table)) continue;
      db.prepare(`DELETE FROM ${table} WHERE ${HUB_ROOM_STREAM_PREDICATE}`).run(prefix, prefix);
    }
    db.exec("COMMIT");
    return rows.map((row) => row.streamKey);
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  }
}

/**
 * Delete every history run of a room: the ledger tables plus each run's job.log.
 *
 * Write connection (issue #428): this runs concurrently with SyncLedger writers, so it waits on the
 * lock (`busy_timeout`) and wraps the six DELETEs in one `BEGIN IMMEDIATE` transaction — a
 * mid-way failure rolls back instead of leaving half a room's history deleted.
 */
export function deleteHubHistory(o: DeleteHubHistoryOptions): DeleteHubHistoryResult {
  const prefix = roomKeyToStreamPrefix(o.roomKey);
  try {
    statSync(o.syncDbPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return { deleted: 0, streamKeys: [] };
    throw e;
  }
  const db = new DatabaseSync(o.syncDbPath);
  let streamKeys: string[];
  try {
    try { db.exec(`PRAGMA busy_timeout=${LEDGER_BUSY_TIMEOUT_MS}`); } catch { /* very old sqlite: keep the default */ }
    streamKeys = deleteHistoryRows(db, prefix);
  } finally {
    db.close();
  }
  for (const key of streamKeys) {
    // Keep both log locations compatible with sessions created before the move.
    for (const p of jobLogPathCandidates(o.stageDir, key, o.logsDir)) {
      try { rmSync(p, { force: true }); } catch { /* missing / permission → never block the delete */ }
    }
  }
  return { deleted: streamKeys.length, streamKeys };
}
