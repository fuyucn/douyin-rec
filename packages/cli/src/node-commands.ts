/**
 * node-commands.ts — the single implementation of the node-side control-plane commands (plans/042 Task 1).
 *
 * The master asks a worker questions ("which rooms are recording", "free disk", "apply these tasks", ...).
 * Today every question is an ssh call that spawns `node dist/douyin-rec.mjs _<cmd> <dataRoot> ...`; the
 * fleet long connection (Task 2/3) answers the same questions inside the resident `task serve`. Both paths
 * must run this one registry so they can never drift apart.
 *
 * Contract: each command returns exactly the bytes the hidden CLI command printed before (`stdout`) and the
 * exit code it set. `SshTransport` parses that stdout unchanged. A command may still throw for unexpected
 * failures; the CLI path lets that propagate to the top-level handler as before.
 *
 * Keep this module's static imports light: `cli.ts` imports it eagerly, and every ssh probe pays for the
 * bundle's top-level work. Heavy packages are imported lazily inside each command.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  EXITED_STATE_IGNORE_AFTER_MS, freeGBOf, linuxProcProbe, listProcessors, platformForRoom, readRecorderStates, redactLogLines,
  roomActivities, type ProcActiveDTO, type ProcProbe, type RecorderStateFile,
} from "@drec/core";
import { applyNodeDataRoot } from "./node-pipeline-commands.js";

export interface NodeCommandResult {
  stdout: string;
  exitCode: number;
}

/** `args` are the positional arguments after `<dataRoot>`, plus `--flag value` pairs where a command has options. */
export type NodeCommand = (dataRoot: string, args: string[]) => Promise<NodeCommandResult>;

const json = (value: unknown, exitCode = 0): NodeCommandResult => ({ stdout: JSON.stringify(value) + "\n", exitCode });
const errorJson = (e: unknown): NodeCommandResult => json({ error: String((e as Error)?.message ?? e) }, 1);

/** A command whose failures are reported as `{"error":…}` with exit 1 (the contract of several commands). */
const guarded = (run: NodeCommand): NodeCommand => async (dataRoot, args) => {
  try {
    return await run(dataRoot, args);
  } catch (e) {
    return errorJson(e);
  }
};

/**
 * Open the node's task db for one command and always close it: inside the resident serve (fleet agent)
 * a leaked handle would pile up for the life of the process.
 */
async function withTaskStore<T>(dataRoot: string, fn: (store: import("@drec/app").TaskStore) => T | Promise<T>): Promise<T> {
  const { TaskStore } = await import("@drec/app");
  const store = new TaskStore(join(dataRoot, "db", "douyin-rec.db"));
  try {
    return await fn(store);
  } finally {
    store.close();
  }
}

/** `platform:roomSlug` of a task, or null when its platform cannot be resolved. */
function taskRoomKey(room: string): string | null {
  try {
    const p = platformForRoom(room);
    return `${p.id}:${p.extractRoomSlug(room)}`;
  } catch {
    return null;
  }
}

/**
 * Scan `/proc` for `record` child processes that currently have a media download grandchild (ffmpeg/mesio)
 * and return their room identities.
 *
 * Single source of truth for `is-done` (one room) and `recording-status` (all rooms). Criterion: the
 * command line carries `--room <URL/room id>` and `/proc/<pid>/task/<pid>/children` is non-empty (= a
 * downloader is writing). Waiting for a broadcast, with no downloader child, is not recording.
 * Non-Linux hosts (local macOS development) have no `/proc` → empty.
 */
