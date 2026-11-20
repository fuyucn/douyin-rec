/** Shared read-only SQLite primitives for hub job queries. */

import { DatabaseSync } from "node:sqlite";
import { HUB_TERMINAL_STATES, type HubQueueStats } from "@drec/core";
import type { HubJobEvent, AttachedTables } from "./hub-job-types.js";

export const TERMINAL = new Set<string>(HUB_TERMINAL_STATES);

export const TERMINAL_SQL = HUB_TERMINAL_STATES.map((s) => `'${s}'`).join(",");

export const FALLBACK_RATE: Record<string, number> = { pending: 0.01, settling: 0.05, syncing: 0.1, merging: 0.3, uploading: 0.6 };

const LEDGER_BUSY_TIMEOUT_MS = 3000;

const IN_CHUNK = 900;

/**
 * Read compatibility is deliberately bounded to known legacy omissions: the `sync_job_steps`
 * table, job review/upload columns, step.detail, and candidate.danmuCount. Events, candidates,
 * node states, and every column used by their projections remain required.
 */
const OPTIONAL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  sync_jobs: ["uploadStatus", "ackedAt", "ackNote"],
  sync_job_steps: ["detail"],
  sync_candidates: ["danmuCount"],
};

const REQUIRED_COLUMNS = {
  sync_jobs: ["streamKey", "state", "winnerWorker", "bv", "error", "fails", "updatedAt"],
  sync_job_events: ["streamKey", "state", "at"],
  sync_job_steps: ["streamKey", "step", "phase", "at"],
  sync_candidates: ["streamKey", "workerId", "coverage", "durationSec", "totalGapSec", "isWinner"],
  sync_node_states: ["streamKey", "node", "state", "error", "attempts", "updatedAt"],
} as const;

export interface HubJobLedgerSchema {
  jobs: ReadonlySet<string>;
  events: ReadonlySet<string> | null;
  steps: ReadonlySet<string> | null;
  candidates: ReadonlySet<string> | null;
  nodeStates: ReadonlySet<string> | null;
}

export class HubJobLedgerSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubJobLedgerSchemaError";
  }
}

function tableColumns(db: DatabaseSync, table: string): Set<string> | null {
  const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
  if (!found) return null;
  return new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
}

function validateColumns(table: keyof typeof REQUIRED_COLUMNS, columns: ReadonlySet<string> | null, required: readonly string[]): void {
  if (!columns) {
    if (table === "sync_job_steps") return; // The supported pre-step-table ledger has no step projection.
    throw new HubJobLedgerSchemaError(`hub 台账缺少必需表 ${table}`);
  }
  const missing = required.filter((column) => !columns.has(column));
  if (missing.length) throw new HubJobLedgerSchemaError(`hub 台账表 ${table} 缺少必需列: ${missing.join(", ")}`);
}

function hasOptionalColumn(table: string, columns: ReadonlySet<string>, column: string): boolean {
  return OPTIONAL_COLUMNS[table]?.includes(column) === true && columns.has(column);
}

export function jobProjectionColumns(schema: HubJobLedgerSchema): string[] {
  const optional = OPTIONAL_COLUMNS.sync_jobs.filter((column) => schema.jobs.has(column));
  return [...REQUIRED_COLUMNS.sync_jobs, ...optional];
}

