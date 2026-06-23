/**
 * app/process/recorder-process.ts — one recorder subprocess, abstracted.
 *
 * RecorderProcess is the seam the TaskManager talks to: it never touches
 * child_process directly, so it can be unit-tested with a fake. The concrete
 * ChildRecorderProcess wraps a single `child_process.spawn`d child, tracks
 * whether an exit was EXPECTED (we asked it to stop) vs a crash, pipes the
 * child's stdout/stderr to an injected log callback, and resolves stop() only
 * after the child has actually exited (escalating SIGTERM → SIGKILL on timeout).
 *
 * The spawn TARGET (command + args + cwd) is injected — this file does not know
 * the cli path or how a Task maps to args. That belongs to the Spawner.
 */
import { spawn, type ChildProcess } from "node:child_process";

/** Info passed to onExit listeners. */
export interface ExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** true when the exit followed a stop() call (graceful); false on crash. */
  expected: boolean;
}

/** Abstraction over a single recorder subprocess. The TaskManager seam. */
export interface RecorderProcess {
  readonly taskId: number;
  readonly pid: number | undefined;
  /** Spawn the child (idempotent-safe: only the first call spawns). */
  start(): void;
  /** Graceful SIGTERM; resolves after the child exits (or SIGKILL on timeout). */
  stop(): Promise<void>;
  /**
   * Window-end DRAIN: SIGUSR2 → the child stops looking for new broadcasts but
   * lets the current recording finish naturally, then exits. Resolves after the
   * child exits. NO SIGKILL escalation (a drain may legitimately last hours).
   * Idempotent — repeated calls await the same exit.
   */
  stopGraceful(): Promise<void>;
  /** Register an exit listener. Fired exactly once when the child exits. */
  onExit(cb: (info: ExitInfo) => void): void;
  /**
   * Register an ADDITIONAL log listener, fired for each child stdout/stderr
   * line (in addition to the constructor-injected `onLog`). Lets the
   * TaskManager fan child output into a per-task ring buffer for the web UI
   * without disturbing the spawner's console logging.
   */
  onLog(cb: (msg: string) => void): void;
}

export interface ChildRecorderProcessOpts {
  taskId: number;
  /** Executable to spawn (e.g. process.execPath). */
  command: string;
  /** Argument vector (e.g. [cliEntry, "record", "--room", ...]). */
  args: string[];
  /** Working directory for the child. */
  cwd?: string;
  /** Child env. Omit → inherit parent's process.env. Provide to override/extend (e.g. MESIO_PATH). */
  env?: NodeJS.ProcessEnv;
  /** Receives each line-ish chunk of child stdout/stderr. */
  onLog?: (msg: string) => void;
  /** ms to wait after SIGTERM before SIGKILL. Default 10_000. */
  killTimeoutMs?: number;
}

export class ChildRecorderProcess implements RecorderProcess {
  readonly taskId: number;
  private readonly command: string;
  private readonly args: string[];
  private readonly cwd: string | undefined;
  private readonly env: NodeJS.ProcessEnv | undefined;
  /** Constructor-injected log sink (spawner → console). The `onLog()` METHOD
   * registers ADDITIONAL listeners (e.g. the manager's ring-buffer). */
  private readonly injectedLog: (msg: string) => void;
  private readonly killTimeoutMs: number;

  private child: ChildProcess | null = null;
  private expected = false;
  private exited = false;
  /** True once a graceful drain (SIGUSR2) has been requested — makes it idempotent. */
  private draining = false;
  private readonly exitListeners: ((info: ExitInfo) => void)[] = [];
  private readonly logListeners: ((msg: string) => void)[] = [];
  /** Resolved when the child exits; created on start(). */
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;

  constructor(opts: ChildRecorderProcessOpts) {
    this.taskId = opts.taskId;
    this.command = opts.command;
    this.args = opts.args;
    this.cwd = opts.cwd;
    this.env = opts.env;
    this.injectedLog = opts.onLog ?? ((): void => {});
    this.killTimeoutMs = opts.killTimeoutMs ?? 10_000;
  }

  get pid(): number | undefined {
    return this.child?.pid;
  }

  start(): void {
    if (this.child) return;
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });
    // detached:true → 子进程成进程组 leader,硬停时用 process.kill(-pid) 一并收割它 spawn 的
    // ffmpeg 孙进程(否则 node 被 SIGKILL 后 ffmpeg 成孤儿继续写盘/占流)。
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env, // undefined → 继承 process.env;有值时已是 {...process.env, MESIO_PATH} 合并结果
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    this.child.stdout?.on("data", (b: Buffer) => this.pipe(b));
    this.child.stderr?.on("data", (b: Buffer) => this.pipe(b));

    this.child.on("exit", (code, signal) => {
      this.exited = true;
      const info: ExitInfo = { code, signal, expected: this.expected };
      for (const cb of this.exitListeners) cb(info);
      this.resolveExit?.();
    });
    this.child.on("error", (err) => {
      this.emitLog(`[task ${this.taskId}] spawn error: ${String(err)}`);
      // 'error' may fire without 'exit' (e.g. ENOENT) — synthesize an exit.
      if (!this.exited) {
        this.exited = true;
        const info: ExitInfo = { code: null, signal: null, expected: this.expected };
        for (const cb of this.exitListeners) cb(info);
        this.resolveExit?.();
      }
    });
  }

  async stop(): Promise<void> {
    this.expected = true;
    const child = this.child;
    if (!child || this.exited) return;

    this.killGroup("SIGTERM");
    const timer = setTimeout(() => {
      if (!this.exited) this.killGroup("SIGKILL");
    }, this.killTimeoutMs);
    try {
      await this.exitPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 信号发给整个进程组(负 pid),连带收割 ffmpeg 孙进程;组不存在则回退直发子进程。 */
  private killGroup(sig: NodeJS.Signals): void {
    const child = this.child;
    if (!child?.pid) return;
    try {
      process.kill(-child.pid, sig); // 负 pid = 进程组
    } catch {
      try {
        child.kill(sig); // ESRCH 等:回退直接杀子进程
      } catch {
        /* already gone */
      }
    }
  }

  async stopGraceful(): Promise<void> {
    this.expected = true;
    const child = this.child;
    if (!child || this.exited) return;
    if (this.draining) { await this.exitPromise; return; }  // idempotent
    this.draining = true;
    // SIGUSR2 → the record subprocess drains (let current broadcast finish).
    // Deliberately NO SIGKILL timer: a drain may legitimately run for hours.
    child.kill("SIGUSR2");
    await this.exitPromise;
  }

  onExit(cb: (info: ExitInfo) => void): void {
    this.exitListeners.push(cb);
  }

  onLog(cb: (msg: string) => void): void {
    this.logListeners.push(cb);
  }

  private emitLog(msg: string): void {
    this.injectedLog(msg);
    for (const cb of this.logListeners) cb(msg);
  }

  private pipe(b: Buffer): void {
    const text = b.toString("utf-8").replace(/\n$/, "");
    if (text) this.emitLog(`[task ${this.taskId}] ${text}`);
  }
}
