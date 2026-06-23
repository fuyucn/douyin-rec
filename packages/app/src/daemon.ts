/**
 * app/daemon.ts — TaskDaemon: schedule-driven auto start/stop of recordings.
 *
 * On a fixed interval it evaluates every task's LOCAL-time schedule window (see
 * scheduler.inWindow, overnight-aware) and asks a TaskManager to start tasks
 * that became eligible / stop tasks that fell out of their window.
 *
 * The daemon is now a thin ORCHESTRATOR: it owns the tick loop + the pure
 * scheduling decision (`decide`), but it no longer builds RecordingSessions
 * in-process. Each task runs as an isolated `record` subprocess, managed by the
 * injected TaskManager (which in turn owns the subprocess lifecycle + crash
 * auto-restart). This keeps a misbehaving recorder from taking down the daemon.
 *
 * Composition: { store, decide(), TaskManager } — all injectable for tests.
 */
import { TaskStore, type Task } from "./store.js";
import { inWindow, nowMinutesLocal } from "./scheduler.js";
import { TaskManager } from "./task-manager.js";

export interface DaemonOpts {
  /**
   * Tick interval in ms. Default 60000 (60s). Schedule windows are minute-
   * granular ("HH:MM"), so sub-minute polling buys nothing — worst-case lag
   * hitting a window boundary is one tick. Open-detection AFTER a window opens
   * is handled separately by the recorder's own 30s live-status poll (bililive
   * autoCheckInterval), so a coarser daemon tick does NOT widen the gap to 开播.
   */
  intervalMs?: number;
  /** Injectable clock for tests. Default () => new Date(). */
  now?: () => Date;
  /** Injectable logger. Default console.log. */
  log?: (msg: string) => void;
}

/** Result of a pure scheduling decision: which task ids to start / stop. */
export interface Decision {
  start: number[];
  stop: number[];
}

/**
 * PURE scheduling decision. Given all tasks, the current time, and the set of
 * task ids that currently have an active recorder, return which ids should be
 * started (eligible + not active) and which should be stopped (active + no
 * longer eligible). No I/O, fully unit-testable.
 */
export function decide(
  tasks: Task[],
  now: Date,
  activeIds: ReadonlySet<number>,
): Decision {
  const nowMin = nowMinutesLocal(now);
  const start: number[] = [];
  const stop: number[] = [];
  for (const t of tasks) {
    // 用户意图优先：停用的任务永不启动；启用后才看窗口（无窗口 = 始终录制）。
    const eligible = t.enabled && inWindow(nowMin, t.scheduleStart, t.scheduleEnd);
    const active = activeIds.has(t.id);
    if (eligible && !active) start.push(t.id);
    else if (!eligible && active) stop.push(t.id);
  }
  return { start, stop };
}

export class TaskDaemon {
  private readonly store: TaskStore;
  private readonly manager: TaskManager;
  private readonly intervalMs: number;
  private readonly now: () => Date;
  private readonly log: (msg: string) => void;

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks (a slow start/stop spanning intervals). */
  private ticking = false;
  private stopped = false;
  /** taskIds already warned about overrunning into a fresh window (dedupe the log). */
  private readonly warnedReentry = new Set<number>();

  constructor(store: TaskStore, manager: TaskManager, opts: DaemonOpts = {}) {
    this.store = store;
    this.manager = manager;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.log ?? ((m): void => console.log(m));
  }

  /** Currently-active task ids (for tests / introspection). */
  activeIds(): Set<number> {
    return new Set(this.manager.runningIds());
  }

  /** Start the tick loop. Runs one tick immediately, then every intervalMs. */
  start(): void {
    this.stopped = false;
    void this.tick();
    // The interval keeps the process alive while idle (waiting for a window to
    // open). stop() clears it so the process can exit on SIGINT/SIGTERM.
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
  }

  /** One scheduling pass. Public so tests can drive it deterministically. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const tasks = this.store.listTasks();
      const active = new Set(this.manager.runningIds());
      const { start, stop } = decide(tasks, this.now(), active);
      for (const id of stop) {
        // GRACEFUL stop at window-end: never cut a live broadcast. The recorder
        // drains (stops looking for new streams) and exits when the current one
        // ends naturally. Idempotent → safe to re-issue every tick while drained.
        await this.manager.stopGraceful(id);
      }
      for (const id of start) {
        const t = tasks.find((x) => x.id === id);
        this.log(
          `[scheduler] ▶ 进入窗口，启动任务 id=${id}` +
            (t ? `（${t.name ?? t.room}）window=${t.scheduleStart ?? "—"}-${t.scheduleEnd ?? "—"}` : ""),
        );
        this.manager.start(id);
      }

      // P0 — overrun re-entry: a still-draining task from a previous window whose
      // NEW window has already opened. decide() leaves it as eligible+active (so
      // it's neither started nor stopped); it can't record the new window until
      // its old broadcast ends. Warn once; it self-heals on the next tick after
      // the drained process exits (then eligible && !active → start fresh).
      const nowMin = nowMinutesLocal(this.now());
      for (const t of tasks) {
        const eligible = t.enabled && inWindow(nowMin, t.scheduleStart, t.scheduleEnd);
        if (eligible && this.manager.isDraining(t.id)) {
          if (!this.warnedReentry.has(t.id)) {
            this.warnedReentry.add(t.id);
            this.log(
              `[scheduler] ⚠ 任务 id=${t.id}（${t.name ?? t.room}）仍在收尾上一场直播(超窗)，` +
                `本窗口暂不重启，待其自然收播后自动接管`,
            );
          }
        } else {
          this.warnedReentry.delete(t.id);
        }
      }
    } catch (err) {
      this.log(`[scheduler] tick 出错: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Stop all recorders and clear the interval. Idempotent. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.manager.stopAll();
  }
}
