/**
 * is-done / recording-status judged from recorder state files (plans/044 Task 3).
 *
 * The regression for issue #456: a live-pump child whose ffmpeg already exited but which is still uploading
 * its last part (phase=finalizing) must keep is-done=false; the old /proc scan saw no downloader and said done.
 */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRoomDone, localRoomProbes, recordingRoomsOf, type RoomProbeDeps } from "../../packages/cli/src/node-commands.js";
import { LocalTransport } from "../../packages/orchestrator/src/transport-local.js";
import { recorderStateDir, recorderStatePath, type ProcProbe, type RecorderStateFile } from "@drec/core";

const NOW = 1_700_000_000_000;
const TICKS = 555;
const BOOT = "boot-1";
const ALIVE_PID = 4242;

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});
const makeRoot = (): string => {
  const r = mkdtempSync(join(tmpdir(), "drec-node-state-"));
  roots.push(r);
  return r;
};

function put(root: string, over: Partial<RecorderStateFile> & { taskId: number }): void {
  const s: RecorderStateFile = {
    schemaVersion: 1, platform: "douyin", roomSlug: "555", mode: "live",
    owner: { pid: ALIVE_PID, startTicks: TICKS, bootId: BOOT },
    phase: "recording", session: null, heartbeatAt: NOW, exit: null, updatedAt: NOW,
    ...over,
  };
  mkdirSync(recorderStateDir(root), { recursive: true });
  writeFileSync(recorderStatePath(root, s.taskId), JSON.stringify(s));
}

const exited = { code: 0, signal: null, at: NOW, draining: false };
// Only pid 4242 "exists" with matching start ticks; every other pid is gone.
const proc: ProcProbe = { startTicks: (pid) => (pid === ALIVE_PID ? TICKS : null), bootId: () => BOOT };
const deps = (scan: RoomProbeDeps["scan"] = () => []): RoomProbeDeps & { logs: string[] } => {
  const logs: string[] = [];
  return { scan, proc, now: () => NOW, log: (m) => logs.push(m), logs };
};

describe("isRoomDone", () => {
  it("recording (active) → not done", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "recording" });
    expect(isRoomDone(root, "555", deps())).toBe(false);
  });

  it("issue #456: finalizing (ffmpeg gone, last part still uploading) → not done even though the scan sees no downloader", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "finalizing" });
    expect(isRoomDone(root, "555", deps(() => []))).toBe(false);
  });

  it("polling (waiting for a broadcast) → done", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "polling" });
    expect(isRoomDone(root, "555", deps())).toBe(true);
  });

  it("exited → done", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "exited", exit: exited });
    expect(isRoomDone(root, "555", deps())).toBe(true);
  });

  it("dead (owner gone, phase stuck at recording / finalizing) → done", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "recording", owner: { pid: 1, startTicks: TICKS, bootId: BOOT } });
    put(root, { taskId: 2, roomSlug: "777", phase: "finalizing", owner: { pid: 1, startTicks: TICKS, bootId: BOOT } });
    expect(isRoomDone(root, "555", deps())).toBe(true);
    expect(isRoomDone(root, "777", deps())).toBe(true);
  });

  it("a dead file never silences the /proc scan (dead file + scan hit → NOT done)", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "recording", owner: { pid: 1, startTicks: TICKS, bootId: BOOT } });
    expect(isRoomDone(root, "555", deps(() => [{ platform: "douyin", roomSlug: "555" }]))).toBe(false);
  });

  it("an exited file never silences the /proc scan (exited file + scan hit → NOT done)", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "exited", exit: exited });
    expect(isRoomDone(root, "555", deps(() => [{ platform: "douyin", roomSlug: "555" }]))).toBe(false);
  });

  it("exited files older than 7 days are ignored (not deleted): the room counts as having no file", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "exited", exit: exited, updatedAt: NOW - 8 * 24 * 3600_000 });
    expect(isRoomDone(root, "555", deps())).toBe(true);
    expect(existsSync(recorderStatePath(root, 1))).toBe(true);
  });

  it("no state file for the room → falls back to the process scan", () => {
    const root = makeRoot();
    put(root, { taskId: 1, roomSlug: "other", phase: "polling" });
    const scanHit = deps(() => [{ platform: "douyin", roomSlug: "555" }]);
    expect(isRoomDone(root, "555", scanHit)).toBe(false);
    expect(isRoomDone(root, "555", deps(() => []))).toBe(true);
    // A room only the scan knows about is unaffected by other rooms' state files.
    expect(isRoomDone(makeRoot(), "555", scanHit)).toBe(false);
  });

  it("any active file of the room wins over a stale one", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "exited", exit: exited });
    put(root, { taskId: 2, phase: "finalizing" });
    expect(isRoomDone(root, "555", deps())).toBe(false);
  });

  it("an unparsable file is skipped with a log line (room then has no file → scan fallback)", () => {
    const root = makeRoot();
    mkdirSync(recorderStateDir(root), { recursive: true });
    writeFileSync(recorderStatePath(root, 9), "{broken");
    const d = deps(() => [{ platform: "douyin", roomSlug: "555" }]);
    expect(isRoomDone(root, "555", d)).toBe(false);
    expect(d.logs.join("\n")).toContain("rec-9.json");
  });
});