export function inspectHubJobLedger(db: DatabaseSync): HubJobLedgerSchema {
  const tables = Object.keys(REQUIRED_COLUMNS) as Array<keyof typeof REQUIRED_COLUMNS>;
  const names = tables.map((table) => `'${table}'`).join(", ");
  const nonTables = db.prepare(`SELECT name, type FROM sqlite_master WHERE name IN (${names}) AND type <> 'table'`)
    .all() as Array<{ name: string; type: string }>;
  if (nonTables.length) throw new HubJobLedgerSchemaError(`hub 台账对象 ${nonTables[0].name} 不是数据表`);
  const sql = tables.map((table) =>
    `SELECT '${table}' AS tableName, name AS columnName FROM pragma_table_info('${table}') ` +
      `WHERE EXISTS (SELECT 1 FROM sqlite_master WHERE type='table' AND name='${table}')`,
  ).join(" UNION ALL ");
  const columns = new Map<string, Set<string> | null>(tables.map((table) => [table, null]));
  for (const row of db.prepare(sql).all() as Array<{ tableName: string; columnName: string }>) {
    const tableColumns = columns.get(row.tableName) ?? new Set<string>();
    tableColumns.add(row.columnName);
    columns.set(row.tableName, tableColumns);
  }
  const jobs = columns.get("sync_jobs") ?? null;
  const events = columns.get("sync_job_events") ?? null;
  const steps = columns.get("sync_job_steps") ?? null;
  const candidates = columns.get("sync_candidates") ?? null;
  const nodeStates = columns.get("sync_node_states") ?? null;
  validateColumns("sync_jobs", jobs, REQUIRED_COLUMNS.sync_jobs);
  validateColumns("sync_job_events", events, REQUIRED_COLUMNS.sync_job_events);
  validateColumns("sync_job_steps", steps, REQUIRED_COLUMNS.sync_job_steps);
  validateColumns("sync_candidates", candidates, REQUIRED_COLUMNS.sync_candidates);
  validateColumns("sync_node_states", nodeStates, REQUIRED_COLUMNS.sync_node_states);
  return { jobs: jobs!, events, steps, candidates, nodeStates };
}

function groupAttachedRows<T>(rows: readonly Record<string, unknown>[], map: (row: Record<string, unknown>) => T): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const key = row.streamKey as string;
    const group = grouped.get(key);
    if (group) group.push(map(row));
    else grouped.set(key, [map(row)]);
  }
  return grouped;
}

function compareNodeNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortAttachedRows(out: AttachedTables): void {
  for (const rows of out.events.values()) rows.sort((a, b) => a.at - b.at || a.rid - b.rid);
  for (const rows of out.steps.values()) rows.sort((a, b) => a.at - b.at || a.rid - b.rid);
  for (const rows of out.candidates.values()) {
    rows.sort((a, b) => (a.isWinner === b.isWinner ? b.coverage - a.coverage : a.isWinner ? -1 : 1));
  }
  for (const rows of out.nodeStates.values()) rows.sort((a, b) => compareNodeNames(a.node, b.node));
}

export function openLedger(syncDbPath: string): DatabaseSync {
  const db = new DatabaseSync(syncDbPath, { readOnly: true });
  try {
    db.exec(`PRAGMA busy_timeout=${LEDGER_BUSY_TIMEOUT_MS}`);
    return db;
  } catch (error) {
    try { db.close(); } catch { /* Preserve the original open/configuration error. */ }
    throw error;
  }
}

export function hasAckColumns(db: DatabaseSync): boolean {
  return tableColumns(db, "sync_jobs")?.has("ackedAt") ?? false;
}

export function historicalRates(db: DatabaseSync, schema: HubJobLedgerSchema): Map<string, number> {
  if (!schema.events || !schema.candidates) return new Map();
  const doneKeys = (db.prepare("SELECT streamKey FROM sync_jobs WHERE state='done' ORDER BY updatedAt DESC LIMIT 5")
    .all() as unknown as { streamKey: string }[]).map((r) => r.streamKey);
  const samples = new Map<string, number[]>();
  for (const key of doneKeys) {
    const dur = (db.prepare("SELECT durationSec FROM sync_candidates WHERE streamKey=? AND isWinner=1").get(key) as
      unknown as { durationSec: number } | undefined)?.durationSec;
    if (!dur || dur <= 0) continue;
    const ev = db.prepare("SELECT state, at FROM sync_job_events WHERE streamKey=? ORDER BY at ASC, rowid ASC")
      .all(key) as unknown as HubJobEvent[];
    for (let i = 0; i + 1 < ev.length; i++) {
      const stepSec = (ev[i + 1].at - ev[i].at) / 1000;
      if (stepSec <= 0) continue;
      (samples.get(ev[i].state) ?? samples.set(ev[i].state, []).get(ev[i].state)!).push(stepSec / dur);
    }
  }
  const rates = new Map<string, number>();
  for (const [state, arr] of samples) {
    arr.sort((a, b) => a - b);
    rates.set(state, arr[Math.floor(arr.length / 2)]);
  }
  return rates;
}

