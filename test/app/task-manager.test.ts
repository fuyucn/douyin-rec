import { describe, it, expect, beforeEach } from "vitest";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type {
  RecorderProcess,
  ExitInfo,
} from "../../packages/app/src/process/recorder-process.js";
import { TaskStore } from "../../packages/app/src/store.js";
import { TaskLogStore } from "../../packages/observability/src/logger/ring.js";

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

function addTask(
  over: Partial<Parameters<TaskStore["addTask"]>[0]> = {},
): number {
  return store.addTask({ room: "12345", ...over }).id;
}

describe("TaskManager beforeSpawn(边录边传起录兜底)", () => {
  it("每次 spawn 前调用,且 spawner 拿到的是 hook 重算后的最新任务值", () => {
    const id = addTask();
    store.updateTask(id, { rollingEffective: true }); // 陈旧的 true
    const seen: boolean[] = [];
    const spawner: Spawner = {
      spawn: (task) => {
        seen.push((task as { rollingEffective: boolean }).rollingEffective);
        return new FakeRecorderProcess(task.id);
      },
    } as Spawner;
    const mgr = new TaskManager(store, spawner, {
      log: () => {},
      beforeSpawn: (tid) => { store.updateTask(tid, { rollingEffective: false }); },
    });
    mgr.start(id);
    expect(seen).toEqual([false]);
  });
  it("hook 抛错不拦启动", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {}, beforeSpawn: () => { throw new Error("boom"); } });
    expect(mgr.start(id)).toBe(true);
    expect(spawner.spawned).toHaveLength(1);
  });
});

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

  it("同一房间已有 0 落盘任务在录 → 第二个拒绝启动(否则产出两个无法删除的重复稿件)", () => {
    const a = addTask({ room: "https://live.douyin.com/981234", outDir: "/tmp/dupA", streamUpload: true });
    const b = addTask({ room: "https://live.douyin.com/981234", outDir: "/tmp/dupB", streamUpload: true });
    const spawner = new MockSpawner();
    const logs: string[] = [];
    const mgr = new TaskManager(store, spawner, { log: (m) => logs.push(m) });

    expect(mgr.start(a)).toBe(true);
    // 第二个同房间任务:不起进程、不报 running。
    expect(mgr.start(b)).toBe(false);
    expect(spawner.spawned).toHaveLength(1);
    expect(mgr.isRunning(b)).toBe(false);
    expect(logs.join("\n")).toContain("0 落盘");
  });

  it("不同房间的 0 落盘任务互不挡(多房间并发仍可同时录)", () => {
    const a = addTask({ room: "https://live.douyin.com/981234", outDir: "/tmp/mA", streamUpload: true });
    const b = addTask({ room: "https://live.douyin.com/981235", outDir: "/tmp/mB", streamUpload: true });
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });

    expect(mgr.start(a)).toBe(true);
    expect(mgr.start(b)).toBe(true);
    expect(spawner.spawned).toHaveLength(2);
  });

  it("普通录制任务(非 0 落盘)不受该守卫影响", () => {
    const a = addTask({ room: "https://live.douyin.com/981234", outDir: "/tmp/pA" });
    const b = addTask({ room: "https://live.douyin.com/981234", outDir: "/tmp/pB" });
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });

    expect(mgr.start(a)).toBe(true);
    expect(mgr.start(b)).toBe(true);
  });

  it("spawn 前置步骤(写凭证文件)抛错 → start 返回 false、status=error、onTaskDown 告警,不抛出", () => {
    const id = addTask();
    const down: string[] = [];
    const failing: Spawner = {
      spawn(): RecorderProcess {
        throw new Error("写入录制登录凭证文件失败(EACCES)");
      },
    };
    const mgr = new TaskManager(store, failing, {
      log: () => {},
      onTaskDown: (_id, reason) => down.push(reason),
    });
    expect(mgr.start(id)).toBe(false);
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("error");
    expect(down).toHaveLength(1);
    expect(down[0]).toContain("EACCES");
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

  it("0 落盘任务自行收尾(exit 0,预期外)→ 正常停止,不进崩溃重启循环", async () => {
    // Real container 2026-10-19: the pump replaced the file recorder and owned the process, so
    // when the stream could not be acquired after retries it exited 0 by itself. Nothing had
    // marked that exit expected, so TaskManager called it a crash and respawned in a tight loop
    // ("异常退出 (code=0)" → restart #1), each round costing another six acquisition attempts.
    const id = addTask({ room: "https://live.douyin.com/981236", streamUpload: true });
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      restartDelayMs: 0,
      schedule: (cb) => cb(),
      log: () => {},
    });
    mgr.start(id);
    spawner.last(id).emitExit({ code: 0, signal: null, expected: false });

    expect(spawner.spawned).toHaveLength(1);        // no respawn
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped"); // not "error"
  });

  it("普通录制任务 exit 0 仍按崩溃处理(不放宽到全部任务)", () => {
    // The relaxation is scoped to stream uploads: a plain recorder exits only on a stop signal,
    // so its exit code is not its own verdict and must keep resuming a genuine crash.
    const id = addTask(); // plain task
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      restartDelayMs: 0,
      schedule: (cb) => cb(),
      log: () => {},
    });
    mgr.start(id);
    spawner.last(id).emitExit({ code: 0, signal: null, expected: false });

    expect(spawner.spawned).toHaveLength(2); // still respawns
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

  it("give-up cooldown (#308): set when restarts run out, expires, cleared by an explicit start/stop", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    let now = 1_000_000;
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true, maxRestarts: 1, restartDelayMs: 0, giveUpCooldownMs: 600_000,
      schedule: (cb) => cb(), log: () => {}, clock: () => now,
    });
    mgr.start(id);
    expect(mgr.restartCooldownRemainingMs(id)).toBe(0);
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // restart #1
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // gives up
    expect(mgr.restartCooldownRemainingMs(id)).toBe(600_000);
    now += 599_999;
    expect(mgr.restartCooldownRemainingMs(id)).toBe(1);
    now += 1;
    expect(mgr.restartCooldownRemainingMs(id)).toBe(0);

    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // no-op: not tracked
    mgr.start(id);
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false });
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // gives up again
    expect(mgr.restartCooldownRemainingMs(id)).toBeGreaterThan(0);
    await mgr.stop(id); // user action clears it
    expect(mgr.restartCooldownRemainingMs(id)).toBe(0);
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

  it("告警带 ctx(#53 N4):只转发已知字符串字段;非对象丢弃;旧子进程无 ctx → undefined", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const got: unknown[] = [];
    const mgr = new TaskManager(store, spawner, { log: () => {}, onAlert: (_t, _s, _m, ctx) => got.push(ctx) });
    mgr.start(id);
    const p = spawner.last(id);
    p.emitLog(`@@DREC_ALERT@@${JSON.stringify({ stage: "弹幕", message: "m", ctx: { name: "T", platform: "douyin", bad: 1, roomSlug: 5 } })}`);
    p.emitLog(`@@DREC_ALERT@@${JSON.stringify({ stage: "弹幕", message: "m", ctx: "bogus" })}`);
    p.emitLog(`@@DREC_ALERT@@${JSON.stringify({ stage: "弹幕", message: "m", ctx: ["x"] })}`);
    p.emitLog(`@@DREC_ALERT@@${JSON.stringify({ stage: "弹幕", message: "m" })}`);
    expect(got).toEqual([{ name: "T", platform: "douyin" }, undefined, undefined, undefined]);
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

  it("tracks recording phase from `[状态]` lines (录制中 / 录制停滞 / 等待开播)", async () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });

    mgr.start(id);
    expect(mgr.isRecording(id)).toBe(false); // 刚启动=等待开播
    spawner.last(id).emitLog("[task 1] [状态] 录制中");
    expect(mgr.isRecording(id)).toBe(true);
    spawner.last(id).emitLog("[task 1] [状态] 录制停滞");
    expect(mgr.isRecording(id)).toBe(false);
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

