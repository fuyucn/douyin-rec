/** Read-only room job details, timing estimates, and log locations. */

import type { DatabaseSync } from "node:sqlite";
import { existsSync, readFileSync, statSync } from "node:fs";
import { HUB_ROOM_STREAM_PREDICATE, STAGE_READY, USER_STOP, dbPathMissing, jobLogPathCandidates, roomKeyToStreamPrefix, type NodeUploadStatusDTO, type QueuePhase } from "@drec/core";
import { rootHubConfig, rootLogsDir, rootStageDir } from "./paths.js";
import { openLedger, inspectHubJobLedger, jobProjectionColumns, historicalRates, batchAttached, TERMINAL, FALLBACK_RATE } from "./hub-job-ledger.js";
import type { AttachedTables, HubJobView, RawJob, ListHubJobsOpts, HubJobsResult, LatestRunPerRoom } from "./hub-job-types.js";

export function hubStageDir(): string {
  try {
    const p = rootHubConfig();
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, "utf-8")) as { stageDir?: string };
      if (cfg.stageDir) return cfg.stageDir;
    }
  } catch {                 }
  return rootStageDir();
}

export function hubLogsDir(): string {
  return rootLogsDir();
}

export function jobLogPaths(streamKey: string, stageDir = hubStageDir(), logsDir = hubLogsDir()): string[] {
  return jobLogPathCandidates(stageDir, streamKey, logsDir);
}

export function jobLogPath(streamKey: string, stageDir = hubStageDir(), logsDir = hubLogsDir()): string {
  return jobLogPaths(streamKey, stageDir, logsDir)[0];
}

function existingJobLog(streamKey: string, stageDir: string, logsDir: string): string | null {
  return jobLogPaths(streamKey, stageDir, logsDir).find((p) => existsSync(p)) ?? null;
}

export const NODE_UPLOAD_ETA_FRESH_MS = 5 * 60_000;

export function parseNodeUploadStatus(raw: string | null | undefined): NodeUploadStatusDTO | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as NodeUploadStatusDTO;
    return v && typeof v.nodeId === "string" && typeof v.phase === "string" && typeof v.polledAt === "number" ? v : null;
  } catch { return null; }
}

export function nodeUploadEtaSec(s: NodeUploadStatusDTO | null, now: number): number | null {
  const p = s?.progress;
  if (!s || !p || s.phase !== "biliup" || s.state !== "running" || now - s.polledAt > NODE_UPLOAD_ETA_FRESH_MS) return null;
  if (!p.bps || p.bps <= 0 || p.totalBytes <= p.doneBytes) return null;
  return Math.ceil((p.totalBytes - p.doneBytes) / p.bps);
}

function jobViewOf(job: RawJob, attached: AttachedTables, rates: Map<string, number>, now: number, stageDir: string, logsDir: string): HubJobView {
  const events = attached.events.get(job.streamKey) ?? [];
  const steps = attached.steps.get(job.streamKey) ?? [];
  const candidates = attached.candidates.get(job.streamKey) ?? [];
  const nodeStates = attached.nodeStates.get(job.streamKey) ?? [];
  const videoDurationSec = candidates.find((candidate) => candidate.isWinner)?.durationSec ?? null;
  const terminal = TERMINAL.has(job.state);
  const stepStart = events.length ? events[events.length - 1].at : job.updatedAt;
  const currentStepSec = terminal ? null : Math.max(0, Math.round((now - stepStart) / 1000));
  let etaSec: number | null = null;
  if (!terminal && videoDurationSec && videoDurationSec > 0 && currentStepSec != null) {
    const rate = rates.get(job.state) ?? FALLBACK_RATE[job.state];
    if (rate != null) etaSec = estimateRemaining(rate, videoDurationSec, currentStepSec);
  }
  const nodeUpload = terminal ? null : parseNodeUploadStatus(job.uploadStatus);
  etaSec = nodeUploadEtaSec(nodeUpload, now) ?? etaSec;
  return {
    streamKey: job.streamKey, state: job.state, winnerWorker: job.winnerWorker ?? null,
    candidates, bv: job.bv ?? null, error: job.error ?? null,
    fails: Number(job.fails ?? 0), updatedAt: Number(job.updatedAt),
    startedAt: events.length ? Number(events[0].at) : null,
    events: events.map((event) => ({ state: event.state, at: Number(event.at) })),
    steps: steps.map((step) => ({ step: step.step, phase: step.phase, at: Number(step.at), detail: step.detail ?? undefined })),
    nodeStates, currentStepSec, etaSec, videoDurationSec,
    hasLog: existingJobLog(job.streamKey, stageDir, logsDir) !== null,
    nodeUpload,
    ackedAt: job.ackedAt == null ? null : Number(job.ackedAt),
    ackNote: job.ackNote ?? null,
  };
}

function estimateRemaining(rate: number, videoDurationSec: number, currentStepSec: number): number | null {
  const remaining = Math.round(rate * videoDurationSec - currentStepSec);
  return remaining > 0 ? remaining : null;
}

