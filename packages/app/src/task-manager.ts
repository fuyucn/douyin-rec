/**
 * app/task-manager.ts — subprocess lifecycle manager for recording tasks.
 *
 * Owns the Map<taskId → RecorderProcess>, drives start/stop, reflects status
 * into the TaskStore, and handles crash auto-restart. This is the SEAM the web
 * UI (phase 2) and the scheduling daemon both sit on top of.
 *
 * Crucially it depends ONLY on TaskStore + the Spawner *interface* — never on
 * child_process — so it is fully unit-testable with a MockSpawner returning a
 * controllable fake process. The injectable timer (`schedule`) lets restart
 * tests run synchronously.
 */
import { type TaskStore, resolveTaskCookies } from "./store.js";
import type { Spawner } from "./process/spawner.js";
import type { RecorderProcess, ExitInfo } from "./process/recorder-process.js";
import { TaskLogStore } from "./task-logs.js";

/** Live runtime info for a task, surfaced to the web 详情 page. */
export interface TaskRuntime {
  running: boolean;
  /** Epoch ms when the current run started, or null if not running. */
  startedAt: number | null;
  /** Elapsed ms since startedAt, or null if not running. */
  elapsedMs: number | null;
  /** 抓取到的主播名（最近一次录制解析到的），未知为 null。 */
  anchorName: string | null;
}

export interface TaskManagerOpts {
  /** Respawn a process that exits UNEXPECTEDLY (crash). Default false. */
  autoRestart?: boolean;
  /** Delay before a restart respawn, ms. Default 5000. */
  restartDelayMs?: number;
  /** Max consecutive auto-restarts per task before giving up. Default 5. */
  maxRestarts?: number;
  /** 任务崩溃重启耗尽、彻底放弃时回调(serve 接到 → 发告警 webhook)。 */
  onTaskDown?: (taskId: number, reason: string) => void;
  /** 子进程结构化告警(@@DREC_ALERT@@)回调(serve 接到 → EventCenter 站内 toast;webhook 子进程已发)。 */
  onAlert?: (taskId: number, stage: string, message: string) => void;
  /** Logger. Default console.log. */
  log?: (m: string) => void;
  /**
   * Injectable deferred scheduler (for tests). Receives the callback + delay,
   * returns nothing. Default wraps setTimeout. A test impl can run cb()
   * synchronously to assert restart behaviour without real timers.
   */
  schedule?: (cb: () => void, ms: number) => void;
  /**
   * Per-task log ring buffer. Inject to share with the web layer; defaults to a
   * fresh TaskLogStore (still readable via getLogs()).
   */
  logStore?: TaskLogStore;
  /** Clock injection for startedAt/elapsed (tests). Default Date.now. */
  clock?: () => number;
}

export class TaskManager {
  private readonly store: TaskStore;
  private readonly spawner: Spawner;
  private readonly autoRestart: boolean;
  private readonly restartDelayMs: number;
  private readonly maxRestarts: number;
  private readonly onTaskDown?: (taskId: number, reason: string) => void;
  private readonly onAlert?: (taskId: number, stage: string, message: string) => void;
  private readonly log: (m: string) => void;
  private readonly schedule: (cb: () => void, ms: number) => void;
  private readonly logStore: TaskLogStore;
  private readonly clock: () => number;

  /** taskId → live RecorderProcess. */
  private readonly procs = new Map<number, RecorderProcess>();
  /** taskId → consecutive auto-restart count (reset on explicit start/stop). */
  private readonly restarts = new Map<number, number>();
  /** taskIds currently DRAINING (window ended, waiting for the broadcast to end). */
  private readonly draining = new Set<number>();
  /** taskId → epoch ms the current run started; present iff running. */
  private readonly startedAt = new Map<number, number>();
  /** taskId → 抓取到的主播名（从子进程 `[主播] X` 日志解析；供 UI 显示）。 */
  private readonly anchorNames = new Map<number, string>();
  /** taskId → 是否真正在录视频（从 `[状态] 录制中/等待开播` 解析）。区分「录制中」vs「等待开播中」。 */
  private readonly recordingPhase = new Map<number, boolean>();

