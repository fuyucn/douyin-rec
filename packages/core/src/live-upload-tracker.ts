import {
  LIVE_EVENT_LIMIT,
  LIVE_PART_LIMIT,
  type LiveCurrentPart,
  type LiveEvent,
  type LivePartPhase,
  type LivePartView,
  type LiveUploadMode,
  type LiveUploadSnapshot,
} from "./live-upload.js";

export interface LiveRunTracker {
  current: LiveUploadSnapshot;
  /** The archive a new session replaced, if this process saw a rollover. */
  previous?: LiveUploadSnapshot;
}

const clone = <T>(x: T): T => structuredClone(x);

function cap(s: LiveUploadSnapshot): LiveUploadSnapshot {
  return {
    ...s,
    events: s.events.slice(-LIVE_EVENT_LIMIT),
    parts: s.parts.slice(-LIVE_PART_LIMIT),
  };
}

function phaseFor(kind: LiveEvent["kind"], prev?: LivePartPhase): LivePartPhase | undefined {
  switch (kind) {
    case "part_streaming": return "streaming";
    case "part_sealed": return "sealing";
    case "part_submit":
    case "part_retry": return "submitting";
    case "part_confirmed": return "confirmed";
    case "part_unconfirmed": return "unconfirmed";
    case "part_failed": return "failed";
    default: return prev;
  }
}

function upsertPart(s: LiveUploadSnapshot, part: number, phase: LivePartPhase, e: LiveEvent): void {
  const i = s.parts.findIndex((p) => p.index === part);
  const base: LivePartView = i >= 0 ? s.parts[i] : { index: part, phase, uploadedBytes: 0, chunks: 0 };
  const next: LivePartView = {
    ...base,
    phase,
    ...(e.uploadedBytes !== undefined ? { uploadedBytes: e.uploadedBytes } : {}),
    ...(e.chunks !== undefined ? { chunks: e.chunks } : {}),
    ...(e.bytes !== undefined ? { bytes: e.bytes } : {}),
    ...(e.kind === "part_confirmed" && (e.bvid ?? s.bvid) ? { bvid: e.bvid ?? s.bvid } : {}),
    ...(e.kind === "part_failed" && e.message ? { error: e.message } : {}),
  };
  if (i >= 0) s.parts[i] = next;
  else s.parts.push(next);
  if (e.kind === "part_streaming" || e.kind === "part_sealed" || e.kind === "part_submit" || e.kind === "part_retry") {
    s.currentPart = {
      index: part,
      phase,
      uploadedBytes: next.uploadedBytes,
      chunks: next.chunks,
      ...(next.bytes !== undefined ? { bytes: next.bytes } : {}),
    };
  } else if (s.currentPart?.index === part) {
    s.currentPart = { ...s.currentPart, phase };
  }
}

export function createLiveRunTracker(o: {
  mode: LiveUploadMode;
  platform: string;
  roomSlug: string;
  now?: number;
}): LiveRunTracker {
  const now = o.now ?? Date.now();
  return {
    current: {
      schemaVersion: 1,
      mode: o.mode,
      platform: o.platform,
      roomSlug: o.roomSlug,
      state: "waiting",
      startedAt: now,
      updatedAt: now,
      parts: [],
      events: [],
    },
  };
}

/**
 * Pure event application. `run_start` on a waiting, sessionless snapshot binds the archive
 * in place (keeping waiting/live events); a different sessionId rotates current -> previous.
 */
export function applyLiveEvent(state: LiveRunTracker, e: LiveEvent): LiveRunTracker {
  const next: LiveRunTracker = { current: clone(state.current), ...(state.previous ? { previous: clone(state.previous) } : {}) };
  const s = next.current;
  s.updatedAt = Math.max(s.updatedAt, e.at);
  s.events.push(clone(e));

  if (e.kind === "run_start" || e.kind === "run_resume") {
    const session = e.session;
    if (session) {
      if (!s.sessionId) {
        s.sessionId = session.sessionId;
        s.createdAt = session.createdAt;
      } else if (s.sessionId !== session.sessionId) {
        next.previous = clone(s);
        const fresh: LiveUploadSnapshot = {
          schemaVersion: 1,
          mode: s.mode,
          sessionId: session.sessionId,
          createdAt: session.createdAt,
          platform: s.platform,
          roomSlug: s.roomSlug,
          state: e.kind === "run_resume" ? "streaming" : "waiting",
          startedAt: session.createdAt,
          updatedAt: e.at,
          parts: [],
          events: [clone(e)],
        };
        next.current = cap(fresh);
        return next;
      }
    }
    s.state = "streaming";
  } else if (e.kind === "waiting") {
    s.state = "waiting";
  } else if (e.kind === "live") {
    s.state = "streaming";
  } else if (e.kind === "run_end") {
    s.state = e.outcome ?? "finished";
  } else if (e.part !== undefined) {
    const phase = phaseFor(e.kind, s.currentPart?.phase);
    if (phase) {
      upsertPart(s, e.part, phase, e);
      if (e.kind === "part_confirmed") {
        if (e.bvid) s.bvid = e.bvid;
        s.state = "submitting";
      }
      else if (e.kind === "part_failed") s.state = "failed";
      else if (s.state === "waiting") s.state = "streaming";
    }
  }
  next.current = cap(s);
  return next;
}

/** Progress is in-memory only: no event is appended. */
export function applyProgress(
  state: LiveRunTracker,
  p: { part: number; uploadedBytes: number; chunks: number },
): LiveRunTracker {
  const next: LiveRunTracker = { current: clone(state.current), ...(state.previous ? { previous: clone(state.previous) } : {}) };
  const s = next.current;
  const part = s.parts.find((x) => x.index === p.part);
  if (part) {
    part.uploadedBytes = p.uploadedBytes;
    part.chunks = p.chunks;
  }
  if (s.currentPart?.index === p.part) {
    const cur: LiveCurrentPart = { ...s.currentPart, uploadedBytes: p.uploadedBytes, chunks: p.chunks };
    s.currentPart = cur;
  }
  return next;
}