export function scanRecordingRooms(): { platform: string; roomSlug: string }[] {
  const rooms = new Map<string, { platform: string; roomSlug: string }>();
  try {
    for (const entry of readdirSync("/proc", { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      let cmdline: string[];
      try {
        cmdline = readFileSync(`/proc/${entry.name}/cmdline`, "utf8").split("\0").filter(Boolean);
      } catch {
        continue; // process just exited / no permission
      }
      const roomIdx = cmdline.indexOf("--room");
      if (roomIdx < 0 || roomIdx + 1 >= cmdline.length) continue;
      try {
        const platform = platformForRoom(cmdline[roomIdx + 1]);
        const roomSlug = platform.extractRoomSlug(cmdline[roomIdx + 1]);
        const children = readFileSync(`/proc/${entry.name}/task/${entry.name}/children`, "utf8").trim();
        if (children) rooms.set(`${platform.id}:${roomSlug}`, { platform: platform.id, roomSlug });
      } catch {
        /* process just exited, or the room cannot be parsed */
      }
    }
  } catch {
    /* no /proc (non-Linux) → no processes */
  }
  return [...rooms.values()];
}

/** Everything the room judgement touches outside the state files; injected by tests. */
export interface RoomProbeDeps {
  /** /proc process scan: fallback for rooms without a state file (older bundles, standalone runs). */
  scan: () => { platform: string; roomSlug: string }[];
  proc: ProcProbe;
  now: () => number;
  log: (msg: string) => void;
}

const defaultRoomProbe = (): RoomProbeDeps => ({
  scan: scanRecordingRooms,
  proc: linuxProcProbe,
  now: Date.now,
  // stderr: stdout of these commands is a parsed contract.
  log: (m) => console.error(m),
});

/**
 * State files for the judgement. Exited files older than a week are ignored (not deleted): a task that was
 * removed long ago must not keep its room "known" forever.
 */
function readLiveStates(dataRoot: string, deps: RoomProbeDeps): RecorderStateFile[] {
  const cutoff = deps.now() - EXITED_STATE_IGNORE_AFTER_MS;
  return readRecorderStates(dataRoot, deps.log).filter((st) => !(st.phase === "exited" && st.updatedAt < cutoff));
}

/**
 * `is-done` judgement (plans/044): NOT done when a verified-active child of the room is recording or still
 * finalizing, OR the /proc scan sees a downloader for the room. A dead or exited state file never silences the
 * scan (a standalone / older-bundle `record` for the same room has no state file of its own).
 */
export function isRoomDone(dataRoot: string, roomSlug: string, deps: RoomProbeDeps = defaultRoomProbe()): boolean {
  const states = readLiveStates(dataRoot, deps).filter((st) => st.roomSlug === roomSlug);
  for (const room of roomActivities(states, deps.now(), deps.proc).values()) {
    if (room.recording || room.finalizing) return false;
  }
  return !deps.scan().some((room) => room.roomSlug === roomSlug);
}

/**
 * `recording-status` rooms = "a stream is being pulled right now": verified-active children in phase
 * `recording`, plus /proc-scan rooms that have no verified-active state file. A room that is only `finalizing`
 * is deliberately NOT listed here (it is not pulling); `isRoomDone` is what keeps it from being settled early.
 */
export function recordingRoomsOf(dataRoot: string, deps: RoomProbeDeps = defaultRoomProbe()): { platform: string; roomSlug: string }[] {
  const rooms = roomActivities(readLiveStates(dataRoot, deps), deps.now(), deps.proc);
  const out = [...rooms.values()].filter((r) => r.recording).map((r) => ({ platform: r.platform, roomSlug: r.roomSlug }));
  for (const r of deps.scan()) {
    if (!rooms.get(`${r.platform}:${r.roomSlug}`)?.active) out.push(r);
  }
  return out;
}

/**
 * The master's own `local` worker must judge through the same functions as ssh / fleet nodes: the serve-side
 * `[状态]`-line flag flips to false on `录制停滞` while the tail part is still uploading.
 */
export function localRoomProbes(dataRoot: () => string, deps?: RoomProbeDeps): {
  isRoomRecording: (roomSlug: string) => boolean;
  activeRecordingRooms: () => { platform: string; roomSlug: string }[];
} {
  return {
    isRoomRecording: (roomSlug) => !isRoomDone(dataRoot(), roomSlug, deps),
    activeRecordingRooms: () => recordingRoomsOf(dataRoot(), deps),
  };
}

/** Read `--name value` options out of `args`; unknown flags are ignored. */
function readOptions(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--") && i + 1 < args.length) {
      out[a.slice(2)] = args[i + 1];
      i++;
    }
  }
  return out;
}

/** Build `notify-outbox` args from commander options, in a stable order (used by the CLI and the fleet master). */
export function notifyOutboxArgs(o: { after?: string; limit?: string; ack?: string }): string[] {
  const args: string[] = [];
  if (o.after !== undefined) args.push("--after", o.after);
  if (o.limit !== undefined) args.push("--limit", o.limit);
  if (o.ack !== undefined) args.push("--ack", o.ack);
  return args;
}

