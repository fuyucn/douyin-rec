/**
 * Recorder process state file (plans/044 design A/B).
 *
 * Every `record` child with a task id writes `<root>/run/rec-<taskId>.json` describing what it is doing.
 * The child is the ONLY writer. Readers (node commands `is-done` / `recording-status`) never trust the file
 * alone: `recorderActivity` is the single judge and verifies the owner process through an injected `/proc`
 * probe, so a crashed child (SIGKILL, OOM) is reported `dead` instead of "recording forever".
 *
 * Kept free of other drec packages: it only needs node:fs and the atomic writer from this package.
 */
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomicSync } from "./atomic-write.js";

export const RECORDER_STATE_SCHEMA_VERSION = 1;

/** While `finalizing` the writer refreshes `heartbeatAt` this often. */
export const FINALIZING_HEARTBEAT_MS = 30_000;

/**
 * An owner that is alive but has written nothing for this long is not trusted to still be working
 * (a hung finalize, or a pid the OS handed to something else). Shared by the rolling-upload sidecar
 * check (#309) and the `finalizing` heartbeat check.
 */
export const ROLLING_ACTIVE_MAX_QUIET_MS = 3 * 3600_000;

/**
 * A finalizing child that has reported no upload progress for this long is treated as stuck. A single chunk
 * attempt may take up to CHUNK_TIMEOUT_MS (4 min) and is retried several times with backoff, so one healthy
 * stall can last well over 10 minutes; 45 min covers several full retry cycles. Elapsed time alone must never
 * decide: a 2 GiB part at 2 Mbps legitimately uploads for ~2.3 h while progress keeps arriving.
 */
export const FINALIZING_STALL_MS = 45 * 60_000;

/** Loose backstop for a finalizing phase that keeps reporting "progress" forever (a bug, not a slow upload). */
export const FINALIZING_MAX_MS = 24 * 3600_000;

/** Progress notes are written to the state file at most this often. */
export const PROGRESS_WRITE_THROTTLE_MS = 10_000;

export type RecorderMode = "file" | "rolling" | "live";
export type RecorderPhase = "polling" | "recording" | "finalizing" | "exited";
export type RecorderActivity = "active" | "ended" | "dead";

const MODES: readonly RecorderMode[] = ["file", "rolling", "live"];
const PHASES: readonly RecorderPhase[] = ["polling", "recording", "finalizing", "exited"];

export interface RecorderOwner {
  pid: number;
  /** Linux: field 22 of /proc/<pid>/stat. Null where it cannot be read (non-Linux). */
  startTicks: number | null;
  /** Linux: /proc/sys/kernel/random/boot_id. Null where it cannot be read. */
  bootId: string | null;
}

export interface RecorderExit {
  code: number | null;
  signal: string | null;
  at: number;
  /** True when a SIGUSR2 window-end drain was requested before the exit. */
  draining: boolean;
}

export interface RecorderStateFile {
  schemaVersion: 1;
  taskId: number;
  platform: string;
  roomSlug: string;
  mode: RecorderMode;
  owner: RecorderOwner;
  phase: RecorderPhase;
  /** Current session base name, null while no session is open. */
  session: string | null;
  /** Set on every write; refreshed every FINALIZING_HEARTBEAT_MS only while phase=finalizing. */
  heartbeatAt: number;
  /** Epoch ms of entering `finalizing`; null in any other phase (and in files written by older bundles). */
  finalizingSince: number | null;
  /** Epoch ms of the last upload progress (chunk / part confirmed) while finalizing; null otherwise or in older files. */
  progressAt: number | null;
  exit: RecorderExit | null;
  updatedAt: number;
}

// ─── paths ─────────────────────────────────────────────────────────────────────

/** `<root>/run` — runtime state directory of one data root. */
export function recorderStateDir(root: string): string {
  return join(root, "run");
}

export function recorderStateFileName(taskId: number): string {
  return `rec-${taskId}.json`;
}

export function recorderStatePath(root: string, taskId: number): string {
  return join(recorderStateDir(root), recorderStateFileName(taskId));
}

// ─── /proc probe ────────────────────────────────────────────────────────────────

/** Process facts the judge needs. Injected so the judge stays pure and testable. */
export interface ProcProbe {
  /** Start time (clock ticks since boot) of a live pid; null when the pid is gone or unreadable. */
  startTicks(pid: number): number | null;
  /** Current boot id; null when unavailable. */
  bootId(): string | null;
}

