import { EndDebouncer } from "./trigger.js";

export interface HubDeps {
  tasks: () => { id: number }[];
  isRecording: (id: number) => boolean;
  reconcileAll: () => Promise<void>;
  settleMs: number;
  pollMs: number;
  reconcileIntervalMs: number;
  /** 周期任务同步(把 master 期望任务下发到各 worker)。 */
  syncTasks?: () => Promise<void>;
  /** 任务同步周期(ms),默认 60_000。 */
  syncIntervalMs?: number;
}

/**
 * startHub — pure-wiring function that polls isRecording for each task and
 * triggers reconcileAll after settle period once recording stops.
 * Also fires reconcileAll periodically as a safety-net.
 * Returns a cleanup function that clears both intervals.
 */
export function startHub(deps: HubDeps): () => void {
  const debouncers = new Map<number, EndDebouncer>();

  // 并发守卫:reconcileAll 含 settle 等待 + 合并/烧录,耗时常远超 reconcileIntervalMs。
  // 不守卫则「周期 tick」与「结束 trigger」会叠起几十个并发 reconcile,每个都对每个租户
  // listInventory(ssh _inventory 起一个远端 node 进程)→ 打爆两端 fork
  // (实测 docker 容器 279 进程、VPS fork/exec 失败、ssh 接不进)。
  // 守卫:已有一轮在跑就跳过本次(下一 tick 再补),trigger 与周期共用同一把锁。
  let running = false;
  const runGuarded = async (fn?: () => Promise<void>): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await (fn ? fn() : deps.reconcileAll());
    } catch (e) {
      console.error("[hub] reconcileAll 失败:", e);
    } finally {
      running = false;
    }
  };

  // 任务同步独立于 reconcile 锁:reconcile 的 settle 会等远端收播,若同步被同一把锁挡住,
  // 「停止指令发不出去 → 远端一直录 → settle 一直超时」会永久互锁。同步本身很轻,只防自重入。
  let syncRunning = false;
  const runSync = async (): Promise<void> => {
    if (syncRunning) return;
    syncRunning = true;
    try {
      await deps.syncTasks?.();
    } catch (e) {
      console.error("[hub] 任务同步失败:", e);
    } finally {
      syncRunning = false;
    }
  };

  const pollInterval = setInterval(() => {
    for (const t of deps.tasks()) {
      let d = debouncers.get(t.id);
      if (!d) {
        d = new EndDebouncer(deps.settleMs, () => void runGuarded());
        debouncers.set(t.id, d);
      }
      d.observe(deps.isRecording(t.id));
    }
  }, deps.pollMs);

  const reconcileInterval = setInterval(() => {
    void runGuarded();
  }, deps.reconcileIntervalMs);

  const syncInterval = deps.syncTasks
    ? setInterval(() => {
        void runSync();
      }, deps.syncIntervalMs ?? 60_000)
    : null;
  // 启动即对账一次(不等第一个 tick):新增/改动的绑定任务尽快下发。
  if (deps.syncTasks) void runSync();

  return () => {
    clearInterval(pollInterval);
    clearInterval(reconcileInterval);
    if (syncInterval) clearInterval(syncInterval);
  };
}
