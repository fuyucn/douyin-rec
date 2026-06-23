import { describe, it, expect } from "vitest";
import { decide, TaskDaemon } from "../../packages/app/src/daemon.js";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import { TaskStore, type Task } from "../../packages/app/src/store.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type { RecorderProcess, ExitInfo } from "../../packages/app/src/process/recorder-process.js";

function mkTask(
  id: number,
  scheduleStart: string | null,
  scheduleEnd: string | null,
  enabled = true,
): Task {
  return {
    id,
    room: `room${id}`,
    name: `anchor${id}`,
    quality: "origin",
    recorder: "bililive",
    danmu: 1,
    segmentSec: 1800,
    cookies: null,
    outDir: null,
    scheduleStart,
    scheduleEnd,
    status: "stopped",
    useCookie: true,
    enabled,
    createdAt: "2026-06-12T00:00:00.000Z",
  };
}

/** Build a local Date at the given hour/minute today. */
const localAt = (h: number, m = 0): Date => new Date(2026, 5, 12, h, m, 0);

describe("decide — pure scheduling decision", () => {
  it("starts an eligible task that is not yet active", () => {
    const tasks = [mkTask(1, "06:00", "09:00")];
    const d = decide(tasks, localAt(7), new Set());
    expect(d.start).toEqual([1]);
    expect(d.stop).toEqual([]);
  });

  it("stops an active task that left its window", () => {
    const tasks = [mkTask(1, "06:00", "09:00")];
    const d = decide(tasks, localAt(10), new Set([1]));
    expect(d.start).toEqual([]);
    expect(d.stop).toEqual([1]);
  });

  it("no-op for eligible+active", () => {
    const tasks = [mkTask(1, "06:00", "09:00")];
    const d = decide(tasks, localAt(7), new Set([1]));
    expect(d).toEqual({ start: [], stop: [] });
  });

  it("no-op for ineligible+inactive", () => {
    const tasks = [mkTask(1, "06:00", "09:00")];
    const d = decide(tasks, localAt(3), new Set());
    expect(d).toEqual({ start: [], stop: [] });
  });

  it("null schedule → always starts (always eligible)", () => {
    const tasks = [mkTask(1, null, null)];
    const d = decide(tasks, localAt(3), new Set());
    expect(d.start).toEqual([1]);
  });

  it("disabled task is NEVER started, even in-window / no-window", () => {
    const tasks = [
      mkTask(1, "06:00", "09:00", false), // in window but disabled
      mkTask(2, null, null, false),       // no window but disabled
    ];
    const d = decide(tasks, localAt(7), new Set());
    expect(d.start).toEqual([]);
  });

  it("disabled task that is somehow active gets stopped", () => {
    const tasks = [mkTask(1, null, null, false)];
    const d = decide(tasks, localAt(7), new Set([1]));
    expect(d.stop).toEqual([1]);
  });

  it("overnight window 22:30-01:00 is eligible at 00:30", () => {
    const tasks = [mkTask(1, "22:30", "01:00")];
    const d = decide(tasks, localAt(0, 30), new Set());
    expect(d.start).toEqual([1]);
  });

  it("overnight window stops at 02:00 when active", () => {
    const tasks = [mkTask(1, "22:30", "01:00")];
    const d = decide(tasks, localAt(2), new Set([1]));
    expect(d.stop).toEqual([1]);
  });

  it("handles multiple tasks independently", () => {
    const tasks = [
      mkTask(1, "06:00", "09:00"), // eligible at 07:00, inactive → start
      mkTask(2, "06:00", "09:00"), // eligible, active → noop
      mkTask(3, "10:00", "12:00"), // ineligible, active → stop
      mkTask(4, "10:00", "12:00"), // ineligible, inactive → noop
    ];
    const d = decide(tasks, localAt(7), new Set([2, 3]));
    expect(d.start).toEqual([1]);
    expect(d.stop).toEqual([3]);
  });
});

/** Minimal controllable fake for composition tests. */
class FakeProc implements RecorderProcess {
  readonly pid = 1;
  started = false;
  draining = false;
  /**
   * When true (default), stopGraceful() exits immediately — models a window-end
   * with no live broadcast (drain completes at once). Set false to simulate a
   * still-live broadcast that keeps draining until endBroadcast() is called.
   */
  autoEndOnGraceful = true;
  private cbs: ((i: ExitInfo) => void)[] = [];
  constructor(readonly taskId: number) {}
  start(): void {
    this.started = true;
  }
  async stop(): Promise<void> {
    this.fireExit();
  }
  async stopGraceful(): Promise<void> {
    this.draining = true;
    if (this.autoEndOnGraceful) this.fireExit();
  }
  /** Simulate the drained broadcast ending naturally → the subprocess exits. */
  endBroadcast(): void {
    this.fireExit();
  }
  private fireExit(): void {
    for (const cb of this.cbs) cb({ code: 0, signal: null, expected: true });
  }
  onExit(cb: (i: ExitInfo) => void): void {
    this.cbs.push(cb);
  }
  onLog(): void {}
}

class MockSpawner implements Spawner {
  readonly spawned: FakeProc[] = [];
  spawn(task: { id: number }): RecorderProcess {
    const p = new FakeProc(task.id);
    this.spawned.push(p);
    return p;
  }
}