/** Parse field 22 of /proc/<pid>/stat. `comm` may contain spaces and parens, so parse after the last ')'. */
export function parseStartTicks(stat: string): number | null {
  const close = stat.lastIndexOf(")");
  if (close < 0) return null;
  // After ")" the fields continue from field 3 (state); field 22 is index 19 of that remainder.
  const rest = stat.slice(close + 2).split(" ");
  const raw = rest[19];
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

export const linuxProcProbe: ProcProbe = {
  startTicks(pid) {
    try {
      return parseStartTicks(readFileSync(`/proc/${pid}/stat`, "utf-8"));
    } catch {
      return null;
    }
  },
  bootId() {
    try {
      return readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null;
    } catch {
      return null;
    }
  },
};

// ─── judge ──────────────────────────────────────────────────────────────────────

/**
 * The single judge of a recorder state file.
 *  - phase `exited` → `ended` (the child said goodbye itself).
 *  - otherwise the owner must be the very process that wrote the file: same pid start time and same boot
 *    id (guards pid reuse and reboots). Unverifiable (null ticks/boot id, e.g. non-Linux) → `dead`.
 *  - `finalizing` additionally needs a heartbeat newer than ROLLING_ACTIVE_MAX_QUIET_MS. The heartbeat is a
 *    plain timer (a hung tail keeps it fresh), so when the file carries `progressAt` the judge also requires
 *    progress within FINALIZING_STALL_MS and a finalizing phase younger than FINALIZING_MAX_MS. Elapsed time
 *    alone is never a reason: slow healthy uploads run for hours. Files without `progressAt` (older bundles)
 *    keep the heartbeat-only rule.
 */
export function recorderActivity(state: RecorderStateFile, now: number, proc: ProcProbe): RecorderActivity {
  if (state.phase === "exited") return "ended";
  const { pid, startTicks, bootId } = state.owner;
  if (startTicks === null || bootId === null) return "dead";
  const liveTicks = proc.startTicks(pid);
  if (liveTicks === null || liveTicks !== startTicks) return "dead";
  if (proc.bootId() !== bootId) return "dead";
  if (state.phase === "finalizing") {
    if (now - state.heartbeatAt > ROLLING_ACTIVE_MAX_QUIET_MS) return "dead";
    if (state.progressAt !== null) {
      if (now - state.progressAt > FINALIZING_STALL_MS) return "dead";
      if (state.finalizingSince !== null && now - state.finalizingSince > FINALIZING_MAX_MS) return "dead";
    }
  }
  return "active";
}

// ─── parse / read ───────────────────────────────────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Strict parse of a state file's JSON. Unknown schema versions and malformed shapes → null. */
export function parseRecorderState(raw: unknown): RecorderStateFile | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.schemaVersion !== RECORDER_STATE_SCHEMA_VERSION) return null;
  if (!isNum(r.taskId) || !isStr(r.platform) || !isStr(r.roomSlug)) return null;
  if (!MODES.includes(r.mode as RecorderMode) || !PHASES.includes(r.phase as RecorderPhase)) return null;
  const o = r.owner as Record<string, unknown> | null;
  if (!o || typeof o !== "object" || !isNum(o.pid)) return null;
  if (!(o.startTicks === null || isNum(o.startTicks)) || !(o.bootId === null || isStr(o.bootId))) return null;
  if (!(r.session === null || isStr(r.session)) || !isNum(r.heartbeatAt) || !isNum(r.updatedAt)) return null;
  let exit: RecorderExit | null = null;
  if (r.exit !== null) {
    const e = r.exit as Record<string, unknown> | undefined;
    if (!e || typeof e !== "object" || !isNum(e.at)) return null;
    if (!(e.code === null || isNum(e.code)) || !(e.signal === null || isStr(e.signal))) return null;
    exit = { code: e.code as number | null, signal: e.signal as string | null, at: e.at, draining: e.draining === true };
  }
  return {
    schemaVersion: 1,
    taskId: r.taskId,
    platform: r.platform,
    roomSlug: r.roomSlug,
    mode: r.mode as RecorderMode,
    owner: { pid: o.pid, startTicks: o.startTicks as number | null, bootId: o.bootId as string | null },
    phase: r.phase as RecorderPhase,
    session: r.session as string | null,
    heartbeatAt: r.heartbeatAt,
    finalizingSince: isNum(r.finalizingSince) ? r.finalizingSince : null,
    progressAt: isNum(r.progressAt) ? r.progressAt : null,
    exit,
    updatedAt: r.updatedAt,
  };
}