export function batchAttached(db: DatabaseSync, keys: readonly string[], schema: HubJobLedgerSchema): AttachedTables {
  const out: AttachedTables = { events: new Map(), steps: new Map(), candidates: new Map(), nodeStates: new Map() };
  const uniq = [...new Set(keys)];
  if (uniq.length === 0) return out;

  const queryIn = (sql: (ph: string) => string): Record<string, unknown>[] => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < uniq.length; i += IN_CHUNK) {
      const chunk = uniq.slice(i, i + IN_CHUNK);
      rows.push(...(db.prepare(sql(Array(chunk.length).fill("?").join(",")))
        .all(...chunk) as unknown as Record<string, unknown>[]));
    }
    return rows;
  };

  if (schema.events) {
    out.events = groupAttachedRows(
      queryIn((ph) => `SELECT streamKey, state, at, rowid AS rid FROM sync_job_events WHERE streamKey IN (${ph})`),
      (r) => ({ state: r.state as string, at: Number(r.at), rid: Number(r.rid) }),
    );
  }

  if (schema.steps) {
    const detail = hasOptionalColumn("sync_job_steps", schema.steps, "detail") ? ", detail" : "";
    out.steps = groupAttachedRows(
      queryIn((ph) => `SELECT streamKey, step, phase, at${detail}, rowid AS rid FROM sync_job_steps WHERE streamKey IN (${ph})`),
      (r) => ({
        step: r.step as string, phase: r.phase as string, at: Number(r.at), rid: Number(r.rid),
        detail: (r.detail as string | undefined) ?? undefined,
      }),
    );
  }

  if (schema.candidates) {
    const danmuCount = hasOptionalColumn("sync_candidates", schema.candidates, "danmuCount") ? ", danmuCount" : "";
    out.candidates = groupAttachedRows(
      queryIn((ph) => `SELECT streamKey, workerId, coverage, durationSec, totalGapSec${danmuCount}, isWinner
                       FROM sync_candidates WHERE streamKey IN (${ph})`),
      (r) => ({
        worker: r.workerId as string,
        coverage: Number(r.coverage),
        durationSec: Number(r.durationSec),
        danmuCount: r.danmuCount == null ? null : Number(r.danmuCount),
        complete: Number(r.totalGapSec) <= 0,
        isWinner: Number(r.isWinner) === 1,
      }),
    );
  }

  if (schema.nodeStates) {
    out.nodeStates = groupAttachedRows(
      queryIn((ph) => `SELECT streamKey, node, state, error, attempts, updatedAt FROM sync_node_states WHERE streamKey IN (${ph})`),
      (r) => ({
        node: r.node as string, state: r.state as string, error: (r.error as string | null) ?? null,
        attempts: Number(r.attempts), updatedAt: Number(r.updatedAt),
      }),
    );
  }
  sortAttachedRows(out);
  return out;
}

export function queueStats(syncDbPath: string, windowDays: number, now: number): HubQueueStats | undefined {
  try {
    const db = openLedger(syncDbPath);
    try {
      if (!hasAckColumns(db) && !tableExists(db)) return undefined;
      const dayMs = 24 * 60 * 60;
      const since = now - windowDays * dayMs * 1000;
      const rows = db.prepare(
        `SELECT state, COUNT(*) AS n FROM sync_jobs WHERE updatedAt > ? GROUP BY state`,
      ).all(since) as Array<{ state: string; n: number }>;
      const counts = new Map(rows.map((row) => [row.state, row.n]));
      const done = counts.get("done") ?? 0, failed = counts.get("failed") ?? 0;
      const manual = counts.get("needs_manual") ?? 0;
      const denom = done + failed + manual;
      return {
        windowDays, done, failed, needsManual: manual,
        successRate: denom > 0 ? Math.round((done / denom) * 100) / 100 : null,
      };
    } finally { db.close(); }
  } catch { return undefined; }
}

export function tableExists(db: DatabaseSync): boolean {
  try {
    const t = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sync_jobs'").all();
    return t.length > 0;
  } catch { return false; }
}