// ── T17 录制状态变化 → notifyChanged(房间页实时化的关键一跳)──────────────────────
describe("T17 录制状态变化通知", () => {
  it("start / 退出 / 开播 / 收播各触发一次 onRecordingStateChanged", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const changed: number[] = [];
    const mgr = new TaskManager(store, spawner, { log: () => {}, onRecordingStateChanged: (tid) => changed.push(tid) });

    mgr.start(id);
    expect(changed).toEqual([id]);                 // 起播

    const proc = spawner.last(id);
    proc.emitLog("[状态] 录制中");
    expect(changed).toEqual([id, id]);             // 开播(等待→录制中)

    proc.emitLog("[状态] 录制中");                   // 重复行:不该再推
    expect(changed).toEqual([id, id]);

    proc.emitLog("[状态] 等待开播");
    expect(changed).toEqual([id, id, id]);         // 收播(录制中→等待)

    proc.emitExit({ code: 0, signal: null, expected: true });
    expect(changed).toEqual([id, id, id, id]);     // 正常停止
  });

  it("未注入回调时状态变更不报错(向后兼容:老调用方照常工作)", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });   // 不传 onRecordingStateChanged
    expect(() => {
      mgr.start(id);
      spawner.last(id).emitLog("[状态] 录制中");
      spawner.last(id).emitExit({ code: 0, signal: null, expected: true });
    }).not.toThrow();
  });

  it("回调抛错不影响录制主流程(旁路信号不能把录制搞挂),但要留下日志", () => {
    const id = addTask();
    const spawner = new MockSpawner();
    const logs: string[] = [];
    const mgr = new TaskManager(store, spawner, {
      log: (m) => logs.push(m),
      onRecordingStateChanged: () => { throw new Error("boom"); },
    });
    expect(() => mgr.start(id)).not.toThrow();
    expect(mgr.isRunning(id)).toBe(true);           // 录制照常起来了
    expect(logs.some((l) => l.includes("notifyRecordingState"))).toBe(true);  // 但不静默
  });
});