  constructor(store: TaskStore, spawner: Spawner, opts: TaskManagerOpts = {}) {
    this.store = store;
    this.spawner = spawner;
    this.autoRestart = opts.autoRestart ?? false;
    this.restartDelayMs = opts.restartDelayMs ?? 5_000;
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.onTaskDown = opts.onTaskDown;
    this.onAlert = opts.onAlert;
    this.log = opts.log ?? ((m): void => console.log(m));
    this.schedule =
      opts.schedule ?? ((cb, ms): void => void setTimeout(cb, ms).unref?.());
    this.logStore = opts.logStore ?? new TaskLogStore();
    this.clock = opts.clock ?? ((): number => Date.now());
  }

  /**
   * Emit a manager-level line to BOTH the console logger and the per-task ring
   * buffer, so the web 日志 console shows lifecycle events (start/stop/crash)
   * alongside child output.
   */
  private logTask(taskId: number, msg: string): void {
    this.log(msg);
    this.logStore.append(taskId, msg);
  }

  /** The per-task log lines (oldest → newest) for the web 日志 console. */
  getLogs(taskId: number): string[] {
    return this.logStore.get(taskId);
  }

  /** Live runtime: running flag + startedAt + elapsed for the web 详情 page. */
  getRuntime(taskId: number): TaskRuntime {
    const running = this.procs.has(taskId);
    const startedAt = this.startedAt.get(taskId) ?? null;
    return {
      running,
      startedAt: running ? startedAt : null,
      elapsedMs: running && startedAt !== null ? this.clock() - startedAt : null,
      anchorName: this.anchorNames.get(taskId) ?? null,
    };
  }

  /** 抓取到的主播名（无则 null）。供 list/detail 视图显示。 */
  getAnchorName(taskId: number): string | null {
    return this.anchorNames.get(taskId) ?? null;
  }

  /** 是否真正在录视频（true=录制中；false=进程在跑但等待开播/重连中）。 */
  isRecording(taskId: number): boolean {
    return this.recordingPhase.get(taskId) ?? false;
  }

  /** Spawn the task if not already running. Returns false if running/missing. */
  start(taskId: number): boolean {
    if (this.procs.has(taskId)) return false;
    const task = this.store.getTask(taskId);
    if (!task) {
      this.log(`[task_manager] start: 未找到任务 id=${taskId}`);
      return false;
    }
    this.restarts.set(taskId, 0);
    this.spawnFor(taskId);
    this.store.setStatus(taskId, "running");
    this.logTask(taskId, `[task_manager] ▶ 启动任务 id=${taskId}（${task.name ?? task.room}）`);
    return true;
  }

  /** Hard stop; marks the exit expected; status → 'stopped'. Overrides a drain. */
  async stop(taskId: number): Promise<void> {
    const proc = this.procs.get(taskId);
    // Reset restart budget so an in-flight restart timer becomes a no-op.
    this.restarts.delete(taskId);
    this.draining.delete(taskId);
    if (!proc) return;
    this.logTask(taskId, `[task_manager] ■ 停止任务 id=${taskId}`);
    await proc.stop();
    // onExit (expected) handler sets status + clears the map entry.
  }

  /**
   * Window-end GRACEFUL stop (drain): do NOT cut the broadcast. Tells the
   * subprocess (SIGUSR2) to stop looking for new streams but let the current
   * recording finish naturally, then exit. Status → 'draining' until it ends.
   * Idempotent — the daemon re-issues this every tick while still out of window.
   */
  async stopGraceful(taskId: number): Promise<void> {
    const proc = this.procs.get(taskId);
    if (!proc) return;
    if (this.draining.has(taskId)) return;   // already draining — no-op
    this.draining.add(taskId);
    this.restarts.delete(taskId);            // a drained natural exit isn't a crash
    this.store.setStatus(taskId, "draining");
    this.logTask(
      taskId,
      `[task_manager] ⏳ 任务 id=${taskId} 窗口结束，进入排空：当前直播录完(自然收播)后停止，不强制中断`,
    );
    await proc.stopGraceful();
    // onExit (expected) handler sets status 'stopped' + clears draining.
  }

  /** Whether a task is currently draining (overrunning its window, not cut). */
  isDraining(taskId: number): boolean {
    return this.draining.has(taskId);
  }

