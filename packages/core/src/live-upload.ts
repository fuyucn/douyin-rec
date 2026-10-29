/**
 * Live-upload run timeline contract.
 *
 * The snapshot is for display only. It must never influence upload decisions, and a
 * malformed snapshot from an older/hostile node must degrade to "no timeline", not fail
 * the task.
 */

export const LIVE_EVENT_LIMIT = 200;
export const LIVE_PART_LIMIT = 500;
/** Smaller caps for the per-node report, which is fetched on every hub sync tick. */
export const REPORT_EVENT_LIMIT = 100;
export const REPORT_PART_LIMIT = 200;
export const LIVE_MESSAGE_LIMIT = 300;

export type LiveUploadMode = "zero-disk" | "rolling";
export type LivePartPhase = "streaming" | "sealing" | "submitting" | "confirmed" | "unconfirmed" | "failed";
export type LiveUploadState = "waiting" | "streaming" | "submitting" | "finished" | "failed" | "stopped";

export type LiveEventKind =
  | "run_start"
  | "run_resume"
  | "waiting"
  | "live"
  | "part_streaming"
  | "part_sealed"
  | "part_submit"
  | "part_confirmed"
  | "part_unconfirmed"
  | "part_retry"
  | "part_failed"
  | "recovered"
  | "stalled"
  | "season_pending"
  | "season_done"
  | "season_failed"
  | "run_end";

export interface LiveEventSession {
  sessionId: string;
  createdAt: number;
  resumed: boolean;
}

export interface LiveEvent {
  at: number;
  kind: LiveEventKind;
  part?: number;
  uploadedBytes?: number;
  chunks?: number;
  bytes?: number;
  bvid?: string;
  message?: string;
  outcome?: "finished" | "failed" | "stopped";
  session?: LiveEventSession;
}

export interface LivePartView {
  index: number;
  phase: LivePartPhase;
  uploadedBytes: number;
  bytes?: number;
  chunks: number;
  bvid?: string;
  error?: string;
}

export interface LiveCurrentPart {
  index: number;
  phase: LivePartPhase;
  uploadedBytes: number;
  bytes?: number;
  chunks: number;
}

export interface LiveUploadSnapshot {
  schemaVersion: 1;
  mode: LiveUploadMode;
  /** Absent until the first run_start/run_resume binds this archive. */
  sessionId?: string;
  /** Archive creation time; uses the same identity as LivePumpState.createdAt. */
  createdAt?: number;
  platform: string;
  roomSlug: string;
  state: LiveUploadState;
  startedAt: number;
  updatedAt: number;
  currentPart?: LiveCurrentPart;
  parts: LivePartView[];
  events: LiveEvent[];
  bvid?: string;
}

/** Compact projection carried by GET /api/tasks and _zero-disk-report. */
export interface LiveUploadSummary {
  sessionId?: string;
  state: LiveUploadState;
  currentPart?: LiveCurrentPart;
  partsConfirmed: number;
  bvid?: string;
  updatedAt: number;
}

export function liveUploadSummary(s: LiveUploadSnapshot): LiveUploadSummary {
  return {
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
    state: s.state,
    ...(s.currentPart ? { currentPart: s.currentPart } : {}),
    partsConfirmed: s.parts.filter((p) => p.phase === "confirmed").length,
    ...(s.bvid ? { bvid: s.bvid } : {}),
    updatedAt: s.updatedAt,
  };
}

/** Producer seam. Implementations must swallow their own I/O errors. */
export interface LivePumpReporter {
  event(e: LiveEvent): void;
  progress(p: { part: number; uploadedBytes: number; chunks: number }): void;
}

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const PHASES: readonly LivePartPhase[] = ["streaming", "sealing", "submitting", "confirmed", "unconfirmed", "failed"];
const STATES: readonly LiveUploadState[] = ["waiting", "streaming", "submitting", "finished", "failed", "stopped"];
const KINDS: readonly LiveEventKind[] = [
  "run_start", "run_resume", "waiting", "live", "part_streaming", "part_sealed", "part_submit",
  "part_confirmed", "part_unconfirmed", "part_retry", "part_failed", "recovered", "stalled",
  "season_pending", "season_done", "season_failed", "run_end",
];

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);
const nonNeg = (x: unknown): x is number => num(x) && x >= 0;
const nonNegInt = (x: unknown): x is number => num(x) && Number.isInteger(x) && x >= 0;
const text = (x: unknown, max = LIVE_MESSAGE_LIMIT): x is string =>
  typeof x === "string" && x.length > 0 && x.length <= max;