/** Process-lifetime ffprobe cache for `inventory` (see there). */
let probeSegment: ((file: string) => Promise<{ durationMs: number; endMs: number }>) | undefined;

/** Local serve API used by commands that need state only the serve process holds. */
const serveApiBase = (): string => process.env.DREC_SERVE_API ?? "http://localhost:7860"; // loopback; Node 24 fetch tries both IPv6 and IPv4 loopback

export const NODE_COMMANDS: Readonly<Record<string, NodeCommand>> = Object.freeze({
  // "true" once nothing is recording or finalizing for this room (master settle polls this).
  // Only this room counts: a global ffmpeg count made other rooms' recordings stall this room's settle.
  "is-done": async (dataRoot, [roomSlug]) => ({
    stdout: (isRoomDone(dataRoot, roomSlug) ? "true" : "false") + "\n",
    exitCode: 0,
  }),

  // Recording rooms + live-upload progress (F1). Progress is best-effort: failures leave it empty.
  "recording-status": async (dataRoot) => {
    const rooms = recordingRoomsOf(dataRoot);
    let rolling: unknown[] = [];
    try {
      const { scanRollingSessions } = await import("@drec/orchestrator");
      rolling = scanRollingSessions(join(dataRoot, "recordings"), rooms);
    } catch { /* progress is auxiliary */ }
    return json({ rooms, rolling });
  },

  // Scan <dataRoot>/recordings and return the inventory the master clusters into broadcasts.
  inventory: async (dataRoot) => {
    const { ffprobeVideo } = await import("@drec/post-process");
    const { scanInventory, segmentSecByAnchorOf, createProbeCache } = await import("@drec/orchestrator");

    // anchorName/name → roomSlug from this node's own task db
    const tasks = await withTaskStore(dataRoot, (s) => s.listTasks());
    const taskRooms: Record<string, string> = {};
    for (const task of tasks) {
      try {
        const slug = platformForRoom(task.room).extractRoomSlug(task.room);
        if (task.name) taskRooms[task.name] = slug;
        if (task.anchorName) taskRooms[task.anchorName] = slug;
      } catch { /* skip tasks whose platform can't be resolved */ }
    }
    const segmentSecByAnchor = segmentSecByAnchorOf(tasks);

    // durationMs via ffprobe + mtime → startMs/endMs. Results are cached per file version for the
    // lifetime of this process (the resident serve under the fleet agent); a CLI call starts empty.
    // Probe failures are not cached (they fall back to 0 per call, as before) so a transient error on a
    // finished segment cannot pin its duration to 0 for the life of the serve.
    probeSegment ??= createProbeCache(async (file, st) => ({
      durationMs: (await ffprobeVideo(file)).durationMs,
      endMs: (st ?? statSync(file)).mtimeMs,
    }));
    const probe = probeSegment;
    const ffprobe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
      const { durationMs, endMs } = await probe(file).catch(() => ({ durationMs: 0, endMs: statSync(file).mtimeMs }));
      return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
    };

    const inventory = await scanInventory(join(dataRoot, "recordings"), taskRooms, ffprobe, { segmentSecByAnchor });
    return json(inventory);
  },

  // Free space of the data-root volume (GB) for the master's disk watchdog.
  disk: guarded(async (dataRoot) => {
    const { statfs } = await import("node:fs/promises");
    return json({ freeGB: Number(freeGBOf(await statfs(dataRoot)).toFixed(2)) });
  }),

  // Privacy-safe projection of every task on this node (no cookies), for master task sync.
  tasks: async (dataRoot) => {
    const { listNodeTasks } = await import("@drec/app");
    return json({ tasks: await withTaskStore(dataRoot, listNodeTasks) });
  },

  // Apply the master's desired tasks.
  "apply-tasks": async (dataRoot, [b64]) => {
    const { applyTasksPayload } = await import("@drec/app");
    return withTaskStore(dataRoot, async (store) => {
      // T16: expectedVersion travels in the payload; an old master without it → version 0.
      const result = applyTasksPayload(store, b64, undefined, {
        // Audit snapshot dir is derived from dataRoot explicitly (no DOUYIN_REC_ROOT here; see managed-state.ts).
        managedStateDir: join(dataRoot, "config", "managed"),
      });
      // Managed tasks that are no longer desired must be hard-stopped (not drained): the user explicitly
      // stopped the source task / removed the rule, and draining would keep the hub settle waiting for the
      // broadcast to end. Only the local serve holds the TaskManager, so ask it via
      // POST /api/tasks/:id/stop (internal=1 is accepted from loopback only).
      const byKey = new Map(store.listTasks().map((t) => [taskRoomKey(t.room), t] as const));
      for (const key of result.pending) {
        const task = byKey.get(key);
        if (!task) continue;
        try {
          const res = await fetch(`${serveApiBase()}/api/tasks/${task.id}/stop?internal=1`, {
            method: "POST",
            // Bounded: inside the resident serve a hung loopback call must not pin the request.
            signal: AbortSignal.timeout(10_000),
          });
          if (!res.ok) {
            console.error(`[task-sync] 硬停任务 id=${task.id}(${key}) 失败: HTTP ${res.status}`);
          }
        } catch (e) {
          // serve down/restarting → the next sync puts it back in pending; daemon drain is the last resort.
          console.error(`[task-sync] 硬停任务 id=${task.id}(${key}) 失败: ${(e as Error).message}`);
        }
      }
      // Managed tasks without an anchorName yet: ask the local serve to refetch it in the background
      // (fetching needs the platform runtime). Fire concurrently with a short timeout so a slow serve never
      // blocks task sync.
      const needsAnchor = store.listTasks().filter((t) => t.managedBy === "hub" && !t.anchorName);
      await Promise.allSettled(
        needsAnchor.map(async (t) => {
          try {
            await fetch(`${serveApiBase()}/api/tasks/${t.id}/refresh-anchor`, {
              method: "POST",
              signal: AbortSignal.timeout(3000),
            });
          } catch {
            // serve down/timeout → ignore; task-manager falls back to scraping the name from logs on live.
          }
        }),
      );
      return json(result);
    });
  },

  // Tail of one task's recording log (F3). Logs live in the serve's in-memory ring buffer, so ask it.
  // Read-only: serve down / unknown task → {lines:[], error} with exit 0; observability must not break callers.
  "task-logs": async (_dataRoot, [taskIdRaw, linesRaw]) => {
    const taskId = Number(taskIdRaw);
    // Clamp so one call can't drag thousands of lines over the wire. Default 200, max 1000.
    const asked = Number(linesRaw);
    const lines = Number.isFinite(asked) ? Math.min(1000, Math.max(1, Math.trunc(asked))) : 200;
    if (!Number.isFinite(taskId)) {
      return json({ lines: [], error: `taskId 非法: ${taskIdRaw}` });
    }
    try {
      const res = await fetch(`${serveApiBase()}/api/tasks/${taskId}/logs`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return json({ lines: [], error: `serve HTTP ${res.status}` });
      const body = (await res.json()) as { lines?: unknown };
      const all = Array.isArray(body.lines) ? body.lines.filter((x): x is string => typeof x === "string") : [];
      // Redact before leaving the node: vendored stream code can print whole cookie strings in errors.
      return json({ lines: redactLogLines(all.slice(-lines)) });
    } catch (e) {
      return json({ lines: [], error: `读本机 serve 失败: ${(e as Error)?.message ?? e}` });
    }
  },

  // Apply receipt (T16): which desired version this node applied and which bundle it runs.
  "node-status": async (dataRoot) => {
    const { readManagedState, APP_VERSION } = await import("@drec/app");
    let appliedVersion: number | null = null;
    let appliedAt: number | null = null;
    let appVersionAtApply: string | null = null;
    try {
      const st = readManagedState(join(dataRoot, "config", "managed"));
      if (st) {
        appliedVersion = st.version;
        appliedAt = st.savedAt;
        appVersionAtApply = st.appVersion ?? null;
      }
    } catch {
      /* never synced / missing dir → keep null (not an error) */
    }
    let taskCount = 0;
    let managedCount = 0;
    try {
      const tasks = await withTaskStore(dataRoot, (s) => s.listTasks());
      taskCount = tasks.length;
      managedCount = tasks.filter((t) => t.managedBy === "hub").length;
    } catch {
      /* db unreadable → counts stay 0; version info is still useful */
    }
    // Processing-queue snapshot (plans/036 T3): no db → empty; read failure → field omitted.
    let procActive: ProcActiveDTO | undefined;
    try {
      const { readProcActive } = await import("@drec/proc-queue");
      procActive = readProcActive(dataRoot);
    } catch {
      /* queue unreadable must not sink the whole command */
    }
    return json({
      appVersion: APP_VERSION,
      appliedVersion,
      appliedAt,
      appVersionAtApply,
      taskCount,
      managedCount,
      ...(procActive ? { procActive } : {}),
    });
  },

  // Page through this node's notification outbox; `--ack` confirms ids first. `--limit 0` = ack only.
  "notify-outbox": async (dataRoot, args) => {
    const o = readOptions(args);
    const { NotifyOutbox } = await import("@drec/app");
    const box = new NotifyOutbox(join(dataRoot, "db", "notify-outbox.db"));
    try {
      const ids = (o.ack ?? "").split(",").map((x) => Number(x.trim())).filter((n) => Number.isFinite(n) && n > 0);
      if (ids.length > 0) box.ack(ids);
      box.prune();
      const limitRaw = Number(o.limit ?? 200);
      const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(1000, limitRaw) : 200;
      const afterRaw = Number(o.after ?? 0);
      const after = Number.isFinite(afterRaw) && afterRaw > 0 ? afterRaw : 0;
      // limit=0 is "ack only": return no rows so every ack doesn't drag 200 rows across the network.
      const events = Number(o.limit) === 0 ? [] : box.list(after, limit);
      return json({ events });
    } finally {
      box.close();
    }
  },

  // Enqueue a processing job (remux only).
  enqueue: guarded(async (dataRoot, [b64]) => {
    await applyNodeDataRoot(dataRoot);
    const { decodeEnqueue } = await import("@drec/core");
    const { handleEnqueue } = await import("@drec/app");
    const capabilities = listProcessors().map((p) => p.kind);
    return json(handleEnqueue(dataRoot, decodeEnqueue(b64), { capabilities }));
  }),

  // Processing receipts (plans/036 §2.4): request = base64(JSON jobId array). Unknown jobIds are absent.
  "proc-status": guarded(async (dataRoot, [b64]) => {
    const { decodeJobIds, handleProcStatus } = await import("@drec/app");
    return json({ receipts: handleProcStatus(dataRoot, decodeJobIds(b64)) });
  }),

  // Cancel processing jobs (plans/038): pending rows are cancelled directly; running rows are closed out by the runner.
  "proc-cancel": guarded(async (dataRoot, [b64]) => {
    const { decodeJobIds, handleProcCancel } = await import("@drec/app");
    return json({ receipts: handleProcCancel(dataRoot, decodeJobIds(b64)) });
  }),

  // Node-side upload capabilities (biliup/cookies/disk/fonts) + registered processor kinds.
  "node-capabilities": async (dataRoot) => {
    await applyNodeDataRoot(dataRoot);
    const { probeNodeCapabilities } = await import("@drec/app");
    try {
      const { advertisedCapabilities } = await import("@drec/core");
      const caps = await probeNodeCapabilities(dataRoot);
      return json({ ...caps, processors: advertisedCapabilities() });
    } catch (e) {
      return errorJson(e);
    }
  },

  // Zero-disk receipts + per-room status (issue #331), read-only.
  "zero-disk-report": async (dataRoot) => {
    await applyNodeDataRoot(dataRoot);
    const { buildZeroDiskReport } = await import("@drec/app");
    try {
      return json(buildZeroDiskReport());
    } catch (e) {
      return errorJson(e);
    }
  },
});

/** Run a registry command for the hidden CLI entry point: same stdout bytes and exit code as before. */
export async function runNodeCommandCli(name: string, dataRoot: string, args: string[]): Promise<void> {
  const r = await NODE_COMMANDS[name](dataRoot, args);
  process.stdout.write(r.stdout);
  if (r.exitCode !== 0) process.exitCode = r.exitCode;
}