  /** Stop every running task. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.procs.keys()].map((id) => this.stop(id)));
  }

  isRunning(taskId: number): boolean {
    return this.procs.has(taskId);
  }

  runningIds(): number[] {
    return [...this.procs.keys()];
  }

  /** Spawn a fresh process for the task and wire its exit handling. */
  private spawnFor(taskId: number): void {
    const task = this.store.getTask(taskId)!;
    // Cookie resolution gated by the per-task useCookie toggle. Same
    // resolveTaskCookies helper as buildSessionForTask → both paths stay in
    // sync: useCookie=false → null → no --cookies → anonymous danmu; otherwise
    // task.cookies override, else the global settings.defaultCookies.
    const effective = {
      ...task,
      cookies: resolveTaskCookies(task, this.store.getDefaultCookies()),
    };
    const proc = this.spawner.spawn(effective);
    this.procs.set(taskId, proc);
    this.startedAt.set(taskId, this.clock());
    // 新一轮录制：清掉上轮抓到的主播名（重新解析）。若任务已设 name 则以 name 优先（见 view）。
    this.anchorNames.delete(taskId);
    // 刚启动是「等待开播」（录制器在轮询开播，还没拿到流）→ recording=false。
    this.recordingPhase.set(taskId, false);
    // Fan child stdout/stderr into the per-task ring buffer (the spawner's own
    // onLog still handles console). This is the live tail the web UI reads.
    // 同时从日志里捞主播名 + 录制相位（`[主播] X` / `[状态] 录制中|等待开播`）。
    proc.onLog((msg) => {
      // 结构化告警通道:子进程 error → @@DREC_ALERT@@{json}。转 onAlert,不当日志显示。
      const alert = /@@DREC_ALERT@@(\{.*\})/.exec(msg);
      if (alert) {
        try {
          const a = JSON.parse(alert[1]) as { stage?: string; message?: string };
          this.onAlert?.(taskId, a.stage ?? "error", a.message ?? "");
        } catch { /* 解析失败忽略 */ }
        return;
      }
      this.logStore.append(taskId, msg);
      const m = /\[主播\]\s+([^\n]+)/.exec(msg);
      if (m) {
        const name = m[1].trim();
        this.anchorNames.set(taskId, name);
        this.store.setAnchorName(taskId, name); // 持久化，重启后仍显示
      }
      if (msg.includes("[状态] 录制中")) this.recordingPhase.set(taskId, true);
      else if (msg.includes("[状态] 等待开播")) this.recordingPhase.set(taskId, false);
    });
    proc.onExit((info) => this.handleExit(taskId, info));
    proc.start();
  }

  private handleExit(taskId: number, info: ExitInfo): void {
    // Only act if this process is still the one we track (guards against a
    // late exit from an already-replaced/stopped process).
    this.procs.delete(taskId);
    this.startedAt.delete(taskId);
    this.recordingPhase.delete(taskId);
    const wasDraining = this.draining.delete(taskId);

    if (info.expected) {
      this.store.setStatus(taskId, "stopped");
      this.logTask(
        taskId,
        wasDraining
          ? `[task_manager] ✓ 任务 id=${taskId} 直播自然收播，排空完成，已停止`
          : `[task_manager] ✓ 任务 id=${taskId} 已正常停止`,
      );
      return;
    }

    // Unexpected exit (crash).
    this.store.setStatus(taskId, "error");
    this.logTask(
      taskId,
      `[task_manager] ✗ 任务 id=${taskId} 异常退出 (code=${info.code} signal=${info.signal})`,
    );

    if (!this.autoRestart) return;
    // If stop() was called concurrently it deleted the restart budget → abort.
    if (!this.restarts.has(taskId)) return;

    const count = (this.restarts.get(taskId) ?? 0) + 1;
    if (count > this.maxRestarts) {
      const reason = `已达最大重启次数 ${this.maxRestarts}，放弃（已停止录制）`;
      this.logTask(taskId, `[task_manager] 任务 id=${taskId} ${reason}`);
      this.restarts.delete(taskId);
      this.onTaskDown?.(taskId, reason);
      return;
    }
    this.restarts.set(taskId, count);
    this.logTask(
      taskId,
      `[task_manager] ↻ 任务 id=${taskId} 将在 ${this.restartDelayMs}ms 后第 ${count} 次重启`,
    );
    this.schedule(() => {
      // Guard: a stop() between scheduling and firing clears the budget.
      if (!this.restarts.has(taskId)) return;
      if (this.procs.has(taskId)) return;
      this.spawnFor(taskId);
      this.store.setStatus(taskId, "running");
    }, this.restartDelayMs);
  }
}