function databaseFileExists(path: string): boolean {
  if (!path.trim()) throw new Error("hub 台账路径为空");
  // 与队列侧共用 core 的同一份存在性判定（ENOENT/ENOTDIR=不存在；其余 stat 失败上抛）。
  return !dbPathMissing(path);
}

function selectJobPage(db: DatabaseSync, schema: ReturnType<typeof inspectHubJobLedger>, opts: ListHubJobsOpts): { jobs: RawJob[]; total: number } {
  const { room, limit = 10, offset = 0 } = opts;
  const prefix = room ? roomKeyToStreamPrefix(room) : null;
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (prefix) { where.push(HUB_ROOM_STREAM_PREDICATE); params.push(prefix, prefix); }
  if (opts.states && opts.states.length > 0) {
    where.push(`state IN (${Array(opts.states.length).fill("?").join(",")})`);
    params.push(...opts.states);
  } else if (opts.excludeStates && opts.excludeStates.length > 0) {
    where.push(`state NOT IN (${Array(opts.excludeStates.length).fill("?").join(",")})`);
    params.push(...opts.excludeStates);
  }
  // Error filters compose with state filters; NULL and empty both mean unmarked.
  // Match STAGE_READY verbatim, without trimming, as the queue row projection does.
  if (opts.excludeError !== undefined) {
    where.push("COALESCE(error, '') <> ?");
    params.push(opts.excludeError);
  }
  if (opts.onlyError !== undefined) {
    where.push("error = ?");
    params.push(opts.onlyError);
  }
  if (opts.acked !== undefined) {
    if (schema.jobs.has("ackedAt")) where.push(opts.acked ? "ackedAt IS NOT NULL" : "ackedAt IS NULL");
    else if (opts.acked) where.push("0"); // The supported pre-review schema has no reviewed rows.
  }
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const total = Number((db.prepare(`SELECT COUNT(*) AS n FROM sync_jobs${whereSql}`)
    .get(...params) as unknown as { n: number }).n);
  const columns = jobProjectionColumns(schema).join(", ");
  const jobs = db.prepare(`SELECT ${columns} FROM sync_jobs${whereSql} ORDER BY updatedAt DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as unknown as RawJob[];
  return { jobs, total };
}

export function listHubJobs(syncDbPath: string, opts: ListHubJobsOpts = {}): HubJobsResult {
  const { now = Date.now(), stageDir = hubStageDir(), logsDir = hubLogsDir() } = opts;
  if (!databaseFileExists(syncDbPath)) return { jobs: [], total: 0 };
  const db = openLedger(syncDbPath);
  try {
    const schema = inspectHubJobLedger(db);
    const { jobs, total } = selectJobPage(db, schema, opts);
    const rates = historicalRates(db, schema);
    // Fetch related tables in batches and bucket rows in memory. The previous per-job approach
    // issued four queries per job, slowing queue reads at the 200-active-job limit.
    const attached = batchAttached(db, jobs.map((j) => j.streamKey), schema);
    const views = jobs.map((job) => jobViewOf(job, attached, rates, now, stageDir, logsDir));
    return { jobs: views, total };
  } finally {
    db.close();
  }
}

export function needsManualPhaseOf(error: string | null | undefined): QueuePhase {
  if (error === STAGE_READY) return "waiting_upload";
  if ((error ?? "").trim() === USER_STOP) return "stopped";
  return "waiting_manual";
}

export function latestRunPerRoom(syncDbPath: string): LatestRunPerRoom[] {
  if (!databaseFileExists(syncDbPath)) return [];
  const db = openLedger(syncDbPath);
  try {
    inspectHubJobLedger(db);
    const rows = db.prepare(`
      SELECT
        substr(streamKey, 1,
          instr(substr(streamKey, instr(streamKey, ':') + 1), ':') + instr(streamKey, ':')
        ) AS roomKey,
        streamKey, state, bv, updatedAt, error
      FROM (
        SELECT streamKey, state, bv, updatedAt, error,
               ROW_NUMBER() OVER (
                 PARTITION BY substr(streamKey, 1,
                   instr(substr(streamKey, instr(streamKey, ':') + 1), ':') + instr(streamKey, ':')
                 )
                 ORDER BY updatedAt DESC
               ) AS rn
        FROM sync_jobs
      )
      WHERE rn = 1
    `).all() as unknown as Array<Omit<LatestRunPerRoom, "manualPhase"> & { error: string | null }>;

    return rows.map(({ error, ...r }) => ({
      ...r,
      roomKey: r.roomKey.replace(/:$/, ""),
      updatedAt: Number(r.updatedAt),
      manualPhase: r.state === "needs_manual" ? needsManualPhaseOf(error) : null,
    }));
  } finally {
    db.close();
  }
}

export function readHubJobLog(streamKey: string, tailBytes = 65536, stageDir = hubStageDir(), logsDir = hubLogsDir()): string | null {
  const p = existingJobLog(streamKey, stageDir, logsDir);
  if (!p) return null;
  const size = statSync(p).size;
  const buf = readFileSync(p);
  return buf.subarray(Math.max(0, size - tailBytes)).toString("utf-8");
}
