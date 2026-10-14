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
import { DEFAULT_DISK_MIN_GB, resolveDiskMinGB, shouldRefuseNewRecording, type DiskMinGBSource } from "@drec/core";

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
  /**
   * master 本机抑制名单(hub 语义):返回「不应在本节点实跑」的任务 id
   * (规则绑定的源任务、workers 勾选了远端节点但不含 local)。daemon 每 tick 现读,
   * 跟随规则文件手改即时生效;缺省 = 不抑制(单机/worker 行为完全不变)。
   */
  localSuppressedIds?: () => ReadonlySet<number>;
  /**
   * 数据根剩余空间(字节)。返回 null/undefined = 查不到(不拦)。
   * 低于 {@link DaemonOpts.diskWatermarkBytes} → **拒绝启动新录制**(见 T-33 不变量 6)。
   */
  freeBytes?: () => number | null;
  /**
   * 磁盘低水位(字节):剩余低于它时**不启动新任务**。0/缺省 = 关闭该闸门。
   * **只拦「新开一场」**;已在录的任务**不受影响**(绝不截断当前录制腾空间)。
   */
  diskWatermarkBytes?: number;
}

export { DEFAULT_DISK_MIN_GB };

/**
 * 边录边传漂移(issue #89)重启前要求的**连续空闲 tick 数**。tick=60s,故真实空闲约 1–2 分钟:
 * 避开「刚收播 / 断流重连退避中」这种 recording 暂时为 false 的瞬态,免得把还会续上的一场腰斩成两个会话。
 */
export const ROLLING_DRIFT_IDLE_TICKS = 2;

/**
 * 由 hub 配置 JSON 解出 daemon 的磁盘水位(字节)。纯函数。
 *
 * worker 节点没有 hub 全局配置(只有 example 模板)→ 读不到 `resources.diskMinGB` 时
 * **回落默认 10GB**,而不是 0(= 静默关闭闸门:恰是最易写满的 worker 无闸门)。
 * 显式 `diskMinGB <= 0` 仍表示关闭(与 reconciler 同语义);JSON 损坏 → 同样回落默认(宁可拦)。
 */
export function resolveDiskWatermarkBytes(
  hubConfigJson: string | undefined,
  warn?: (msg: string) => void,
): number {
  return resolveDiskWatermark(hubConfigJson, warn).bytes;
}

export type DiskWatermarkSource = DiskMinGBSource;

/**
 * 同 {@link resolveDiskWatermarkBytes},额外返回来源(供启动日志)。
 * 回落默认的两种异常(JSON 损坏 / `diskMinGB` 非数字)经 `warn` 告警,不静默;正常配置与「未配置」不告警。
 */
