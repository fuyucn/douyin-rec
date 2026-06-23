import { describe, it, expect, beforeEach } from "vitest";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type {
  RecorderProcess,
  ExitInfo,
} from "../../packages/app/src/process/recorder-process.js";
import { TaskStore } from "../../packages/app/src/store.js";
import { TaskLogStore } from "../../packages/app/src/task-logs.js";

/** Controllable fake: tests drive start/stop/exit explicitly. */
class FakeRecorderProcess implements RecorderProcess {
  readonly pid = 1234;
  started = false;
  stopped = false;
  gracefulCount = 0;
  private listeners: ((i: ExitInfo) => void)[] = [];

  constructor(readonly taskId: number) {}

  start(): void {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Real ChildRecorderProcess resolves stop() after the child exits; emulate
    // by firing an expected exit synchronously.
    this.emitExit({ code: 0, signal: null, expected: true });
  }

  /**
   * Graceful drain: real impl sends SIGUSR2 and resolves only when the child
   * exits (broadcast ended). Here we just record the call and DON'T auto-exit,
   * so tests can assert the draining state, then drive endBroadcast().
   */
  async stopGraceful(): Promise<void> {
    this.gracefulCount++;
  }

  /** Test hook: simulate the drained broadcast ending → subprocess exits. */
  endBroadcast(): void {
    this.emitExit({ code: 0, signal: null, expected: true });
  }

  onExit(cb: (i: ExitInfo) => void): void {
    this.listeners.push(cb);
  }

  readonly logListeners: ((m: string) => void)[] = [];
  onLog(cb: (m: string) => void): void {
    this.logListeners.push(cb);
  }

  /** Test hook: emit a log line to subscribers. */
  emitLog(msg: string): void {
    for (const cb of this.logListeners) cb(msg);
  }

  /** Test hook: fire the exit event. */
  emitExit(info: ExitInfo): void {
    for (const cb of this.listeners) cb(info);
  }
}

class MockSpawner implements Spawner {
  readonly spawned: FakeRecorderProcess[] = [];
  spawn(task: { id: number }): RecorderProcess {
    const p = new FakeRecorderProcess(task.id);
    this.spawned.push(p);
    return p;
  }
  /** Most recent process for a given task id. */
  last(taskId: number): FakeRecorderProcess {
    const matches = this.spawned.filter((p) => p.taskId === taskId);
    return matches[matches.length - 1];
  }
}

let store: TaskStore;

beforeEach(() => {
  store = new TaskStore(":memory:");
});

function addTask(): number {
  return store.addTask({ room: "12345" }).id;
}

