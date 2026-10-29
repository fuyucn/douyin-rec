/**
 * Output path resolver (issue #333): the single place that decides where a room's recordings, a
 * session's stage directory and a session's job log live. Nothing outside core may hand-build these
 * paths or keep its own copy of the name-sanitize rule (test/arch/output-paths-guard.test.ts).
 *
 * Two layouts exist:
 * - "legacy" (default, what runs today): `stage/<sanitized streamKey>/`, `recordings/<anchor>/`,
 *   `stage/<sanitized streamKey>/job.log`.
 * - "room": `<name>_<platform>_<room>/` room directories (stage adds a `<date>[_HHMM]` level below it)
 *   and job logs under `logs/hub/<platform>_<room>/`.
 * Callers opt in per call; until a later issue flips the switch every caller gets legacy paths.
 *
 * Rules that hold for both layouts:
 * - Lookup is by the `_<platform>_<room>` suffix only. Node-side commands know the streamKey but not
 *   the anchor name, so the name is used solely when a NEW room directory has to be named, with the
 *   room slug as fallback. An unknown name never fails a lookup.
 * - Legacy is sticky: if a session's legacy directory already exists it keeps being used until the
 *   session ends, so an upgrade mid-job never moves a running session.
 * - Several directories with the same suffix: the oldest one wins and a warning is reported.
 * - The resolver is pure with respect to the filesystem: it reads, it never creates or deletes.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { sanitizeStreamKey } from "./hub-ledger-contract.js";
import { parseStreamKey, type ParsedStreamKey } from "./notify-context.js";

export type PathLayout = "legacy" | "room";

/** Max UTF-8 bytes of the anchor-name part of a room directory name (filesystem name limit is 255). */
export const ROOM_NAME_MAX_BYTES = 120;

/** File name of the per-session job log in the legacy layout. */
export const JOB_LOG_FILE = "job.log";

export type PathWarn = (msg: string) => void;

/**
 * Directory/file name cleanup: drop illegal characters (/ \ : * ? " < > |) and control characters,
 * collapse whitespace, trim (no truncation). This is the rule recorders have always used for the
 * recording sub-directory; it is kept byte-identical so existing directories keep resolving.
 */
export function sanitizePathSegment(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Legacy directory name source: the first candidate that is still non-empty after sanitising. */
export type NameCandidates = string | readonly (string | null | undefined)[];

function firstSegment(names: NameCandidates): string {
  for (const n of typeof names === "string" ? [names] : names) {
    const s = n ? sanitizePathSegment(n) : "";
    if (s) return s;
  }
  return "";
}

/** Anchor name for a NEW room directory: NFC-normalised, sanitised, clamped to ROOM_NAME_MAX_BYTES. */
export function sanitizeRoomName(name: string): string {
  const clean = sanitizePathSegment(name.normalize("NFC"));
  let out = "";
  let bytes = 0;
  for (const ch of clean) {
    const n = Buffer.byteLength(ch, "utf-8");
    if (bytes + n > ROOM_NAME_MAX_BYTES) break;
    out += ch;
    bytes += n;
  }
  return out.trim();
}

/** Session level of a room-layout stage path: `<date>` or `<date>_<HHMM>` (the streamKey tail). */
function sessionPart(k: ParsedStreamKey): string {
  return k.time ? `${k.date}_${k.time.replace(":", "")}` : k.date;
}

/** The suffix every room directory ends with: `_<platform>_<room>`. */
export function roomDirSuffix(platform: string, roomSlug: string): string {
  return `_${sanitizePathSegment(platform)}_${sanitizePathSegment(roomSlug)}`;
}

/** Name for a new room directory; the room slug stands in when no anchor name is known. */
export function roomDirName(platform: string, roomSlug: string, anchorName?: string | null): string {
  const slug = sanitizePathSegment(roomSlug);
  const name = (anchorName ? sanitizeRoomName(anchorName) : "") || slug;
  return `${name}${roomDirSuffix(platform, roomSlug)}`;
}

/**
 * Existing room directory under `root` whose name ends with the room suffix, or null.
 * Several matches: the earliest created wins (name order breaks ties) and `warn` is told.
 */
export function findRoomDir(root: string, platform: string, roomSlug: string, warn?: PathWarn): string | null {
  const suffix = roomDirSuffix(platform, roomSlug);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return null;
  }
  const hits: { name: string; at: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(suffix) || name.length === suffix.length) continue;
    try {
      const st = statSync(join(root, name));
      if (!st.isDirectory()) continue;
      // birthtime only: mtime moves with directory contents, so without a birth time fall back to name order.
      hits.push({ name, at: st.birthtimeMs > 0 ? st.birthtimeMs : 0 });
    } catch { /* vanished between readdir and stat */ }
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => a.at - b.at || (a.name < b.name ? -1 : 1));
  if (hits.length > 1) warn?.(`multiple room directories match ${suffix} under ${root}: ${hits.map((h) => h.name).join(", ")}; using ${hits[0].name}`);
  return join(root, hits[0].name);
}

