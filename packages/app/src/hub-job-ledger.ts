/** Shared read-only SQLite primitives for hub job queries. */

import { DatabaseSync } from "node:sqlite";
import { HUB_TERMINAL_STATES, type HubQueueStats } from "@drec/core";
import type { HubJobEvent, AttachedTables } from "./hub-job-types.js";

export const TERMINAL = new Set<string>(HUB_TERMINAL_STATES);

export const TERMINAL_SQL = HUB_TERMINAL_STATES.map((s) => `'${s}'`).join(",");

export const FALLBACK_RATE: Record<string, number> = { pending: 0.01, settling: 0.05, syncing: 0.1, merging: 0.3, uploading: 0.6 };

const LEDGER_BUSY_TIMEOUT_MS = 3000;

const IN_CHUNK = 900;

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
  } catch { /* Older SQLite versions may not support this pragma; keep the default. */ }
  return db;
}

export function hasAckColumns(db: DatabaseSync): boolean {
  try {
    const cols = db.prepare("PRAGMA table_info(sync_jobs)").all() as unknown as { name: string }[];
    return cols.some((c) => c.name === "ackedAt");
  } catch {
    return false;
  }
}

export function historicalRates(db: DatabaseSync): Map<string, number> {
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

export function batchAttached(db: DatabaseSync, keys: readonly string[]): AttachedTables {
  const out: AttachedTables = { events: new Map(), steps: new Map(), candidates: new Map(), nodeStates: new Map() };
  const uniq = [...new Set(keys)];
  if (uniq.length === 0) return out;

  const queryIn = (sql: (ph: string) => string): { rows: Record<string, unknown>[]; ok: boolean } => {
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < uniq.length; i += IN_CHUNK) {
      const chunk = uniq.slice(i, i + IN_CHUNK);
      try {
        rows.push(...(db.prepare(sql(Array(chunk.length).fill("?").join(",")))
          .all(...chunk) as unknown as Record<string, unknown>[]));
      } catch { return { rows, ok: false };                      }
    }
    return { rows, ok: true };
  };

  out.events = groupAttachedRows(
    queryIn((ph) => `SELECT streamKey, state, at, rowid AS rid FROM sync_job_events WHERE streamKey IN (${ph})`).rows,
    (r) => ({ state: r.state as string, at: Number(r.at), rid: Number(r.rid) }),
  );

  // Order steps by timestamp and row id; older ledgers may lack the detail column.
  let stepRows = queryIn((ph) => `SELECT streamKey, step, phase, at, detail, rowid AS rid FROM sync_job_steps WHERE streamKey IN (${ph})`);
  if (!stepRows.ok) {
    // If the detail query fails on an older schema, retry without that column.
    stepRows = queryIn((ph) => `SELECT streamKey, step, phase, at, rowid AS rid FROM sync_job_steps WHERE streamKey IN (${ph})`);
  }
  out.steps = groupAttachedRows(stepRows.rows, (r) => ({
    step: r.step as string, phase: r.phase as string, at: Number(r.at), rid: Number(r.rid),
    detail: (r.detail as string | undefined) ?? undefined,
  }));

  // candidates:ORDER BY isWinner DESC, coverage DESC
  out.candidates = groupAttachedRows(
    queryIn((ph) => `SELECT streamKey, workerId, coverage, durationSec, totalGapSec, danmuCount, isWinner
                     FROM sync_candidates WHERE streamKey IN (${ph})`).rows,
    (r) => ({
      worker: r.workerId as string,
      coverage: Number(r.coverage),
      durationSec: Number(r.durationSec),
      danmuCount: r.danmuCount == null ? null : Number(r.danmuCount),
      complete: Number(r.totalGapSec) <= 0,
      isWinner: Number(r.isWinner) === 1,
    }),
  );

  // nodeStates:ORDER BY node ASC
  out.nodeStates = groupAttachedRows(
    queryIn((ph) => `SELECT streamKey, node, state, error, attempts, updatedAt FROM sync_node_states WHERE streamKey IN (${ph})`).rows,
    (r) => ({
      node: r.node as string, state: r.state as string, error: (r.error as string | null) ?? null,
      attempts: Number(r.attempts), updatedAt: Number(r.updatedAt),
    }),
  );
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