describe("TaskDaemon — composition with TaskManager", () => {
  it("starts an eligible task via the manager (spawns a subprocess) on tick", async () => {
    const store = new TaskStore(":memory:");
    const id = store.addTask({ room: "r", scheduleStart: "06:00", scheduleEnd: "09:00", enabled: true }).id;
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    const daemon = new TaskDaemon(store, mgr, { now: () => localAt(7), log: () => {} });

    await daemon.tick();
    expect(spawner.spawned).toHaveLength(1);
    expect(daemon.activeIds()).toEqual(new Set([id]));
    expect(store.getTask(id)!.status).toBe("running");
  });

  it("does NOT spawn anything when the window is closed", async () => {
    const store = new TaskStore(":memory:");
    store.addTask({ room: "r", scheduleStart: "03:00", scheduleEnd: "03:01", enabled: true });
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    const daemon = new TaskDaemon(store, mgr, { now: () => localAt(7), log: () => {} });

    await daemon.tick();
    expect(spawner.spawned).toHaveLength(0);
    expect(daemon.activeIds()).toEqual(new Set());
  });

  it("stops a running task once it leaves its window", async () => {
    const store = new TaskStore(":memory:");
    const id = store.addTask({ room: "r", scheduleStart: "06:00", scheduleEnd: "09:00", enabled: true }).id;
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    const clock = { d: localAt(7) };
    const daemon = new TaskDaemon(store, mgr, { now: () => clock.d, log: () => {} });

    await daemon.tick(); // in window → start
    expect(mgr.isRunning(id)).toBe(true);
    clock.d = localAt(10); // out of window
    await daemon.tick(); // → graceful drain; FakeProc ends immediately (no live broadcast)
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
  });

  it("window-end uses GRACEFUL drain: a still-live broadcast keeps recording (status=draining)", async () => {
    const store = new TaskStore(":memory:");
    const id = store.addTask({ room: "r", scheduleStart: "06:00", scheduleEnd: "09:00", enabled: true }).id;
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    const clock = { d: localAt(7) };
    const daemon = new TaskDaemon(store, mgr, { now: () => clock.d, log: () => {} });

    await daemon.tick(); // in window → start
    const proc = spawner.spawned[0];
    proc.autoEndOnGraceful = false; // simulate a broadcast still live at window-end

    clock.d = localAt(10); // out of window
    await daemon.tick(); // → graceful drain, but the broadcast hasn't ended
    expect(mgr.isRunning(id)).toBe(true); // NOT cut off
    expect(mgr.isDraining(id)).toBe(true);
    expect(store.getTask(id)!.status).toBe("draining");

    await daemon.tick(); // idempotent: re-issuing drain does nothing new
    expect(mgr.isDraining(id)).toBe(true);

    proc.endBroadcast(); // broadcast ends naturally → subprocess exits
    expect(mgr.isRunning(id)).toBe(false);
    expect(mgr.isDraining(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
  });

  it("P0 overrun: a draining task whose NEW window opened is NOT restarted (warns), then self-heals", async () => {
    const store = new TaskStore(":memory:");
    // Overnight-ish: window 06:00-09:00; we'll re-open the window after drain.
    const id = store.addTask({ room: "r", scheduleStart: "06:00", scheduleEnd: "09:00", enabled: true }).id;
    const spawner = new MockSpawner();
    const logs: string[] = [];
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    const clock = { d: localAt(7) };
    const daemon = new TaskDaemon(store, mgr, { now: () => clock.d, log: (m) => logs.push(m) });

    await daemon.tick(); // start
    const proc = spawner.spawned[0];
    proc.autoEndOnGraceful = false; // long broadcast

    clock.d = localAt(10); // leave window → drain (still recording)
    await daemon.tick();
    expect(mgr.isDraining(id)).toBe(true);

    clock.d = localAt(7); // NEW window opens while still draining
    await daemon.tick();
    expect(spawner.spawned).toHaveLength(1); // did NOT spawn a second recorder
    expect(logs.some((l) => l.includes("仍在收尾上一场直播"))).toBe(true);

    await daemon.tick(); // warning is logged only once
    expect(logs.filter((l) => l.includes("仍在收尾上一场直播"))).toHaveLength(1);

    proc.endBroadcast(); // old broadcast ends → proc exits
    await daemon.tick(); // self-heal: eligible && !active → start fresh
    expect(spawner.spawned).toHaveLength(2);
    expect(mgr.isRunning(id)).toBe(true);
  });

  it("stop() stops all recorders and is idempotent", async () => {
    const store = new TaskStore(":memory:");
    store.addTask({ room: "a", enabled: true });
    store.addTask({ room: "b", enabled: true });
    const spawner = new MockSpawner();
    const mgr = new TaskManager(store, spawner, { log: () => {} });
    const daemon = new TaskDaemon(store, mgr, { now: () => localAt(7), log: () => {} });
    await daemon.tick(); // both have null schedule → always eligible
    expect(mgr.runningIds().length).toBe(2);
    await daemon.stop();
    expect(mgr.runningIds()).toEqual([]);
    await daemon.stop(); // idempotent
  });
});
