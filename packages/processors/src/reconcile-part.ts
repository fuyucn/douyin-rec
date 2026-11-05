
/**
 * Read-only archive reconciliation for plan 046 PR3 (shadow mode).
 *
 * The processor never mutates the queue, uploads, deletes or re-enqueues a job. It records what the
 * future reconciling state machine would have concluded, plus the delay between a confirmed upload
 * and the first archive-list appearance. Those structured log lines are the only measurement source
 * for choosing a settle window; no negative result is trusted by default.
 */
import {
  PART_KINDS, type PartCtx,
  type ProcessContext, type ProcessJob, type ProcessResult, type Processor,
} from "@drec/core";
import { findRecentArchive, listAllArchives, type ArchiveHit, type ArchiveLookup, type ArchiveQuery } from "./archive-lookup.js";

export const RECONCILE_SHADOW_LOG = "@@DREC_RECONCILE_SHADOW@@";
export const RECONCILE_DELAY_LOG = "@@DREC_ARCHIVE_DELAY@@";
export const DEFAULT_RECONCILE_MAX_MS = 24 * 3600_000;
export const RECONCILE_LANE = "archive-lookup";

export interface ReconcilePartDeps {
  /** Explicit opt-in; the default never writes queue state. */
  shadowMode?: boolean;
  /** Explicit opt-in after a measured settle window exists; default false. */
  allowResend?: boolean;
  reconcileMaxMs?: number;
  now?: () => number;
  cookiesPath?: string;
  lookup?: ArchiveQuery;
  listArchives?: typeof listAllArchives;
  findArchive?: typeof findRecentArchive;
  /** Write seam; only called when shadowMode is explicitly false. Tests inject a spy to prove zero writes. */
  settle?: (jobId: string, outcome: "yes" | "no" | "unknown" | "timeout", ctx: Record<string, unknown>) => boolean;
  log?: (line: string) => void;
}

export interface ReconcileShadowRecord {
  v: 1;
  kind: "shadow";
  jobId: string;
  partKey: string;
  partIndex: number;
  outcome: ArchiveLookup | "no(未启用)";
  wouldBe: "done" | "pending" | "reconciling" | "failed";
  reason: string;
  shadowMode: boolean;
  at: number;
}

export interface ReconcileDelayRecord {
  v: 1;
  kind: "archive-delay";
  jobId: string;
  partKey: string;
  partIndex: number;
  confirmedAt: number;
  appearedAt: number;
  delayMs: number;
  at: number;
}

function partCtx(job: ProcessJob): PartCtx | null {
  const value = job.params.ctx;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ctx = value as Partial<PartCtx>;
  if (ctx.v !== 1 || typeof ctx.orderKey !== "string" || !Number.isSafeInteger(ctx.index)) return null;
  return ctx as PartCtx;
}

function confirmedAtOf(job: ProcessJob, now: number): number {
  const raw = job.params.confirmedAt ?? job.params.ackedAt ?? (job as { updatedAt?: unknown }).updatedAt ?? now;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : now;
}

function outcomeOf(proof: ArchiveLookup, allowResend: boolean): {
  outcome: ArchiveLookup | "no(未启用)"; wouldBe: ReconcileShadowRecord["wouldBe"]; reason: string;
} {
  if (proof === "yes") return { outcome: "yes", wouldBe: "done", reason: "reconcile-yes" };
  if (proof === "no") {
    return allowResend
      ? { outcome: "no", wouldBe: "pending", reason: "reconcile-no-resend" }
      : { outcome: "no(未启用)", wouldBe: "reconciling", reason: "reconcile-unknown: settle window not measured" };
  }
  return { outcome: "unknown", wouldBe: "reconciling", reason: "reconcile-unknown" };
}

function writeLine(log: ((line: string) => void) | undefined, fallback: (line: string) => void, tag: string, record: unknown): void {
  const line = tag + " " + JSON.stringify(record);
  try { (log ?? fallback)(line); } catch { /* Logging must never change the lookup result. */ }
}

export function makeReconcilePartProcessor(deps: ReconcilePartDeps = {}): Processor {
  const shadowMode = deps.shadowMode !== false;
  const allowResend = deps.allowResend === true;
  const reconcileMaxMs = deps.reconcileMaxMs ?? DEFAULT_RECONCILE_MAX_MS;
  const now = deps.now ?? Date.now;
  const lookup = deps.lookup ?? {};
  const listArchives = deps.listArchives ?? listAllArchives;
  const findArchive = deps.findArchive ?? findRecentArchive;
  const fallbackLog = (line: string): void => console.log(line);
  return {
    kind: PART_KINDS.reconcile,
    resource: "net",
    lane: RECONCILE_LANE,
    retryable: true,
    interruptible: true,
    validate(job: ProcessJob): string | null {
      return partCtx(job) ? null : "missing part-chain ctx";
    },
    estimateDiskBytes(): number { return 0; },
    async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
      const part = partCtx(job);
      if (!part) return { outputs: [] };
      const at = now();
      const confirmedAt = confirmedAtOf(job, at);
      const timedOut = at - confirmedAt >= reconcileMaxMs;
      const proof: ArchiveLookup = timedOut
        ? "unknown"
        : await findArchive(deps.cookiesPath ?? "", String(job.params.title ?? ""), Number(job.params.expectedDurationSec ?? 0), lookup);
      const hits: ArchiveHit[] | null = timedOut ? null : await listArchives(deps.cookiesPath ?? "", lookup);
      if (hits) {
        const draft = part.bv ?? (typeof job.params.bv === "string" ? job.params.bv : "");
        const appeared = draft ? hits.some((hit) => hit.bv === draft) : hits.length > 0;
        if (appeared) {
          writeLine(deps.log, fallbackLog, RECONCILE_DELAY_LOG, {
            v: 1, kind: "archive-delay", jobId: job.jobId, partKey: part.orderKey, partIndex: part.index,
            confirmedAt, appearedAt: at, delayMs: Math.max(0, at - confirmedAt), at,
          } satisfies ReconcileDelayRecord);
        }
      }
      const result = timedOut
        ? { outcome: "unknown" as const, wouldBe: "failed" as const, reason: "reconcile-timeout" }
        : outcomeOf(proof, allowResend);
      writeLine(deps.log, fallbackLog, RECONCILE_SHADOW_LOG, {
        v: 1, kind: "shadow", jobId: job.jobId, partKey: part.orderKey, partIndex: part.index,
        outcome: result.outcome, wouldBe: result.wouldBe, reason: result.reason, shadowMode, at,
      } satisfies ReconcileShadowRecord);
      ctx.log(RECONCILE_SHADOW_LOG + " " + result.outcome + " -> " + result.wouldBe);
      if (!shadowMode && deps.settle) {
        deps.settle(job.jobId, timedOut ? "timeout" : proof, { partKey: part.orderKey, reason: result.reason });
      }
      return { outputs: [] };
    },
  };
}

export const reconcilePartProcessor: Processor = makeReconcilePartProcessor();

