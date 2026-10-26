import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 5;
const DDL = `
CREATE TABLE IF NOT EXISTS proc_jobs(
  jobId TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  logicalKey TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  inputs TEXT NOT NULL,
  outputs TEXT,
  params TEXT NOT NULL,
  replaceInputs INTEGER NOT NULL,
  ownerTaskId INTEGER,
  ownerStreamKey TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimedBy TEXT,
  everClaimed INTEGER NOT NULL DEFAULT 0,
  cancelRequested INTEGER NOT NULL DEFAULT 0,
  resultOutputs TEXT,
  note TEXT,
  error TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  startedAt INTEGER,
  finishedAt INTEGER,
  notBefore INTEGER,
  orderKey TEXT,
  seq INTEGER,
  step TEXT,
  bv TEXT,
  seasonState TEXT,
  childPid INTEGER,
  childPidStartedAt TEXT,
  prepJobId TEXT,
  progress TEXT);
CREATE INDEX IF NOT EXISTS idx_proc_jobs_kind_state ON proc_jobs(kind, state, createdAt);
CREATE INDEX IF NOT EXISTS idx_proc_jobs_logical ON proc_jobs(kind, logicalKey);
CREATE TABLE IF NOT EXISTS proc_runner_lease(
  kind TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pid INTEGER NOT NULL,
  heartbeatAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  handoverRequested INTEGER NOT NULL DEFAULT 0);
`;

/** v2-only index; requires the orderKey column to exist first. */
export const ORDER_INDEX = "CREATE INDEX IF NOT EXISTS idx_proc_jobs_order ON proc_jobs(orderKey, generation, seq);";

/** Cursor table created in v2. */
export const CURSOR_DDL = `CREATE TABLE IF NOT EXISTS proc_order_cursor(
  orderKey TEXT NOT NULL,
  generation INTEGER NOT NULL,
  lastClaimedAt INTEGER NOT NULL,
  PRIMARY KEY(orderKey, generation));`;

/**
 * v4 (#241): a kind just yielded on a handover request is reserved for the requester for one
 * lease period; runners that do not request handover (record processes) may not take it meanwhile.
 * Kept out of proc_runner_lease so "no lease row" still means "nobody holds it".
 */
export const RESERVATION_DDL = `CREATE TABLE IF NOT EXISTS proc_lease_reservation(
  kind TEXT PRIMARY KEY,
  reservedAt INTEGER NOT NULL,
  until INTEGER NOT NULL);`;

/** Columns added in v1 -> v2 (old DBs use ALTER TABLE; fresh DBs get them from DDL). */
export const V2_COLUMNS: readonly [string, string][] = [
  ["notBefore", "INTEGER"], ["orderKey", "TEXT"], ["seq", "INTEGER"], ["step", "TEXT"],
  ["bv", "TEXT"], ["childPid", "INTEGER"], ["childPidStartedAt", "TEXT"], ["prepJobId", "TEXT"],
];

/** Columns added in v2 -> v3 (plan 038 PR5: byte progress JSON for the queue page). */
export const V3_COLUMNS: readonly [string, string][] = [["progress", "TEXT"]];

/** Columns added in v4 -> v5 (Bilibili season association checkpoint). */
export const V5_COLUMNS: readonly [string, string][] = [["seasonState", "TEXT"]];

type Row = Record<string, unknown>;

/**
 * Idempotent, versioned migration. Runs inside BEGIN IMMEDIATE so two processes
 * opening the same new DB cannot both apply a step.
 */
export function migrateSchema(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    const v = Number((db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
    if (v < SCHEMA_VERSION) {
      if (v < 1) db.exec(DDL);
      if (v >= 1) {
        const cols = new Set((db.prepare("PRAGMA table_info(proc_jobs)").all() as Row[]).map((r) => String(r.name)));
        for (const [name, type] of [...V2_COLUMNS, ...V3_COLUMNS, ...V5_COLUMNS]) {
          if (!cols.has(name)) db.exec(`ALTER TABLE proc_jobs ADD COLUMN ${name} ${type}`);
        }
      }
      db.exec(CURSOR_DDL);
      db.exec(ORDER_INDEX);
      db.exec(RESERVATION_DDL);
      db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    }
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw e;
  }
}