function normalizeEvent(x: unknown): LiveEvent | null {
  if (!isRecord(x) || !nonNeg(x.at) || typeof x.kind !== "string" || !KINDS.includes(x.kind as LiveEventKind)) return null;
  if (x.part !== undefined && !nonNegInt(x.part)) return null;
  if (x.uploadedBytes !== undefined && !nonNeg(x.uploadedBytes)) return null;
  if (x.chunks !== undefined && !nonNegInt(x.chunks)) return null;
  if (x.bytes !== undefined && !nonNeg(x.bytes)) return null;
  const session = x.session;
  if (session !== undefined) {
    if (!isRecord(session) || !text(session.sessionId, 300) || !nonNeg(session.createdAt) || typeof session.resumed !== "boolean") return null;
  }
  if (x.outcome !== undefined && x.outcome !== "finished" && x.outcome !== "failed" && x.outcome !== "stopped") return null;
  return {
    at: x.at,
    kind: x.kind as LiveEventKind,
    ...(x.part !== undefined ? { part: x.part as number } : {}),
    ...(x.uploadedBytes !== undefined ? { uploadedBytes: x.uploadedBytes as number } : {}),
    ...(x.chunks !== undefined ? { chunks: x.chunks as number } : {}),
    ...(x.bytes !== undefined ? { bytes: x.bytes as number } : {}),
    ...(typeof x.bvid === "string" && x.bvid ? { bvid: x.bvid } : {}),
    ...(typeof x.message === "string" ? { message: x.message.slice(0, LIVE_MESSAGE_LIMIT) } : {}),
    ...(x.outcome ? { outcome: x.outcome } : {}),
    ...(session ? { session: { ...(session as unknown as LiveEventSession) } } : {}),
  };
}

function normalizePart(x: unknown): LivePartView | null {
  if (!isRecord(x) || !nonNegInt(x.index) || typeof x.phase !== "string" || !PHASES.includes(x.phase as LivePartPhase)) return null;
  if (!nonNeg(x.uploadedBytes) || !nonNegInt(x.chunks)) return null;
  if (x.bytes !== undefined && !nonNeg(x.bytes)) return null;
  return {
    index: x.index,
    phase: x.phase as LivePartPhase,
    uploadedBytes: x.uploadedBytes,
    chunks: x.chunks,
    ...(x.bytes !== undefined ? { bytes: x.bytes as number } : {}),
    ...(typeof x.bvid === "string" && x.bvid ? { bvid: x.bvid } : {}),
    ...(typeof x.error === "string" && x.error ? { error: x.error.slice(0, LIVE_MESSAGE_LIMIT) } : {}),
  };
}

function normalizeCurrent(x: unknown): LiveCurrentPart | null {
  if (!isRecord(x) || !nonNegInt(x.index) || typeof x.phase !== "string" || !PHASES.includes(x.phase as LivePartPhase)) return null;
  if (!nonNeg(x.uploadedBytes) || !nonNegInt(x.chunks)) return null;
  if (x.bytes !== undefined && !nonNeg(x.bytes)) return null;
  return {
    index: x.index,
    phase: x.phase as LivePartPhase,
    uploadedBytes: x.uploadedBytes,
    chunks: x.chunks,
    ...(x.bytes !== undefined ? { bytes: x.bytes as number } : {}),
  };
}

/** Lenient per item, strict per root. Never throws on arbitrary JSON. */
export function normalizeLiveUploadSnapshot(x: unknown): LiveUploadSnapshot | null {
  try {
    if (!isRecord(x) || x.schemaVersion !== 1) return null;
    if (x.mode !== "zero-disk" && x.mode !== "rolling") return null;
    if (!text(x.platform, 80) || !text(x.roomSlug, 300)) return null;
    if (typeof x.state !== "string" || !STATES.includes(x.state as LiveUploadState)) return null;
    if (!nonNeg(x.startedAt) || !nonNeg(x.updatedAt)) return null;
    const sessionId = x.sessionId === undefined ? undefined : text(x.sessionId, 500) ? x.sessionId : null;
    if (sessionId === null) return null;
    const createdAt = x.createdAt === undefined ? undefined : nonNeg(x.createdAt) ? x.createdAt : null;
    if (createdAt === null) return null;
    const events = (Array.isArray(x.events) ? x.events : []).map(normalizeEvent).filter((e): e is LiveEvent => e !== null)
      .sort((a, b) => a.at - b.at).slice(-LIVE_EVENT_LIMIT);
    const parts = (Array.isArray(x.parts) ? x.parts : []).map(normalizePart).filter((p): p is LivePartView => p !== null)
      .sort((a, b) => a.index - b.index).slice(-LIVE_PART_LIMIT);
    const currentPart = x.currentPart === undefined ? undefined : normalizeCurrent(x.currentPart);
    if (x.currentPart !== undefined && !currentPart) return null;
    return {
      schemaVersion: 1,
      mode: x.mode,
      ...(sessionId ? { sessionId } : {}),
      ...(createdAt !== undefined ? { createdAt } : {}),
      platform: x.platform,
      roomSlug: x.roomSlug,
      state: x.state as LiveUploadState,
      startedAt: x.startedAt,
      updatedAt: x.updatedAt,
      ...(currentPart ? { currentPart } : {}),
      parts,
      events,
      ...(typeof x.bvid === "string" && x.bvid ? { bvid: x.bvid } : {}),
    };
  } catch {
    return null;
  }
}

/** Smaller copy for _zero-disk-report; the local file keeps the full caps. */
export function capLiveUploadSnapshot(
  s: LiveUploadSnapshot,
  caps: { events?: number; parts?: number } = {},
): LiveUploadSnapshot {
  const events = caps.events ?? REPORT_EVENT_LIMIT;
  const parts = caps.parts ?? REPORT_PART_LIMIT;
  return {
    ...s,
    events: s.events.slice(-events),
    parts: s.parts.slice(-parts),
  };
}