export interface RoomRef {
  platform: string;
  roomSlug: string;
  /** Only used when a new room directory has to be named. */
  anchorName?: string | null;
}

export interface ResolveOpts {
  layout?: PathLayout;
  warn?: PathWarn;
}

/** Legacy stage directory of a session: `<stageRoot>/<sanitized streamKey>`. */
export function legacyStageSessionDir(stageRoot: string, streamKey: string): string {
  return join(stageRoot, sanitizeStreamKey(streamKey));
}

/**
 * Stage directory of one session. A session directory that already exists is reused whatever the
 * configured layout is (legacy first, then the room layout): a running session never moves, and a layout
 * switch cannot orphan node results or half-written output. Only when neither exists does the layout decide:
 * legacy (default, and for a malformed streamKey) gives `<stage>/<sanitized key>`, "room" gives
 * `<room dir>/<date[_HHMM]>`. `anchorName` only matters when no room directory exists yet.
 */
export function stageSessionDir(
  stageRoot: string,
  streamKey: string,
  opts: ResolveOpts & { anchorName?: string | null } = {},
): string {
  const legacy = legacyStageSessionDir(stageRoot, streamKey);
  const parsed = parseStreamKey(streamKey);
  if (!parsed) return legacy;
  if (existsSync(legacy)) return legacy;
  const existingRoom = findRoomDir(stageRoot, parsed.platform, parsed.roomSlug, opts.warn);
  if (existingRoom) {
    const inRoom = join(existingRoom, sanitizeStreamKey(sessionPart(parsed)));
    if (existsSync(inRoom) || opts.layout === "room") return inRoom;
  }
  if (opts.layout !== "room") return legacy;
  const roomDir = join(stageRoot, roomDirName(parsed.platform, parsed.roomSlug, opts.anchorName));
  return join(roomDir, sanitizeStreamKey(sessionPart(parsed)));
}

/**
 * Every stage path that may hold this session's files, old layout first. Used where protection must
 * cover both layouts (maintenance active-path guard). The room path is listed only when a room
 * directory already exists, so with no new layout on disk this is just the legacy path.
 */
export function stageSessionDirCandidates(stageRoot: string, streamKey: string, warn?: PathWarn): string[] {
  const out = [legacyStageSessionDir(stageRoot, streamKey)];
  const parsed = parseStreamKey(streamKey);
  if (parsed) {
    const roomDir = findRoomDir(stageRoot, parsed.platform, parsed.roomSlug, warn);
    if (roomDir) out.push(join(roomDir, sanitizeStreamKey(sessionPart(parsed))));
  }
  return out;
}

/**
 * Recording directory of a room under the output root.
 * Legacy: `<outRoot>/<sanitized name>`; null when the name is empty (not resolvable yet, callers must
 * then protect/scan nothing rather than guess). Room layout (new sessions only): the suffix-matched room
 * directory (an anchor rename never changes it), else a new `<name>_<platform>_<room>` path. An existing
 * legacy directory is deliberately NOT reused here: legacy directories are read-only history, new
 * sessions go to the room directory. A recorder that is already running keeps the directory it resolved
 * at its first spawn, so a session never changes directory underneath itself.
 */
export function recordingRoomDir(
  outRoot: string,
  legacyName: NameCandidates,
  room?: RoomRef,
  opts: ResolveOpts = {},
): string | null {
  const legacySub = firstSegment(legacyName);
  const legacy = legacySub ? join(outRoot, legacySub) : null;
  if (opts.layout !== "room" || !room) return legacy;
  return findRoomDir(outRoot, room.platform, room.roomSlug, opts.warn)
    ?? join(outRoot, roomDirName(room.platform, room.roomSlug, room.anchorName || legacySub));
}