describe("TaskManager", () => {
  it("start spawns, marks running, isRunning true", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });

    expect(mgr.start(id)).toBe(true);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.last(id).started).toBe(true);
    expect(mgr.isRunning(id)).toBe(true);
    expect(mgr.runningIds()).toEqual([id]);
    expect(store.getTask(id)!.status).toBe("running");
  });

  it("double-start returns false and does not respawn", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    expect(mgr.start(id)).toBe(true);
    expect(mgr.start(id)).toBe(false);
    expect(spawner.spawned).toHaveLength(1);
  });

  it("start returns false for a missing task", () => {
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    expect(mgr.start(9999)).toBe(false);
    expect(spawner.spawned).toHaveLength(0);
  });

  it("stop → expected exit → status stopped, not running", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    mgr.start(id);
    await mgr.stop(id);
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
    expect(spawner.last(id).stopped).toBe(true);
  });

  it("stopGraceful → status draining, still running until broadcast ends", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    mgr.start(id);

    await mgr.stopGraceful(id);
    expect(mgr.isDraining(id)).toBe(true);
    expect(mgr.isRunning(id)).toBe(true);                 // NOT cut off
    expect(store.getTask(id)!.status).toBe("draining");
    expect(spawner.last(id).gracefulCount).toBe(1);

    await mgr.stopGraceful(id);                            // idempotent
    expect(spawner.last(id).gracefulCount).toBe(1);

    spawner.last(id).endBroadcast();                       // natural end → exit
    expect(mgr.isRunning(id)).toBe(false);
    expect(mgr.isDraining(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
  });

  it("hard stop() during a drain overrides it (clears draining)", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    mgr.start(id);
    await mgr.stopGraceful(id);
    expect(mgr.isDraining(id)).toBe(true);

    await mgr.stop(id);                                     // user hits 停止
    expect(mgr.isDraining(id)).toBe(false);
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
  });

  it("unexpected exit with autoRestart respawns and goes back to running", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      restartDelayMs: 0,
      // synchronous scheduler → restart happens inline
      schedule: (cb) => cb(),
      log: () => {},
    });
    mgr.start(id);
    // simulate a crash
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false });

    expect(spawner.spawned).toHaveLength(2); // respawned
    expect(mgr.isRunning(id)).toBe(true);
    expect(store.getTask(id)!.status).toBe("running");
  });

  it("unexpected exit WITHOUT autoRestart → status error, not running", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    mgr.start(id);
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false });
    expect(spawner.spawned).toHaveLength(1);
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("error");
  });

  it("respects maxRestarts cap", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      maxRestarts: 2,
      restartDelayMs: 0,
      schedule: (cb) => cb(),
      log: () => {},
    });
    mgr.start(id); // spawn #1
    // crash repeatedly; each crash uses the latest spawned proc
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // restart #1 → spawn #2
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // restart #2 → spawn #3
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // exceeds cap → no spawn

    expect(spawner.spawned).toHaveLength(3); // initial + 2 restarts
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("error");
  });

  it("fires onTaskDown once when restarts are exhausted (for alerting)", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const down: Array<{ id: number; reason: string }> = [];
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      maxRestarts: 1,
      restartDelayMs: 0,
      schedule: (cb) => cb(),
      log: () => {},
      onTaskDown: (taskId, reason) => down.push({ id: taskId, reason }),
    });
    mgr.start(id); // spawn #1
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // restart #1 → spawn #2
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // exceeds cap → onTaskDown
    expect(down).toHaveLength(1);
    expect(down[0].id).toBe(id);
    expect(down[0].reason).toContain("放弃");
  });

  it("解析子进程 @@DREC_ALERT@@ 结构化告警 → onAlert,且不进日志", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const logStore = new TaskLogStore();
    const alerts: Array<{ id: number; stage: string; message: string }> = [];
    const mgr = new TaskManager(store, spawner, {
      log: () => {},
      logStore,
      onAlert: (taskId, stage, message) => alerts.push({ id: taskId, stage, message }),
    });
    mgr.start(id);
    spawner.last(id).emitLog(`@@DREC_ALERT@@${JSON.stringify({ stage: "取流", message: "签名失效?" })}`);
    spawner.last(id).emitLog("普通日志一行");
    expect(alerts).toEqual([{ id, stage: "取流", message: "签名失效?" }]);
    // 告警行不入日志环;普通行入。
    const lines = logStore.get(id);
    expect(lines.some((l) => l.includes("@@DREC_ALERT@@"))).toBe(false);
    expect(lines.some((l) => l.includes("普通日志一行"))).toBe(true);
  });

  it("explicit stop cancels a pending restart budget", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    // Defer the scheduled restart so we can stop() before it fires.
    const deferred: (() => void)[] = [];
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      restartDelayMs: 100,
      schedule: (cb) => void deferred.push(cb),
      log: () => {},
    });
    mgr.start(id);
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false });
    // restart scheduled but not fired
    await mgr.stop(id); // clears restart budget; no live proc to stop
    deferred.forEach((cb) => cb()); // fire pending restart → should no-op
    expect(spawner.spawned).toHaveLength(1);
    expect(mgr.isRunning(id)).toBe(false);
  });

  it("captures lifecycle + child logs and tracks runtime", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    let t = 1000;
    const mgr = new TaskManager(store, spawner, { log: () => {}, clock: () => t });

    expect(mgr.getRuntime(id)).toEqual({ running: false, startedAt: null, elapsedMs: null, anchorName: null });

    mgr.start(id);
    // startedAt captured at clock()=1000; lifecycle line appended
    expect(mgr.getLogs(id).some((l) => l.includes("▶ 启动"))).toBe(true);

    // child output is fanned into the ring buffer
    spawner.last(id).emitLog("[task 1] hello world");
    expect(mgr.getLogs(id).some((l) => l.includes("hello world"))).toBe(true);

    // runtime: running, startedAt=1000, elapsed = now - startedAt
    t = 4000;
    expect(mgr.getRuntime(id)).toEqual({ running: true, startedAt: 1000, elapsedMs: 3000, anchorName: null });

    await mgr.stop(id);
    expect(mgr.getLogs(id).some((l) => l.includes("■ 停止"))).toBe(true);
    expect(mgr.getRuntime(id)).toEqual({ running: false, startedAt: null, elapsedMs: null, anchorName: null });
  });

  it("captures anchor name from a `[主播] X` child log line", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });

    expect(mgr.getAnchorName(id)).toBeNull();
    mgr.start(id);
    spawner.last(id).emitLog("[task 1] [主播] 一勺小苏打🌙");
    expect(mgr.getAnchorName(id)).toBe("一勺小苏打🌙");
    expect(mgr.getRuntime(id).anchorName).toBe("一勺小苏打🌙");
    await mgr.stop(id);
  });

  it("tracks recording phase from `[状态]` lines (录制中 / 等待开播)", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });

    mgr.start(id);
    expect(mgr.isRecording(id)).toBe(false); // 刚启动=等待开播
    spawner.last(id).emitLog("[task 1] [状态] 录制中");
    expect(mgr.isRecording(id)).toBe(true);
    spawner.last(id).emitLog("[task 1] [状态] 等待开播"); // 断流回到等待
    expect(mgr.isRecording(id)).toBe(false);
    await mgr.stop(id);
  });

  it("stopAll stops every running task", async () => {
    const a = addTask();
    const b = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    mgr.start(a);
    mgr.start(b);
    await mgr.stopAll();
    expect(mgr.runningIds()).toEqual([]);
    expect(store.getTask(a)!.status).toBe("stopped");
    expect(store.getTask(b)!.status).toBe("stopped");
  });
});