describe("TaskManager spawn failures (issue #41)", () => {
  /** Spawner whose process throws from start() while `failStart` is set. */
  class ThrowingStartSpawner extends MockSpawner {
    failStart = true;
    override spawn(task: { id: number }): RecorderProcess {
      const p = super.spawn(task) as FakeRecorderProcess;
      if (this.failStart) p.start = (): void => { throw new Error("spawn EACCES"); };
      return p;
    }
  }

  it("synchronous start() throw clears the process entry so the task can start again", () => {
    const id = addTask();
    const spawner = new ThrowingStartSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    expect(mgr.start(id)).toBe(false);
    expect(mgr.isRunning(id)).toBe(false);
    expect(mgr.runningIds()).toEqual([]);
    expect(store.getTask(id)!.status).toBe("error");
    spawner.failStart = false;
    expect(mgr.start(id)).toBe(true);
    expect(mgr.isRunning(id)).toBe(true);
    expect(store.getTask(id)!.status).toBe("running");
  });

  it("start-failure alert fires once per task until a spawn succeeds", () => {
    const a = addTask();
    const b = addTask();
    const spawner = new ThrowingStartSpawner();
    const down: number[] = [];
    const mgr = new TaskManager(store, spawner, { log: () => {}, onTaskDown: (tid) => down.push(tid) });
    mgr.start(a);
    mgr.start(a);
    mgr.start(a);
    mgr.start(b);
    expect(down).toEqual([a, b]);
    spawner.failStart = false;
    mgr.start(a); // recovered → dedupe reset
    void mgr.stop(a);
    spawner.failStart = true;
    mgr.start(a);
    expect(down).toEqual([a, b, a]);
  });

  it("spawn failure inside the restart timer marks error, alerts, and stops retrying", () => {
    const id = addTask();
    const spawner = new ThrowingStartSpawner();
    spawner.failStart = false;
    const down: string[] = [];
    const mgr = new TaskManager(store, spawner, {
      autoRestart: true,
      restartDelayMs: 0,
      schedule: (cb) => cb(),
      log: () => {},
      onTaskDown: (_tid, reason) => down.push(reason),
    });
    mgr.start(id);
    spawner.failStart = true;
    spawner.last(id).emitExit({ code: 1, signal: null, expected: false }); // crash → restart → start() throws
    expect(spawner.spawned).toHaveLength(2);
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("error");
    expect(down).toHaveLength(1);
    expect(down[0]).toContain("spawn EACCES");
  });
});
