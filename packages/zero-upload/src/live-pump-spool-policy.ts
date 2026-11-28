import { existsSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { isSameBroadcastGap } from "@drec/core";
import { livePumpStatePath, readLivePumpState, requiresLivePumpProof, spoolPathsToKeep } from "./live-pump-state.js";
import { confirmedJournalPath, livePumpHasUnconfirmed } from "./live-pump-confirmations.js";

/** Archived states remain intact for audit and recovery. */
const ARCHIVED_SUFFIX = ".archived-";

/** Records real data-plane progress, not retries or timer ticks. */
const ACTIVITY_SUFFIX = ".activity";

function activityPathOf(statePath: string): string {
  return `${statePath}${ACTIVITY_SUFFIX}`;
}

export function markActivity(statePath: string, now: number): void {
  try {
    writeFileSync(activityPathOf(statePath), String(now) + "\n", { mode: 0o600 });
  } catch {
    // Best effort: a failed marker only loses this interval's evidence.
  }
}

function readActivityMs(statePath: string): number | undefined {
  try {
    return statSync(activityPathOf(statePath)).mtimeMs;
  } catch {
    return undefined;
  }
}

/** Preserve the old state, WAL and spools when starting a new broadcast.
 * Unknown identity or age is archived with an alert; active queue work never ages out. */
export function rolloverStaleState(path: string, room: string, nowMs: number, log: (msg: string) => void): string | undefined {
  if (!existsSync(path)) return undefined;
  const archive = (reason: string, alert: boolean): string => {
    let archived = `${path}${ARCHIVED_SUFFIX}${nowMs}`;
    for (let n = 1; existsSync(archived); n++) archived = `${path}${ARCHIVED_SUFFIX}${nowMs}-${n}`;
    renameSync(path, archived);
    // T-221 (review P1): the confirmation journal belongs to THIS session. A new broadcast reuses
    // the same path and the same part indexes — a stale journal left in place would make the new
    // session's parts look confirmed (skip enqueue / delete spools). Archive it beside the state.
    const journalFile = confirmedJournalPath(path);
    if (existsSync(journalFile)) {
      try { renameSync(journalFile, `${archived}.confirmed`); } catch { /* best effort */ }
    }
    try { unlinkSync(activityPathOf(path)); } catch { /* marker is disposable */ }
    const msg = `直播直传旧状态${reason},已原样归档到 ${archived}(含未确认分 P 与暂存文件),本场开新稿件继续录制,需人工核对旧稿件`;
    log(`[直播直传] ${reason}; archived old state to ${archived}, starting a new submission`);
    return alert ? msg : "";
  };
  const state = readLivePumpState(path);
  if (!state) return archive("无法读取或已损坏", true) || undefined;
  if (state.room !== room) return archive(`房间不匹配(${state.room})`, true) || undefined;
  // T-221: journal-aware — a part the queue already confirmed (journal entry, state row still
  // unconfirmed) is settled, so a fully-delivered queue-managed state ages out normally.
  const unconfirmed = livePumpHasUnconfirmed(path);
  if (requiresLivePumpProof(state) && unconfirmed) return undefined;
  // T-220: a queue-managed state is active work, not a finished broadcast. Ageing it out would
  // archive the very state the queue is about to confirm (and lose the association mid-upload).
  // T-221 (sol P1-3): `deliveryDeferred` means the queue has NOT taken these parts yet (a mid-run
  // flip whose enqueue produced zero rows). Archiving it would orphan the only spool copies.
  if ((state.queueManaged || state.deliveryDeferred) && unconfirmed) return undefined;
  let lastActivity = state.updatedAt;
  if (typeof lastActivity !== "number" || !Number.isFinite(lastActivity) || lastActivity <= 0) {
    if (unconfirmed) return archive("缺少最后活动时间且有未确认分 P,无法判断是否同一场", true) || undefined;
    try { lastActivity = statSync(path).mtimeMs; } catch { return archive("无法读取文件时间", true) || undefined; }
  }
  // Data-plane activity outranks the last durable state write (issue #642): an unconfirmed part's
  // spool is appended while recording, and a slow whole-file recovery leaves the marker. Without
  // this, a long active part or a multi-minute recovery looks like a finished broadcast on restart.
  for (const p of state.parts) {
    try { lastActivity = Math.max(lastActivity, statSync(p.spoolPath).mtimeMs); } catch {
      // Missing spools are handled by recovery.
    }
  }
  const progressAt = readActivityMs(path);
  if (progressAt !== undefined && Number.isFinite(progressAt)) lastActivity = Math.max(lastActivity, progressAt);
  if (isSameBroadcastGap(nowMs - lastActivity)) return undefined;
  const reason = `距最后活动 ${Math.round((nowMs - lastActivity) / 60_000)} 分钟,超过同场间隔`;
  return archive(reason, unconfirmed) || undefined;
}

/** Unreadable live or archived states may own the only spool copy, so sweeping must stop. */
export function spoolSweepSafe(spoolDir: string, room: string): boolean {
  const live = livePumpStatePath(spoolDir, room);
  if (existsSync(live) && !readLivePumpState(live)) return false;
  const base = basename(live) + ARCHIVED_SUFFIX;
  try {
    for (const f of readdirSync(spoolDir)) {
      // T-221 sidecars ride on archived names too (`…archived-123.confirmed`); they are not
      // states and a parse failure here would disable the sweep forever (review P2).
      if (!f.startsWith(base) || f.endsWith(".confirmed") || f.endsWith(".activity")) continue;
      if (!readLivePumpState(join(spoolDir, f))) return false;
    }
  } catch { /* spool dir missing: nothing to protect */ }
  return true;
}

/** Keep every spool referenced by archived states, including pending WAL paths. */
export function archivedSpoolPathsToKeep(spoolDir: string, room: string): string[] {
  const base = basename(livePumpStatePath(spoolDir, room)) + ARCHIVED_SUFFIX;
  const out: string[] = [];
  try {
    for (const f of readdirSync(spoolDir)) {
      if (!f.startsWith(base) || f.endsWith(".confirmed") || f.endsWith(".activity")) continue;
      out.push(...spoolPathsToKeep(readLivePumpState(join(spoolDir, f))));
    }
  } catch { /* spool dir missing: nothing archived */ }
  return out;
}

/** Keep the legacy root authoritative until broadcast end. Never migrate live WAL or spools. */
export function resolvePumpDir(
  roomDir: string,
  legacyDir: string,
  room: string,
  nowMs: number = Date.now(),
): string {
  if (roomDir === legacyDir) return legacyDir;
  const legacyPath = livePumpStatePath(legacyDir, room);
  if (!existsSync(legacyPath)) return roomDir;
  const legacy = readLivePumpState(legacyPath);
  // An unreadable root state may hold an unconfirmed WAL: keep it where rolloverStaleState can
  // archive it and raise the "needs a human" alert, exactly as the legacy layout did.
  if (!legacy) return legacyDir;
  // Only an ACTIVE broadcast stays at the root: an unconfirmed part (its WAL is still needed) or
  // a last activity inside the same-broadcast window. Anything older is a finished broadcast;
  // keeping it at the root forever would mean upgraded rooms never reach the room directory.
  if (legacy.pending || legacy.parts.some((p) => !p?.confirmed)) return legacyDir;
  // A missing/corrupt timestamp cannot prove the broadcast ended; the legacy rollover falls back
  // to file mtime, so stay at the root and let that same rule decide instead of splitting the
  // session into a second archive.
  if (typeof legacy.updatedAt !== "number" || !Number.isFinite(legacy.updatedAt)) return legacyDir;
  return isSameBroadcastGap(nowMs - legacy.updatedAt) ? legacyDir : roomDir;
}
