/**
 * job-log-cleanup.ts — manual age-based cleanup of hub job logs (issue #414).
 *
 * Hub job logs live at `<logsRoot>/hub/<平台>_<房间号>/<场次>.log` and are kept forever (no automatic
 * deletion). This module only ever runs on an explicit user request: it lists the `.log` files whose
 * mtime is older than N days, and deletes exactly that set. The preview and the delete use the same
 * selection function, so what the user confirmed is what gets removed.
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";

const DAY_MS = 24 * 3600_000;
/** Upper bound for the age input; anything above is a typo, not a request. */
export const JOB_LOG_MAX_DAYS = 3650;

export interface JobLogSelection {
  /** Absolute paths of the `.log` files older than the cutoff. */
  files: string[];
  bytes: number;
}

export interface JobLogPreview {
  olderThanDays: number;
  count: number;
  bytes: number;
}

export interface JobLogCleanupResult {
  olderThanDays: number;
  deleted: number;
  bytes: number;
  /** Files that could not be removed (basename + error code only); reported, never swallowed. */
  failed: Array<{ file: string; error: string }>;
}

/** Validate the age input: an integer day count in [1, JOB_LOG_MAX_DAYS]; null when invalid. */
export function parseJobLogDays(raw: unknown): number | null {
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > JOB_LOG_MAX_DAYS) return null;
  return n;
}

/** Every `.log` under `<logsRoot>/hub/<room dir>/` whose mtime is strictly older than `days`. */
export function selectJobLogs(logsRoot: string, days: number, now: number = Date.now()): JobLogSelection {
  const cutoff = now - days * DAY_MS;
  const out: JobLogSelection = { files: [], bytes: 0 };
  const hubDir = join(logsRoot, "hub");
  let rooms: string[];
  try { rooms = readdirSync(hubDir); } catch { return out; }
  for (const room of rooms) {
    const roomDir = join(hubDir, room);
    let names: string[];
    try { names = readdirSync(roomDir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      const p = join(roomDir, name);
      try {
        const st = statSync(p);
        if (!st.isFile() || st.mtimeMs >= cutoff) continue;
        out.files.push(p);
        out.bytes += st.size;
      } catch { /* vanished between listing and stat: nothing to delete */ }
    }
  }
  return out;
}

export function previewJobLogs(logsRoot: string, days: number, now?: number): JobLogPreview {
  const s = selectJobLogs(logsRoot, days, now);
  return { olderThanDays: days, count: s.files.length, bytes: s.bytes };
}

/**
 * Append the outcome to the shared maintenance audit file (same one the orphan cleanup uses).
 * Best effort: a failed audit write must not undo or mask the deletion itself.
 */
function appendAudit(auditDir: string | undefined, logsRoot: string, deleted: JobLogCleanupResult["deleted"], bytes: number, failed: JobLogCleanupResult["failed"]): void {
  if (deleted === 0 && failed.length === 0) return;
  try {
    const dir = auditDir ?? join(logsRoot, "..", "config", "maintenance");
    mkdirSync(dir, { recursive: true });
    const ts = Date.now();
    const lines = [
      ...deleted > 0 ? [JSON.stringify({ ts, action: "deleted", kind: "jobLog", count: deleted, bytes })] : [],
      ...failed.map((f) => JSON.stringify({ ts, action: "failed", kind: "jobLog", path: f.file, error: f.error })),
    ];
    if (lines.length) appendFileSync(join(dir, "cleanup-audit.jsonl"), lines.join("\n") + "\n", "utf-8");
  } catch (e) {
    console.error(`[job-log-cleanup] 审计日志写失败(删除已完成): ${(e as Error)?.message ?? e}`);
  }
}

export function cleanupJobLogs(logsRoot: string, days: number, now?: number, auditDir?: string): JobLogCleanupResult {
  const s = selectJobLogs(logsRoot, days, now);
  const failed: JobLogCleanupResult["failed"] = [];
  let deleted = 0;
  let bytes = 0;
  for (const file of s.files) {
    try {
      const size = statSync(file).size;
      rmSync(file);
      deleted += 1;
      bytes += size;
    } catch (e) {
      // Basename + error code only: the message from the fs layer embeds the full path, which would expose the data root.
      failed.push({ file: basename(file), error: (e as NodeJS.ErrnoException).code ?? "UNKNOWN" });
    }
  }
  appendAudit(auditDir, logsRoot, deleted, bytes, failed);
  return { olderThanDays: days, deleted, bytes, failed };
}
