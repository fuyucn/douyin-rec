// packages/orchestrator/src/orphan-rule.ts
// Pure decision logic for orphan (unclaimed converted) segments vs broadcasts and done jobs. No IO.
import type { Broadcast } from "./identity.js";
import type { UnclaimedSegment } from "./unclaimed.js";

export const ORPHAN_SLACK_MS = 5 * 60_000;
export const DEFAULT_SEGMENT_SEC = 1800;

export interface OrphanWindow {
  workerId: string;
  sessionBase: string;
  platform: string | null;
  roomSlug: string | null;
  startMs: number | null;
  endMs: number | null;
  segmentCount: number;
  paths: string[];
}

export interface BroadcastSpan { streamKey: string; platform: string; roomSlug: string; startMs: number; endMs: number; }
export interface DoneWindow { streamKey: string; platform: string; roomSlug: string; startMs: number; endMs: number; }

/**
 * One window per (worker, sessionBase). The end is capped at the stamp plus the segment budget
 * (indices are 0-based) so a bogus later mtime cannot stretch the window. Null stamp = alert-only.
 */
export function orphanWindows(workerId: string, segs: readonly UnclaimedSegment[], slackMs = ORPHAN_SLACK_MS): OrphanWindow[] {
  const groups = new Map<string, UnclaimedSegment[]>();
  for (const s of segs) {
    const g = groups.get(s.sessionBase);
    if (g) g.push(s); else groups.set(s.sessionBase, [s]);
  }
  const out: OrphanWindow[] = [];
  for (const [sessionBase, g] of groups) {
    const room = g.find((s) => s.platform !== null && s.roomSlug !== null);
    const stamp = g.find((s) => s.stampMs !== null)?.stampMs ?? null;
    let startMs: number | null = null;
    let endMs: number | null = null;
    if (stamp !== null) {
      const maxIdx = Math.max(...g.map((s) => s.segmentIndex));
      const segSec = g.find((s) => s.segmentSec !== null)?.segmentSec ?? DEFAULT_SEGMENT_SEC;
      const capEnd = stamp + (maxIdx + 1) * segSec * 1000 + slackMs;
      startMs = stamp;
      endMs = Math.min(capEnd, Math.max(stamp, ...g.map((s) => s.mtimeMs)));
    }
    out.push({
      workerId, sessionBase,
      platform: room?.platform ?? null, roomSlug: room?.roomSlug ?? null,
      startMs, endMs, segmentCount: g.length, paths: g.map((s) => s.path),
    });
  }
  return out.sort((a, b) => (a.sessionBase < b.sessionBase ? -1 : a.sessionBase > b.sessionBase ? 1 : 0));
}

export function spanOf(b: Broadcast): BroadcastSpan {
  const endMs = b.members.length ? Math.max(...b.members.map((m) => m.rec.endMs)) : b.startMs;
  return { streamKey: b.streamKey, platform: b.platform, roomSlug: b.roomSlug, startMs: b.startMs, endMs };
}

function spansOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number, tol: number): boolean {
  return aStart <= bEnd + tol && bStart <= aEnd + tol;
}

/** Windows matching a span (same room, time overlap within tolerance) go to that streamKey; the rest are unmatched. */
export function matchOrphans(
  windows: readonly OrphanWindow[], spans: readonly BroadcastSpan[], toleranceMs = ORPHAN_SLACK_MS,
): { overlapByKey: Map<string, OrphanWindow[]>; unmatched: OrphanWindow[] } {
  const overlapByKey = new Map<string, OrphanWindow[]>();
  const unmatched: OrphanWindow[] = [];
  for (const w of windows) {
    let matched = false;
    if (w.platform !== null && w.roomSlug !== null && w.startMs !== null && w.endMs !== null) {
      for (const s of spans) {
        if (w.platform !== s.platform || w.roomSlug !== s.roomSlug) continue;
        if (!spansOverlap(w.startMs, w.endMs, s.startMs, s.endMs, toleranceMs)) continue;
        matched = true;
        const list = overlapByKey.get(s.streamKey);
        if (list) list.push(w); else overlapByKey.set(s.streamKey, [w]);
      }
    }
    if (!matched) unmatched.push(w);
  }
  return { overlapByKey, unmatched };
}

/** Parse `${platform}:${roomSlug}:${day}[_HHMM]`; split at the first and last ':' so a roomSlug may contain ':'. */
export function parseStreamKeyRoom(streamKey: string): { platform: string; roomSlug: string } | null {
  const first = streamKey.indexOf(":");
  const last = streamKey.lastIndexOf(":");
  if (first < 0 || last <= first) return null;
  const roomSlug = streamKey.slice(first + 1, last);
  if (!roomSlug) return null;
  return { platform: streamKey.slice(0, first), roomSlug };
}

export function toDoneWindow(row: { streamKey: string; startMs: number | null; endMs: number | null }): DoneWindow | null {
  if (row.startMs === null) return null;
  const room = parseStreamKeyRoom(row.streamKey);
  if (!room) return null;
  return { streamKey: row.streamKey, ...room, startMs: row.startMs, endMs: row.endMs ?? row.startMs };
}

/**
 * First done window (by startMs) of the same room but another streamKey that strictly overlaps the span.
 * No tolerance: a streamer restart shortly after a done job is a new broadcast, not a duplicate.
 */
export function findDoneOverlap(span: BroadcastSpan, done: readonly DoneWindow[]): DoneWindow | null {
  let best: DoneWindow | null = null;
  for (const d of done) {
    if (d.streamKey === span.streamKey || d.platform !== span.platform || d.roomSlug !== span.roomSlug) continue;
    if (!(span.startMs < d.endMs && d.startMs < span.endMs)) continue;
    if (!best || d.startMs < best.startMs) best = d;
  }
  return best;
}
