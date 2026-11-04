/**
 * app/live-gate.ts — pure helpers behind the serve-side live gate (plans/042 Task 6).
 *
 * The gate keeps a task that is not live from holding a `record` child process. Everything the gate
 * must agree with the child on lives here so there is one implementation: the zero-disk pump
 * directory resolution (also used by `record --stream-upload`), the unconfirmed-parts check and the
 * liveness probe with the same Douyin API mode the child gets.
 */
import { recordingRoomDir, platformForRoom, type Platform, type PathLayout } from "@drec/core";
import { livePumpHasUnconfirmed, livePumpStatePath, resolvePumpDir } from "@drec/zero-upload";
import type { Task } from "./store.js";
import { readOutputLayout, resolveOutputDir } from "./paths.js";

/** Env var the Douyin platform reads for its API mode; the spawner injects the same one into children. */
const DOUYIN_API_MODE_ENV = "DOUYIN_REC_API_MODE";

/**
 * Room key used by the zero-disk pump. The pump passes it straight to Platform.getStream; platforms
 * that need a numeric room id (Douyin) reject a full live URL, so normalize at this boundary.
 */
export function zeroDiskRoom(platform: Platform, room: string): string {
  return platform.extractRoomSlug(platform.roomToUrl(room));
}

/**
 * Anchor name the child receives as `--name` (empty = none). Single source for `buildRecordArgs`
 * and the gate's pump-directory resolution: an explicit task name wins; a zero-disk task falls back
 * to the cached anchor name (it has no recording filename to inherit one from). Deliberately scoped
 * to streamUpload: the normal recorder resolves the owner itself from each stream, and a stale cached
 * name would rename its output subfolder.
 */
export function recordNameArg(task: Pick<Task, "name" | "streamUpload" | "anchorName">): string {
  if (task.name) return task.name;
  if (task.streamUpload && task.anchorName) return task.anchorName;
  return "";
}

export interface ZeroDiskPumpDirs {
  pumpRoom: string;
  /** Room directory (`<name>_<platform>_<room>`), or `outDir` when no anchor/room can be resolved. */
  roomDir: string;
  /** Directory the layout switch selects for NEW state (room dir under the room layout, else outDir). */
  pumpSpoolDir: string;
  /** Directory the pump actually reads/writes its state in (sticky: a legacy active state keeps the root). */
  pumpFilesDir: string;
}

/**
 * Where a zero-disk run keeps its state. Used by `record --stream-upload` AND the live gate, so the
 * gate looks at exactly the file the child would recover from.
 */
export function resolveZeroDiskPumpDirs(a: {
  platform: Platform;
  /** The task's room as entered (URL or id); normalized here the same way the pump does. */
  rawRoom: string;
  outDir: string;
  anchorName: string;
  layout: PathLayout;
}): ZeroDiskPumpDirs {
  const roomSlug = a.platform.extractRoomSlug(a.platform.roomToUrl(a.rawRoom));
  const pumpRoom = zeroDiskRoom(a.platform, a.rawRoom);
  // Always resolve the room directory, even in legacy layout: the rollback check must inspect the
  // room-dir state, not the root one.
  const roomDir = recordingRoomDir(a.outDir, [a.anchorName, roomSlug], {
    platform: a.platform.id, roomSlug, anchorName: a.anchorName || roomSlug,
  }, { layout: "room" }) ?? a.outDir;
  const pumpSpoolDir = a.layout === "room" ? roomDir : a.outDir;
  // Sticky directory: a broadcast that already has a legacy state keeps using the root.
  const pumpFilesDir = a.layout === "room" ? resolvePumpDir(pumpSpoolDir, a.outDir, pumpRoom) : a.outDir;
  return { pumpRoom, roomDir, pumpSpoolDir, pumpFilesDir };
}

/**
 * Whether a zero-disk task has unconfirmed parts from an earlier run (a state file with an unconfirmed
 * or pending part, or one that cannot be read). Such a task must spawn immediately so the child can
 * finish the delivery. Missing state = nothing to recover. Any error while resolving the paths is
 * treated as "has unconfirmed": a delayed recovery costs more than one idle process.
 * Also checks the room directory under the legacy layout (the child alerts about a stranded WAL there).
 */
export function zeroDiskHasUnconfirmedParts(task: Task, layout: PathLayout = readOutputLayout()): boolean {
  try {
    const d = resolveZeroDiskPumpDirs({
      platform: platformForRoom(task.room),
      rawRoom: task.room,
      outDir: resolveOutputDir(task.outDir),
      anchorName: recordNameArg(task).trim(),
      layout,
    });
    const dirs = new Set([d.pumpFilesDir, d.roomDir]);
    return [...dirs].some((dir) => livePumpHasUnconfirmed(livePumpStatePath(dir, d.pumpRoom)));
  } catch {
    return true;
  }
}

/**
 * Authoritative liveness probe for the gate. Douyin's `getLiving` reads its API mode from
 * `DOUYIN_REC_API_MODE` synchronously when called, so the setting is applied to the env only for the
 * duration of the synchronous call and restored before any await. No other code path in the serve
 * process ever observes the value (a global `process.env` change would also steer unrelated Douyin
 * lookups such as anchor-name fetches), yet the probe uses the same endpoint as the child it gates.
 */
export function probeRoomLiving(task: Pick<Task, "room">, apiMode: string | undefined): Promise<boolean> {
  const platform = platformForRoom(task.room);
  const mode = apiMode?.trim();
  const channel = zeroDiskRoom(platform, task.room);
  if (!mode) return platform.getLiving(channel);
  const prev = process.env[DOUYIN_API_MODE_ENV];
  process.env[DOUYIN_API_MODE_ENV] = mode;
  try {
    return platform.getLiving(channel);
  } finally {
    if (prev === undefined) delete process.env[DOUYIN_API_MODE_ENV];
    else process.env[DOUYIN_API_MODE_ENV] = prev;
  }
}