/** Every recording directory that may hold this room's files (legacy name dir + suffix-matched room dir). */
export function recordingRoomDirCandidates(
  outRoot: string,
  legacyName: NameCandidates,
  room?: Pick<RoomRef, "platform" | "roomSlug">,
  warn?: PathWarn,
): string[] {
  const out: string[] = [];
  const legacySub = firstSegment(legacyName);
  if (legacySub) out.push(join(outRoot, legacySub));
  if (room) {
    const dir = findRoomDir(outRoot, room.platform, room.roomSlug, warn);
    if (dir && !out.includes(dir)) out.push(dir);
  }
  return out;
}

/** Job-log file name inside the log room directory: the sanitised streamKey. */
export function jobLogFileName(streamKey: string): string {
  return `${sanitizeStreamKey(streamKey)}.log`;
}

/**
 * Job log of one session. `layout` here is the LOG layout only; it is independent of the stage layout
 * (job logs move out of stage before stage directories are renamed). Legacy: `<stage session dir>/job.log`. Room layout: `<logsRoot>/hub/<platform>_<room>/<sanitized key>.log`,
 * kept outside stage so it survives stage cleanup. A session whose legacy log already exists keeps
 * writing there (sticky). `logsRoot` is required for the room layout; without it, or with a malformed key,
 * the legacy path is returned.
 */
export function resolveJobLogPath(
  stageRoot: string,
  streamKey: string,
  opts: ResolveOpts & { logsRoot?: string } = {},
): string {
  const legacy = join(legacyStageSessionDir(stageRoot, streamKey), JOB_LOG_FILE);
  if (opts.layout !== "room" || !opts.logsRoot) return legacy;
  const parsed = parseStreamKey(streamKey);
  if (!parsed || existsSync(legacy)) return legacy;
  return join(opts.logsRoot, "hub", `${sanitizePathSegment(parsed.platform)}_${sanitizePathSegment(parsed.roomSlug)}`, jobLogFileName(streamKey));
}

/**
 * Every place a session's job log may live, write target first: the sticky/new path from
 * resolveJobLogPath, then the other layout's path. Readers take the first that exists, deletion
 * removes all of them, so old sessions keep their logs after the move (issue #334).
 */
export function jobLogPathCandidates(stageRoot: string, streamKey: string, logsRoot: string): string[] {
  const legacy = join(legacyStageSessionDir(stageRoot, streamKey), JOB_LOG_FILE);
  const parsed = parseStreamKey(streamKey);
  if (!parsed) return [legacy];
  const fresh = join(logsRoot, "hub", `${sanitizePathSegment(parsed.platform)}_${sanitizePathSegment(parsed.roomSlug)}`, jobLogFileName(streamKey));
  // Sticky legacy: an existing legacy log is also the write target, so it goes first.
  return existsSync(legacy) ? [legacy, fresh] : [fresh, legacy];
}

/** Layout switch value: anything but the exact string "room" is the legacy layout (never throws). */
export function parseOutputLayout(raw: unknown): PathLayout {
  return raw === "room" ? "room" : "legacy";
}

/**
 * Room id parsed from a room directory name `<name>_<platform>_<room>` (the reverse of roomDirName),
 * used for old recordings that have no session sidecar. Matches the known platform ids and takes the
 * rightmost `_<platform>_` so an anchor name containing it cannot hijack the split. null when the name
 * does not carry the suffix (a legacy anchor-name directory).
 */
export function parseRoomDirName(dirName: string, platformIds: readonly string[]): { platform: string; roomSlug: string } | null {
  let best: { platform: string; roomSlug: string; at: number } | null = null;
  for (const id of platformIds) {
    const marker = `_${id}_`;
    const at = dirName.lastIndexOf(marker);
    if (at <= 0) continue;
    const roomSlug = dirName.slice(at + marker.length);
    if (!roomSlug) continue;
    if (!best || at > best.at) best = { platform: id, roomSlug, at };
  }
  return best ? { platform: best.platform, roomSlug: best.roomSlug } : null;
}

/**
 * Anchor name carried by a stamped session base (`<anchor>_<YYYY-MM-DD>_<HH-MM-SS>[segment suffix]`),
 * or null. Lets the master name a NEW stage room directory without being told the anchor name.
 */
export function anchorNameOfSessionBase(sessionBase: string): string | null {
  const m = /^(.+)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}(?:[-_].*)?$/.exec(sessionBase);
  return m?.[1] ?? null;
}
