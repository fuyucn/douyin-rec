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
import { type Task, type TaskStore } from "./store.js";
import { platformForRoom, sanitizeNotifyContext, type NotifyContext, type OutputFormat } from "@drec/core";
import { resolveTaskStreamCookies } from "./stream-cookies.js";
import type { Spawner } from "./process/spawner.js";
import type { RecorderProcess, ExitInfo } from "./process/recorder-process.js";
import { TaskLogStore } from "@drec/observability";
import { preflightManagedZeroDiskTask, type ZeroDiskPreflight } from "./zero-disk-node.js";

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
  /**
   * 每次 spawn 子进程前调用(同步,抛错只记日志不拦启动)。边录边传 S3 兜底:起录时对本机任务现算一次
   * 生效值,即便同步 tick 还没跑到(规则刚删/刚停用)也不会按陈旧的 true 起 `--rolling-upload 1`。
   */
  beforeSpawn?: (taskId: number) => void;
  /**
   * 节点侧原地替换(issue #137)的**唯一判定点**:spawn 前按任务现状算出生效的输出格式(见
   * `resolveNodeOutputFormat`)。不注入 = 恒 `original`(不替换,行为不变)。
   * 规则之后才绑定的任务:已在跑的进程不受影响,下一次 spawn 起才按新判定。
   */
  nodeOutputFormat?: (task: Task) => OutputFormat;
  /**
   * Pre-spawn verification for hub-managed zero-disk tasks (issue #331): delivered metadata present,
   * node login found, node account equals the master-configured one. Defaults to the real check;
   * tests inject a fake. A refusal never spawns (no silent fallback to defaults).
   */
  zeroDiskPreflight?: (task: Task) => ZeroDiskPreflight;
  /** Respawn a process that exits UNEXPECTEDLY (crash). Default false. */
  autoRestart?: boolean;
  /** Delay before a restart respawn, ms. Default 5000. */
  restartDelayMs?: number;
  /** Max consecutive auto-restarts per task before giving up. Default 5. */
  maxRestarts?: number;
  /**
   * After restarts are exhausted, how long the daemon must leave the task alone before starting
   * it again (default 10 min). Without it the daemon re-started a given-up task on its next tick
   * (~20s later), so "give up" never happened and a crash loop ran forever (issue #308).
   */
  giveUpCooldownMs?: number;
  /** 任务崩溃重启耗尽、彻底放弃时回调(serve 接到 → 发告警 webhook)。 */
  onTaskDown?: (taskId: number, reason: string) => void;
  /**
   * 录制状态变化回调(T17 → HubWatch.notifyChanged)。
   *
   * 为什么录制状态要主动通知:HubWatch 的指纹只覆盖 **sync 台账**,而「开播/收播」这件事
   * 在台账里可能毫无变化(后处理还没开始)→ 指纹不变 → SSE 不推 → 房间页在最该刷新的
   * 几秒里是陈旧的。录制状态住在 tasks 表 / 本类内存里,指纹看不见,只能由状态变更方喊一声。
   *
   * 只在**用户可见的状态**变化时触发(起停/开播/收播/崩溃),**不是**每条日志都触发 ——
   * 否则一次录制会每秒推一次,退化成轮询还多付 SSE 帧的钱。
   */
  onRecordingStateChanged?: (taskId: number) => void;
  /** 子进程结构化告警(@@DREC_ALERT@@)回调(serve 接到 → EventCenter 站内 toast;webhook 子进程已发)。 */
  onAlert?: (taskId: number, stage: string, message: string, ctx?: NotifyContext) => void;
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
  private readonly giveUpCooldownMs: number;
  private readonly onTaskDown?: (taskId: number, reason: string) => void;
  private readonly onRecordingStateChanged?: (taskId: number) => void;
  private readonly onAlert?: (taskId: number, stage: string, message: string, ctx?: NotifyContext) => void;
  private readonly beforeSpawn?: (taskId: number) => void;
  private readonly nodeOutputFormat?: (task: Task) => OutputFormat;
  private readonly zeroDiskPreflight: (task: Task) => ZeroDiskPreflight;
  private readonly log: (m: string) => void;
  private readonly schedule: (cb: () => void, ms: number) => void;
  private readonly logStore: TaskLogStore;
  private readonly clock: () => number;

  /** taskId → live RecorderProcess. */
  private readonly procs = new Map<number, RecorderProcess>();
  /** taskId → consecutive auto-restart count (reset on explicit start/stop). */
  private readonly restarts = new Map<number, number>();
  /** taskId → epoch ms the restart budget ran out (cleared by an explicit start or stop). */
  private readonly gaveUpAt = new Map<number, number>();
  /** taskIds currently DRAINING (window ended, waiting for the broadcast to end). */
  private readonly draining = new Set<number>();
  /** taskId → epoch ms the current run started; present iff running. */
  private readonly startedAt = new Map<number, number>();
  /** taskId → 抓取到的主播名（从子进程 `[主播] X` 日志解析；供 UI 显示）。 */
  private readonly anchorNames = new Map<number, string>();
  /** taskId → 是否真正在录视频（从 `[状态] 录制中/等待开播` 解析）。区分「录制中」vs「等待开播中」。 */
  private readonly recordingPhase = new Map<number, boolean>();
  /**
   * taskId → 子进程 **spawn 时** 带的边录边传值(issue #89)。`--rolling-upload` 是启动参数,进程常驻期间不会变;
   * 库里的 `rollingEffective` 之后被 hub 同步/规则编辑改了,在跑的进程并不知道 → 必须记下「实际生效的」才能比对漂移。
   * 仅在跑时存在。
   */
  private readonly appliedRolling = new Map<number, boolean>();
  /**
   * taskIds whose start-failure alert already fired. The daemon retries every tick, so without
   * this a persistent failure (e.g. credential file unwritable) alerts once a minute. Cleared on
   * the next spawn that does not throw so a later relapse alerts again; async spawn errors
   * (ENOENT/EACCES via 'error') are crashes and go through handleExit instead.
   */
  private readonly startFailAlerted = new Set<number>();

  constructor(store: TaskStore, spawner: Spawner, opts: TaskManagerOpts = {}) {
    this.store = store;
    this.spawner = spawner;
    this.beforeSpawn = opts.beforeSpawn;
    this.nodeOutputFormat = opts.nodeOutputFormat;
    this.zeroDiskPreflight = opts.zeroDiskPreflight ?? preflightManagedZeroDiskTask;
    this.autoRestart = opts.autoRestart ?? false;
    this.restartDelayMs = opts.restartDelayMs ?? 5_000;
    this.maxRestarts = opts.maxRestarts ?? 5;
    this.giveUpCooldownMs = Math.max(0, opts.giveUpCooldownMs ?? 10 * 60_000);
    this.onTaskDown = opts.onTaskDown;
    this.onRecordingStateChanged = opts.onRecordingStateChanged;
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

  /**
   * 通知外部「录制状态变了」。回调本身抛错不能影响录制主流程(它是**旁路**信号),
   * 所以吞掉异常但打一行日志 —— 不静默,也不让观测链路把录制搞挂。
   */
  private notifyRecordingState(taskId: number): void {
    if (!this.onRecordingStateChanged) return;
    try {
      this.onRecordingStateChanged(taskId);
    } catch (e) {
      this.log(`[task_manager] notifyRecordingState(id=${taskId}) 出错(忽略): ${(e as Error)?.message ?? e}`);
    }
  }

  /** 是否真正在录视频（true=录制中；false=进程在跑但等待开播/重连中）。 */
  isRecording(taskId: number): boolean {
    return this.recordingPhase.get(taskId) ?? false;
  }

  /**
   * 边录边传「实际生效 vs 期望」(issue #89)。**不在跑 → null**(下次 spawn 自然取最新值,无漂移可言)。
   * `applied` = 子进程 spawn 时带的值;`desired` = 库里当前的 `rollingEffective`(与 buildRecordArgs 同一来源);
   * `drift` = 两者不一致,即「库里说生效但进程没带参数」(或反过来)。
   */
  rollingStatus(taskId: number): { applied: boolean; desired: boolean; drift: boolean } | null {
    const applied = this.appliedRolling.get(taskId);
    if (applied === undefined || !this.procs.has(taskId)) return null;
    const desired = !!this.store.getTask(taskId)?.rollingEffective;
    return { applied, desired, drift: applied !== desired };
  }

  /**
   * 为应用新的启动参数而**停掉**一个空闲任务(issue #89)。只在「进程在跑、没在录、没在排空」时才动手,
   * 否则返回 false 且什么都不做 —— 绝不腰斩直播。**只停不起**:重新拉起由调用方(daemon)按
   * 启用/窗口/磁盘闸门/hub 抑制统一决定,避免这里绕过那些判定把已停用的任务又起来。
   */
  async stopIdleForConfig(taskId: number, reason: string): Promise<boolean> {
    if (!this.procs.has(taskId) || this.isRecording(taskId) || this.draining.has(taskId)) return false;
    this.logTask(taskId, `[task_manager] ↻ 任务 id=${taskId} ${reason},当前空闲,重启以应用新参数`);
    await this.stop(taskId);
    return true;
  }

  /**
   * Remaining give-up cooldown in ms (0 = may start). The daemon checks this before its
   * automatic start; an explicit `start()` (user action) ignores and clears it.
   */
  restartCooldownRemainingMs(taskId: number): number {
    const at = this.gaveUpAt.get(taskId);
    if (at === undefined) return 0;
    const left = at + this.giveUpCooldownMs - this.clock();
    if (left > 0) return left;
    this.gaveUpAt.delete(taskId);
    return 0;
  }

  /** Spawn the task if not already running. Returns false if running/missing. */
  start(taskId: number): boolean {
    if (this.procs.has(taskId)) return false;
    this.gaveUpAt.delete(taskId);
    const task = this.store.getTask(taskId);
    if (!task) {
      this.log(`[task_manager] start: 未找到任务 id=${taskId}`);
      return false;
    }
    // 0 落盘直传会为**每个启动的进程**建一个稿件(状态文件按 outDir 隔离,彼此不知道对方存在)。
    // 同一房间被两个任务同时录 → 两个内容重复的稿件,而 B 站没有删稿 API,代价不可逆。
    // 这是配置错误,必须在启动前挡掉,而不是等用户看到两个稿件。
    if (task.streamUpload) {
      const clash = [...this.procs.keys()].find((id) => {
        const other = this.store.getTask(id);
        return other?.streamUpload === true && this.sameRoom(other, task);
      });
      if (clash !== undefined) {
        const other = this.store.getTask(clash);
        this.log(
          `[task_manager] 拒绝启动 id=${taskId}:同一房间已有 0 落盘任务 id=${clash}` +
          `(${other?.name ?? other?.room})在录,同时录会产出两个重复稿件且无法删除`,
        );
        return false;
      }
    }
    this.restarts.set(taskId, 0);
    if (!this.trySpawn(taskId)) return false;
    this.store.setStatus(taskId, "running");
    this.notifyRecordingState(taskId);
    this.logTask(taskId, `[task_manager] ▶ 启动任务 id=${taskId}（${task.name ?? task.room}）`);
    return true;
  }

  /** 两个任务是否录同一房间(按平台 + 房间 slug,不用原始 URL 字符串比较)。 */
  private sameRoom(a: { room: string; platform?: string }, b: { room: string; platform?: string }): boolean {
    const norm = (t: { room: string; platform?: string }): string => {
      const p = platformForRoom(t.room);
      return `${p.id}:${p.extractRoomSlug(t.room)}`;
    };
    return norm(a) === norm(b);
  }

  /** 正在硬停的任务 → 共用同一个 promise(重复调用不重复发信号)。 */
  private readonly stopping = new Map<number, Promise<void>>();

  /** Hard stop; marks the exit expected; status → 'stopped'. Overrides a drain. */
  stop(taskId: number): Promise<void> {
    const inflight = this.stopping.get(taskId);
    if (inflight) return inflight;
    const p = this.stopInner(taskId).finally(() => { this.stopping.delete(taskId); });
    this.stopping.set(taskId, p);
    return p;
  }

  private async stopInner(taskId: number): Promise<void> {
    const proc = this.procs.get(taskId);
    // Reset restart budget so an in-flight restart timer becomes a no-op.
    this.restarts.delete(taskId);
    this.gaveUpAt.delete(taskId);
    this.draining.delete(taskId);
    if (!proc) return;
    this.logTask(taskId, `[task_manager] ■ 停止任务 id=${taskId}`);
    await proc.stop();
    // onExit (expected) handler sets status + clears the map entry.
  }

  /**
   * 发起硬停但**不等待退出**(边录边传任务的停止要给末段上传最长约 10 分钟,不能让 daemon tick /
   * hub 同步 tick 同步等这么久)。退出由 onExit 收尾;失败只记日志。重复调用共用同一次停止。
   */
  requestStop(taskId: number): void {
    this.stop(taskId).catch((e) => {
      this.logTask(taskId, `[task_manager] 停止任务失败: ${(e as Error)?.message ?? e}`);
    });
  }

  /** 该任务是否正在硬停收尾(已发停止信号、进程尚未退出)。 */
  isStopping(taskId: number): boolean {
    return this.stopping.has(taskId);
  }

  /**
   * 硬停并最多等 `ms`:返回 true = 已退出,false = 超时仍在收尾(进程仍在停止中,不再回滚)。
   * 供同步 API(Web 停止 / 远端 `_apply-tasks` 硬停通道)用:普通任务几秒内退出,行为与之前一致;
   * rolling 任务不会把请求挂满整个上传宽限。
   */
  async stopWithin(taskId: number, ms: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      this.stop(taskId).then(() => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(true), ms); }),
    ]);
    if (timer) clearTimeout(timer);
    return !timedOut;
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
    // 硬停在途(例如 rolling 任务在给末段上传留宽限):硬停优先,不能再转成排空——否则 status 会被改成 draining、
    // 日志写成「自然收播」,且 daemon tick 会重新卡到进程退出。
    if (this.stopping.has(taskId)) return;
    if (this.draining.has(taskId)) return;   // already draining — no-op
    this.draining.add(taskId);
    this.restarts.delete(taskId);            // a drained natural exit isn't a crash
    this.store.setStatus(taskId, "draining");
    this.notifyRecordingState(taskId);
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

  /**
   * spawnFor 的失败护栏:spawn 前置步骤(如写 0600 登录凭证文件)抛错时,**明确报错**——
   * 置 error、写任务日志、走 onTaskDown 告警,不留「看似在跑」的状态,也不让异常逃出重启定时器。
   */
  private trySpawn(taskId: number): boolean {
    try {
      this.spawnFor(taskId);
      this.startFailAlerted.delete(taskId);
      return true;
    } catch (e) {
      const reason = `启动失败:${(e as Error)?.message ?? e}`;
      this.restarts.delete(taskId);
      this.store.setStatus(taskId, "error");
      this.notifyRecordingState(taskId);
      this.logTask(taskId, `[task_manager] ✗ 任务 id=${taskId} ${reason}`);
      if (!this.startFailAlerted.has(taskId)) {
        this.startFailAlerted.add(taskId);
        this.onTaskDown?.(taskId, reason);
      }
      return false;
    }
  }

  /** Spawn a fresh process for the task and wire its exit handling. */
  private spawnFor(taskId: number): void {
    try {
      this.beforeSpawn?.(taskId);
    } catch (e) {
      this.logTask(taskId, `[task_manager] beforeSpawn 失败(忽略,按库内现值起录): ${(e as Error)?.message ?? e}`);
    }
    const task = this.store.getTask(taskId)!;
    // A hub-managed node must never start a zero-disk upload from defaults: the master-delivered
    // metadata and the account check are mandatory. Throwing routes through trySpawn, which marks the
    // task `error`, logs the reason and alerts once (no restart loop, nothing is uploaded).
    if (task.streamUpload && task.managedBy === "hub") {
      const pre = this.zeroDiskPreflight(task);
      if (!pre.ok) throw new Error(`0 落盘拒绝启动 [${pre.refusal.code}]: ${pre.refusal.message}`);
    }
    // Platform-aware cookie resolution, shared with buildSessionForTask.
    const effective = {
      ...task,
      cookies: resolveTaskStreamCookies(task, this.store),
      // 交给 buildRecordArgs 的是判定后的生效值,不是库里所选值(有规则 / 受管 / rolling 时被压回 original)。
      outputFormat: this.nodeOutputFormat?.(task) ?? "original",
    };
    const proc = this.spawner.spawn(effective);
    this.procs.set(taskId, proc);
    this.startedAt.set(taskId, this.clock());
    this.appliedRolling.set(taskId, !!task.rollingEffective);
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
          const a = JSON.parse(alert[1]) as { stage?: string; message?: string; ctx?: unknown };
          // ctx comes from a child that may be older or newer: only known string fields are forwarded.
          const ctx = sanitizeNotifyContext(a.ctx);
          this.onAlert?.(taskId, a.stage ?? "error", a.message ?? "", ctx);
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
      // 开播/等待开播是用户最关心的一跳:只在**真的翻转**时通知(子进程会重复打这两行)。
      if (msg.includes("[状态] 录制中")) {
        if (!this.recordingPhase.get(taskId)) this.notifyRecordingState(taskId);
        this.recordingPhase.set(taskId, true);
      } else if (msg.includes("[状态] 等待开播")) {
        if (this.recordingPhase.get(taskId)) this.notifyRecordingState(taskId);
        this.recordingPhase.set(taskId, false);
      }
    });
    proc.onExit((info) => this.handleExit(taskId, info));
    try {
      proc.start();
    } catch (e) {
      // Synchronous start failure: drop the tracking entries, otherwise start() sees the task as
      // running forever and refuses to retry until serve restarts.
      if (this.procs.get(taskId) === proc) {
        this.procs.delete(taskId);
        this.startedAt.delete(taskId);
        this.recordingPhase.delete(taskId);
        this.appliedRolling.delete(taskId);
      }
      throw e;
    }
  }

  private handleExit(taskId: number, info: ExitInfo): void {
    // Only act if this process is still the one we track (guards against a
    // late exit from an already-replaced/stopped process).
    this.procs.delete(taskId);
    this.startedAt.delete(taskId);
    this.recordingPhase.delete(taskId);
    this.appliedRolling.delete(taskId);
    const wasDraining = this.draining.delete(taskId);

    // A zero-disk upload run replaces the file recorder and owns the whole process, so it ends
    // on its own once its parts are delivered and exits 0 without anyone marking the exit
    // "expected"; treating that as a crash respawned it in a tight loop (measured in a real
    // container: "异常退出 (code=0)" then restart #1).
    // Exit 0 means the run ended normally: parts delivered, or no part because it was stopped
    // while waiting for a broadcast / the room dropped right after going live (`idle`, #308).
    // The pump no longer gives up while offline, so a non-zero exit here is a real failure and
    // gets retried/alerted (bounded by the restart budget and the daemon's give-up cooldown).
    // Only claimed for stream-upload tasks: a plain recorder exits on a stop signal, and its
    // exit code is not its own verdict on whether it did what it was started to do.
    const zeroDiskFinalized = info.code === 0
      && !info.expected
      && this.store.getTask(taskId)?.streamUpload === true;

    if (info.expected || zeroDiskFinalized) {
      this.store.setStatus(taskId, "stopped");
      this.notifyRecordingState(taskId);
      this.logTask(
        taskId,
        wasDraining
          ? `[task_manager] ✓ 任务 id=${taskId} 直播自然收播，排空完成，已停止`
          : zeroDiskFinalized
            ? `[task_manager] ✓ 任务 id=${taskId} 0 落盘直传已自行收尾(exit 0),已停止`
            : `[task_manager] ✓ 任务 id=${taskId} 已正常停止`,
      );
      return;
    }

    // Unexpected exit (crash).
    this.store.setStatus(taskId, "error");
    this.notifyRecordingState(taskId);
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
      this.gaveUpAt.set(taskId, this.clock());
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
      if (!this.trySpawn(taskId)) return;
      this.store.setStatus(taskId, "running");
    }, this.restartDelayMs);
  }
}