export function resolveDiskWatermark(
  hubConfigJson: string | undefined,
  warn?: (msg: string) => void,
): { bytes: number; source: DiskWatermarkSource } {
  let raw: unknown;
  let parseFailed = false;
  try {
    const cfg = JSON.parse(hubConfigJson ?? "{}") as { resources?: { diskMinGB?: unknown } };
    raw = cfg.resources?.diskMinGB;
  } catch (e) {
    parseFailed = true;
    warn?.(`[disk] hub 配置 JSON 解析失败(${(e as Error).message}),磁盘水位回落默认 ${DEFAULT_DISK_MIN_GB}GB`);
  }
  // 数值口径(缺省/非数字/<=0)统一走 core 的 resolveDiskMinGB,与 reconciler / 上传闸门同源。
  const { gb, source } = parseFailed ? { gb: DEFAULT_DISK_MIN_GB, source: "默认" as const } : resolveDiskMinGB(raw, warn);
  return { bytes: gb > 0 ? gb * 1e9 : 0, source };
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
  private readonly localSuppressedIds?: () => ReadonlySet<number>;
  private readonly freeBytes?: () => number | null;
  private readonly diskWatermarkBytes: number;
  /** 已因低水位拒绝启动而告警过的任务 id(回升后复位,避免每 tick 刷屏)。 */
  private readonly diskRefused = new Set<number>();

  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping ticks (a slow start/stop spanning intervals). */
  private ticking = false;
  private stopped = false;
  /** taskIds already warned about overrunning into a fresh window (dedupe the log). */
  private readonly warnedReentry = new Set<number>();
  /** 边录边传漂移:任务 id → 已连续空闲的 tick 数(录制中/排空中/无漂移即清零)。 */
  private readonly driftIdle = new Map<number, number>();
  /** 漂移但正在录制/排空而暂缓重启的任务(只在首次告警,漂移消失后复位)。 */
  private readonly warnedDrift = new Set<number>();
  /** 因磁盘低水位暂缓漂移重启而告警过的任务(同上,避免刷屏)。 */
  private readonly warnedDriftDisk = new Set<number>();

  constructor(store: TaskStore, manager: TaskManager, opts: DaemonOpts = {}) {
    this.store = store;
    this.manager = manager;
    this.intervalMs = opts.intervalMs ?? 60_000;
    this.now = opts.now ?? ((): Date => new Date());
    this.log = opts.log ?? ((m): void => console.log(m));
    this.localSuppressedIds = opts.localSuppressedIds;
    this.freeBytes = opts.freeBytes;
    this.diskWatermarkBytes = Math.max(0, opts.diskWatermarkBytes ?? 0);
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
      const suppressed = this.localSuppressedIds?.() ?? new Set<number>();
      let tasks = this.store.listTasks();
      const active = new Set(this.manager.runningIds());
      // 被抑制但还在本机跑 → 硬停(不走 drain:换节点语义是让位给远端,drain 会让两端同场重复录制)。
      for (const id of active) {
        if (!suppressed.has(id)) continue;
        const t = this.store.getTask(id);
        this.log(
          `[scheduler] ⏹ 任务 id=${id}（${t?.name ?? t?.room ?? id}）已由 hub 规则切到其他节点录制,本机停止(源任务仅作配置模板)`,
        );
        await this.manager.stop(id);
      }
      tasks = tasks.filter((t) => !suppressed.has(t.id));
      const { start, stop } = decide(tasks, this.now(), active);
      for (const id of stop) {
        // GRACEFUL stop at window-end: never cut a live broadcast. The recorder
        // drains (stops looking for new streams) and exits when the current one
        // ends naturally. Idempotent → safe to re-issue every tick while drained.
        await this.manager.stopGraceful(id);
      }
      // 磁盘低水位闸门(T-33 不变量 6):剩余低于水位 → **拒绝启动新任务**,绝不用「删未确认源」
      // 腾空间。**只拦新开一场**;已在录的当前场不受影响(它们的 stop 已在上面按窗口处理)。
      const free = this.freeBytes?.() ?? null;
      const refuseStart = free != null && shouldRefuseNewRecording(free, this.diskWatermarkBytes);
      for (const id of start) {
        const t = tasks.find((x) => x.id === id);
        if (refuseStart) {
          // 同一任务只在首次拒绝时告警(回升后复位),避免每 tick 刷屏。
          if (!this.diskRefused.has(id)) {
            this.diskRefused.add(id);
            this.log(
              `[scheduler] ⛔ 磁盘剩余 ${(free! / 1e9).toFixed(1)}GB 低于水位 ${(this.diskWatermarkBytes / 1e9).toFixed(1)}GB,` +
                `拒绝启动新任务 id=${id}${t ? `（${t.name ?? t.room}）` : ""}（已在录的场不受影响;清理/上传删源后自动恢复）`,
            );
          }
          continue;
        }
        this.diskRefused.delete(id);
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

      await this.reconcileRollingDrift(tasks, refuseStart);
    } catch (err) {
      this.log(`[scheduler] tick 出错: ${String(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 边录边传漂移收敛(issue #89):`--rolling-upload` 是子进程启动参数,规则/同步改了库里的生效值后,
   * 常驻进程并不知道(曾导致「界面显示生效、实际从没传」)。这里每 tick 比对「spawn 时带的 vs 库里现值」:
   *   - 在录/排空中:**绝不重启**,只告警一次(视图同时标「待重启生效」),等本场自然收播;
   *   - 空闲且连续 ≥ {@link ROLLING_DRIFT_IDLE_TICKS} 个 tick:停掉再按现值拉起(拉起前再过一遍磁盘低水位闸门);
   *   - 只处理「启用且在窗口内」的任务:窗口外的由上面的 stopGraceful 收尾,停用的不该被拉起。
   * 两个方向都收敛:关掉边录边传(如规则改多节点)后旧进程若继续按段上传,会绕过重复投稿闸门。
   */
  private async reconcileRollingDrift(tasks: Task[], refuseStart: boolean): Promise<void> {
    const nowMin = nowMinutesLocal(this.now());
    for (const t of tasks) {
      const st = this.manager.rollingStatus(t.id);
      if (!st || !st.drift) {
        this.driftIdle.delete(t.id);
        this.warnedDrift.delete(t.id);
        this.warnedDriftDisk.delete(t.id);
        continue;
      }
      if (!t.enabled || !inWindow(nowMin, t.scheduleStart, t.scheduleEnd)) continue;
      const label = `${t.name ?? t.room}`;
      const change = `边录边传生效值已变(进程带 ${st.applied ? "开" : "关"} → 现值 ${st.desired ? "开" : "关"})`;
      if (this.manager.isRecording(t.id) || this.manager.isDraining(t.id)) {
        this.driftIdle.delete(t.id);
        if (!this.warnedDrift.has(t.id)) {
          this.warnedDrift.add(t.id);
          this.log(`[scheduler] ⏳ 任务 id=${t.id}（${label}）${change},正在录制/排空,本场结束后自动重启生效(不腰斩直播)`);
        }
        continue;
      }
      const idle = (this.driftIdle.get(t.id) ?? 0) + 1;
      this.driftIdle.set(t.id, idle);
      if (idle < ROLLING_DRIFT_IDLE_TICKS) continue;
      if (refuseStart) {
        if (!this.warnedDriftDisk.has(t.id)) {
          this.warnedDriftDisk.add(t.id);
          this.log(`[scheduler] ⛔ 任务 id=${t.id}（${label}）${change},但磁盘低于水位,暂缓重启(回升后自动应用)`);
        }
        continue;
      }
      this.driftIdle.delete(t.id);
      this.warnedDriftDisk.delete(t.id);
      // stop 可能等到子进程退出;期间若收到关停信号(stopped),绝不能再拉起新进程(stopAll 已取过快照,管不到它)。
      if (await this.manager.stopIdleForConfig(t.id, change) && !this.stopped) this.manager.start(t.id);
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