/** Exited state files older than this are ignored by readers (never deleted). */
export const EXITED_STATE_IGNORE_AFTER_MS = 7 * 24 * 3600_000;

/** Read every `rec-*.json` under `<root>/run`. Unparsable files are skipped with one log line each. */
export function readRecorderStates(root: string, log: (msg: string) => void = () => {}): RecorderStateFile[] {
  const dir = recorderStateDir(root);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return []; // no run dir yet: no state files
  }
  const out: RecorderStateFile[] = [];
  for (const name of names) {
    if (!/^rec-\d+\.json$/.test(name)) continue; // also skips atomic-write `.tmp` leftovers
    try {
      const parsed = parseRecorderState(JSON.parse(readFileSync(join(dir, name), "utf-8")));
      if (parsed) out.push(parsed);
      else log(`[recorder-state] skip ${name}: unrecognised content`);
    } catch (e) {
      log(`[recorder-state] skip ${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Per-room verdict used by the node commands. */
export interface RoomActivity {
  platform: string;
  roomSlug: string;
  /** Some verified-active owner (any phase, including polling) exists for this room. */
  active: boolean;
  /** An active owner is pulling a stream right now. */
  recording: boolean;
  /** An active owner is still sealing / uploading its tail. */
  finalizing: boolean;
}

/**
 * Fold state files into one entry per `platform:roomSlug`. A room appears here as soon as ANY state file
 * names it (even a dead or exited one): callers use presence to decide whether the /proc process scan
 * fallback is still needed for that room.
 */
export function roomActivities(states: readonly RecorderStateFile[], now: number, proc: ProcProbe): Map<string, RoomActivity> {
  const rooms = new Map<string, RoomActivity>();
  for (const s of states) {
    const key = `${s.platform}:${s.roomSlug}`;
    const room = rooms.get(key) ?? { platform: s.platform, roomSlug: s.roomSlug, active: false, recording: false, finalizing: false };
    if (recorderActivity(s, now, proc) === "active") {
      room.active = true;
      if (s.phase === "recording") room.recording = true;
      else if (s.phase === "finalizing") room.finalizing = true;
    }
    rooms.set(key, room);
  }
  return rooms;
}

// ─── writer (child side) ────────────────────────────────────────────────────────

export interface RecorderStateWriterOptions {
  file: string;
  taskId: number;
  platform: string;
  roomSlug: string;
  mode: RecorderMode;
  owner: RecorderOwner;
  now?: () => number;
  /** Atomic write seam (tests inject failures). */
  write?: (file: string, data: string) => void;
  log?: (msg: string) => void;
  heartbeatMs?: number;
}

/**
 * Owns one state file. Write failures are logged once and never thrown: losing the state file must not
 * stop the recording. Not safe for multiple processes (the file has exactly one writer by design).
 */
export class RecorderStateWriter {
  private phase: RecorderPhase = "polling";
  private session: string | null = null;
  private exit: RecorderExit | null = null;
  private signal: string | null = null;
  private draining = false;
  private finalizingSince: number | null = null;
  private progressAt: number | null = null;
  private lastProgressWriteAt = 0;
  private warned = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => number;
  private readonly writeFile: (file: string, data: string) => void;
  private readonly log: (msg: string) => void;

  constructor(private readonly o: RecorderStateWriterOptions) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((m) => console.warn(m));
    this.writeFile = o.write ?? ((file, data) => {
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileAtomicSync(file, data);
    });
  }

  /** Write the initial (polling) state. */
  start(): void {
    this.flush();
  }

  setPhase(phase: RecorderPhase, session?: string | null): void {
    if (this.exit) return; // exited is terminal
    const same = phase === this.phase && (session === undefined || session === this.session);
    if (session !== undefined) this.session = session;
    if (phase === "finalizing") {
      if (this.phase !== "finalizing") {
        this.finalizingSince = this.now();
        this.progressAt = this.finalizingSince;
        this.lastProgressWriteAt = this.finalizingSince;
      }
    } else {
      this.finalizingSince = null;
      this.progressAt = null;
    }
    this.phase = phase;
    this.syncTimer();
    if (!same) this.flush();
  }

  setSession(session: string | null): void {
    if (this.exit || session === this.session) return;
    this.session = session;
    this.flush();
  }

  /**
   * Upload progress (a chunk completed, a part confirmed). Only meaningful while finalizing; elsewhere ignored.
   * Writes are throttled: the judge only needs progress within FINALIZING_STALL_MS.
   */
  noteProgress(): void {
    if (this.exit || this.phase !== "finalizing") return;
    const t = this.now();
    if (t - this.lastProgressWriteAt < PROGRESS_WRITE_THROTTLE_MS) return;
    this.lastProgressWriteAt = t;
    this.progressAt = t;
    this.flush();
  }

  /** True while the child is sealing / uploading its tail (progress sampling is only worth doing then). */
  get isFinalizing(): boolean {
    return !this.exit && this.phase === "finalizing";
  }

  noteSignal(signal: string): void {
    this.signal = signal;
  }

  noteDraining(): void {
    this.draining = true;
  }

  /** Synchronous: safe inside `process.on("exit")`. Idempotent. */
  markExited(code: number | null): void {
    if (this.exit) return;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    const at = this.now();
    this.exit = { code, signal: this.signal, at, draining: this.draining };
    this.phase = "exited";
    this.finalizingSince = null;
    this.progressAt = null;
    this.flush();
  }

  /** Register the exit hook on a process-like emitter. */
  installExitHook(proc: Pick<NodeJS.Process, "on">): void {
    proc.on("exit", (code: number) => this.markExited(typeof code === "number" ? code : null));
  }

  private syncTimer(): void {
    const want = this.phase === "finalizing";
    if (want && !this.timer) {
      this.timer = setInterval(() => this.flush(), this.o.heartbeatMs ?? FINALIZING_HEARTBEAT_MS);
      this.timer.unref?.();
    } else if (!want && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private flush(): void {
    const t = this.now();
    const state: RecorderStateFile = {
      schemaVersion: 1,
      taskId: this.o.taskId,
      platform: this.o.platform,
      roomSlug: this.o.roomSlug,
      mode: this.o.mode,
      owner: this.o.owner,
      phase: this.phase,
      session: this.session,
      heartbeatAt: t,
      finalizingSince: this.finalizingSince,
      progressAt: this.progressAt,
      exit: this.exit,
      updatedAt: t,
    };
    try {
      this.writeFile(this.o.file, JSON.stringify(state));
    } catch (e) {
      if (!this.warned) {
        this.warned = true;
        this.log(`[recorder-state] write failed (continuing without state file updates): ${(e as Error).message}`);
      }
    }
  }
}

/** Owner facts of the current process. Non-Linux → null ticks/boot id (the judge then reports `dead`). */
export function currentOwner(proc: ProcProbe = linuxProcProbe, pid: number = process.pid): RecorderOwner {
  return { pid, startTicks: proc.startTicks(pid), bootId: proc.bootId() };
}

// ─── process-wide reporter ──────────────────────────────────────────────────────

let current: RecorderStateWriter | null = null;

/**
 * Start the process-wide state writer (record child only). Phase reports from the session layers are
 * no-ops until this has been called, so library code and standalone runs without a task id stay unchanged.
 */
export function initRecorderState(o: Omit<RecorderStateWriterOptions, "file" | "owner"> & { root: string; owner?: RecorderOwner }): RecorderStateWriter {
  const { root, owner, ...rest } = o;
  const w = new RecorderStateWriter({ ...rest, file: recorderStatePath(root, o.taskId), owner: owner ?? currentOwner() });
  current = w;
  w.start();
  return w;
}

export function setRecorderPhase(phase: RecorderPhase, session?: string | null): void {
  current?.setPhase(phase, session);
}

export function setRecorderSession(session: string | null): void {
  current?.setSession(session);
}

/** True when the process-wide writer is in the `finalizing` phase (false without a writer). */
export function recorderIsFinalizing(): boolean {
  return current?.isFinalizing ?? false;
}

/** Upload progress report (no-op without a process-wide writer, or outside the finalizing phase). */
export function noteRecorderProgress(): void {
  current?.noteProgress();
}

export function noteRecorderSignal(signal: string): void {
  current?.noteSignal(signal);
}

export function noteRecorderDraining(): void {
  current?.noteDraining();
}

/** Test seam: drop the process-wide writer. */
export function resetRecorderStateForTest(): void {
  current = null;
}

/**
 * The single place that prints a `[状态]` line and mirrors it into the state file, so the log marker the
 * serve parses and the state file can never disagree.
 */
export function announceRecorderStatus(label: "等待开播" | "录制中", phase: RecorderPhase): void {
  setRecorderPhase(phase, phase === "polling" ? null : undefined);
  console.log(`[状态] ${label}`);
}