describe("recordingRoomsOf", () => {
  it("only active recording rooms; finalizing / polling / exited / dead are not recording", () => {
    const root = makeRoot();
    put(root, { taskId: 1, roomSlug: "rec", phase: "recording" });
    put(root, { taskId: 2, roomSlug: "fin", phase: "finalizing" });
    put(root, { taskId: 3, roomSlug: "poll", phase: "polling" });
    put(root, { taskId: 4, roomSlug: "gone", phase: "exited", exit: exited });
    put(root, { taskId: 5, roomSlug: "dead", phase: "recording", owner: { pid: 1, startTicks: TICKS, bootId: BOOT } });
    expect(recordingRoomsOf(root, deps())).toEqual([{ platform: "douyin", roomSlug: "rec" }]);
  });

  it("mixed: state-file rooms ∪ scan rooms that have no state file; a scan hit for a stateful room is ignored", () => {
    const root = makeRoot();
    put(root, { taskId: 1, roomSlug: "new", phase: "recording" });
    put(root, { taskId: 2, roomSlug: "idle", phase: "polling" });
    const scan = () => [
      { platform: "douyin", roomSlug: "old" }, // older bundle: no state file
      { platform: "douyin", roomSlug: "idle" }, // has a state file saying polling → trust the file
      { platform: "douyin", roomSlug: "new" }, // already reported via its state file
    ];
    expect(recordingRoomsOf(root, deps(scan))).toEqual([
      { platform: "douyin", roomSlug: "new" },
      { platform: "douyin", roomSlug: "old" },
    ]);
  });

  it("no state files → exactly the scan result (previous behaviour)", () => {
    const scan = () => [{ platform: "bilibili", roomSlug: "9" }];
    expect(recordingRoomsOf(makeRoot(), deps(scan))).toEqual(scan());
  });

  it("same room name on two platforms stays separate", () => {
    const root = makeRoot();
    put(root, { taskId: 1, platform: "douyin", roomSlug: "5", phase: "recording" });
    const out = recordingRoomsOf(root, deps(() => [{ platform: "bilibili", roomSlug: "5" }]));
    expect(out).toEqual([{ platform: "douyin", roomSlug: "5" }, { platform: "bilibili", roomSlug: "5" }]);
  });

  it("a scan hit is listed when the room's only file is dead or exited (they must not suppress it)", () => {
    const scan = () => [{ platform: "douyin", roomSlug: "555" }];
    const dead = makeRoot();
    put(dead, { taskId: 1, phase: "recording", owner: { pid: 1, startTicks: TICKS, bootId: BOOT } });
    expect(recordingRoomsOf(dead, deps(scan))).toEqual(scan());
    const gone = makeRoot();
    put(gone, { taskId: 1, phase: "exited", exit: exited });
    expect(recordingRoomsOf(gone, deps(scan))).toEqual(scan());
  });

  it("finalizing is intentionally not listed (not pulling a stream); is-done still holds the room", () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "finalizing" });
    expect(recordingRoomsOf(root, deps())).toEqual([]);
    expect(isRoomDone(root, "555", deps())).toBe(false);
  });
});

describe("master local worker uses the same judgement (issue #456)", () => {
  const mkLocal = (root: string, d: RoomProbeDeps) => new LocalTransport({
    id: "local", recordingsDir: join(root, "recordings"), taskRooms: {},
    ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    ...localRoomProbes(() => root, d),
  });

  it("isDone stays false while a finalizing state file is active, true once it is exited", async () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "finalizing" });
    const t = mkLocal(root, deps());
    expect(await t.isDone("555")).toBe(false);
    put(root, { taskId: 1, phase: "exited", exit: exited });
    expect(await t.isDone("555")).toBe(true);
  });

  it("activeRecordingRooms comes from the same judge", async () => {
    const root = makeRoot();
    put(root, { taskId: 1, phase: "recording" });
    expect(await mkLocal(root, deps()).activeRecordingRooms()).toEqual([{ platform: "douyin", roomSlug: "555" }]);
  });
});
