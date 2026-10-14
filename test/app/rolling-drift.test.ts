/**
 * issue #89:`--rolling-upload` 是子进程启动参数,规则改动后常驻进程不会自己变。
 * 钉住:TaskManager 记录「spawn 时带的值」、daemon 漂移检测与「只在空闲时重启」、绝不腰斩直播。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { TaskDaemon, ROLLING_DRIFT_IDLE_TICKS } from "../../packages/app/src/daemon.js";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import { TaskStore } from "../../packages/app/src/store.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type { RecorderProcess, ExitInfo } from "../../packages/app/src/process/recorder-process.js";

class FakeProc implements RecorderProcess {
  readonly pid = 1;
  stopCalls = 0;
  /** 排空是否立即结束(false = 直播还在,保持 draining)。 */
  autoEndOnGraceful = false;
  private cbs: ((i: ExitInfo) => void)[] = [];
  private logCbs: ((m: string) => void)[] = [];
  constructor(readonly taskId: number, readonly rollingEffectiveAtSpawn: boolean) {}
  start(): void {}
  async stop(): Promise<void> {
    this.stopCalls++;
    this.exit();
  }
  async stopGraceful(): Promise<void> {
    if (this.autoEndOnGraceful) this.exit();
  }
  private exit(): void {
    for (const cb of this.cbs) cb({ code: 0, signal: null, expected: true });
  }
  onExit(cb: (i: ExitInfo) => void): void {
    this.cbs.push(cb);
  }
  onLog(cb: (m: string) => void): void {
    this.logCbs.push(cb);
  }
  say(msg: string): void {
    for (const cb of this.logCbs) cb(msg);
  }
  goLive(): void {
    this.say("[状态] 录制中");
  }
  goIdle(): void {
    this.say("[状态] 等待开播");
  }
}

class MockSpawner implements Spawner {
  readonly spawned: FakeProc[] = [];
  spawn(task: { id: number; rollingEffective?: boolean }): RecorderProcess {
    const p = new FakeProc(task.id, task.rollingEffective === true);
    this.spawned.push(p);
    return p;
  }
  get last(): FakeProc {
    return this.spawned[this.spawned.length - 1];
  }
}

let store: TaskStore;
let spawner: MockSpawner;
let mgr: TaskManager;
let logs: string[];
let free: number | null;

function mkDaemon(watermarkGB = 0): TaskDaemon {
  return new TaskDaemon(store, mgr, {
    log: (m) => logs.push(m),
    freeBytes: () => free,
    diskWatermarkBytes: watermarkGB * 1e9,
  });
}

async function ticks(d: TaskDaemon, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await d.tick();
}

beforeEach(() => {
  store = new TaskStore(":memory:");
  spawner = new MockSpawner();
  mgr = new TaskManager(store, spawner, { log: () => {} });
  logs = [];
  free = null;
});

function addTask(rolling: boolean, extra: Record<string, unknown> = {}): number {
  const id = store.addTask({ room: "r", enabled: true, ...extra }).id;
  store.updateTask(id, { rollingEffective: rolling });
  return id;
}

describe("TaskManager.rollingStatus / stopIdleForConfig", () => {
  it("不在跑 → null;spawn 后 applied=当时的值、无漂移", () => {
    const id = addTask(true);
    expect(mgr.rollingStatus(id)).toBeNull();
    mgr.start(id);
    expect(mgr.rollingStatus(id)).toEqual({ applied: true, desired: true, drift: false });
  });

  it("库里的生效值之后被改 → drift,applied 仍是 spawn 时的值", () => {
    const id = addTask(false);
    mgr.start(id);
    store.updateTask(id, { rollingEffective: true });
    expect(mgr.rollingStatus(id)).toEqual({ applied: false, desired: true, drift: true });
  });

  it("进程退出后清掉记录;再次 spawn 取最新值", async () => {
    const id = addTask(false);
    mgr.start(id);
    store.updateTask(id, { rollingEffective: true });
    await mgr.stop(id);
    expect(mgr.rollingStatus(id)).toBeNull();
    mgr.start(id);
    expect(mgr.rollingStatus(id)).toEqual({ applied: true, desired: true, drift: false });
    expect(spawner.last.rollingEffectiveAtSpawn).toBe(true);
  });

  it("录制中 → 不停(返回 false,进程没被动)", async () => {
    const id = addTask(false);
    mgr.start(id);
    spawner.last.goLive();
    expect(await mgr.stopIdleForConfig(id, "x")).toBe(false);
    expect(spawner.last.stopCalls).toBe(0);
    expect(mgr.isRunning(id)).toBe(true);
  });

  it("排空中 → 不停", async () => {
    const id = addTask(false);
    mgr.start(id);
    await mgr.stopGraceful(id);
    expect(await mgr.stopIdleForConfig(id, "x")).toBe(false);
    expect(spawner.last.stopCalls).toBe(0);
  });

  it("空闲 → 停掉并返回 true(只停不起)", async () => {
    const id = addTask(false);
    mgr.start(id);
    expect(await mgr.stopIdleForConfig(id, "x")).toBe(true);
    expect(mgr.isRunning(id)).toBe(false);
    expect(spawner.spawned).toHaveLength(1);
  });

  it("没在跑 → false", async () => {
    const id = addTask(false);
    expect(await mgr.stopIdleForConfig(id, "x")).toBe(false);
  });
});

describe("TaskDaemon 边录边传漂移收敛", () => {
  it("关→开:空闲连续 N 个 tick 后重启,新进程带新值;N-1 个 tick 内不动", async () => {
    const id = addTask(false);
    const d = mkDaemon();
    await d.tick(); // 起录
    expect(spawner.spawned).toHaveLength(1);
    store.updateTask(id, { rollingEffective: true });

    await ticks(d, ROLLING_DRIFT_IDLE_TICKS - 1);
    expect(spawner.spawned).toHaveLength(1); // 还没到连续空闲阈值
    await d.tick();
    expect(spawner.spawned).toHaveLength(2);
    expect(spawner.spawned[0].stopCalls).toBe(1);
    expect(spawner.last.rollingEffectiveAtSpawn).toBe(true);
    expect(mgr.rollingStatus(id)).toEqual({ applied: true, desired: true, drift: false });
    expect(store.getTask(id)!.status).toBe("running");
  });

  it("开→关(反方向)同样收敛,新进程不带边录边传", async () => {
    const id = addTask(true);
    const d = mkDaemon();
    await d.tick();
    store.updateTask(id, { rollingEffective: false });
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS);
    expect(spawner.spawned).toHaveLength(2);
    expect(spawner.last.rollingEffectiveAtSpawn).toBe(false);
  });

  it("录制中绝不重启:多个 tick 都不动,且只告警一次;收播后才重启", async () => {
    const id = addTask(false);
    const d = mkDaemon();
    await d.tick();
    spawner.last.goLive();
    store.updateTask(id, { rollingEffective: true });

    await ticks(d, ROLLING_DRIFT_IDLE_TICKS + 3);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.last.stopCalls).toBe(0);
    expect(logs.filter((m) => m.includes("本场结束后自动重启生效"))).toHaveLength(1);

    spawner.last.goIdle(); // 收播
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS);
    expect(spawner.spawned).toHaveLength(2);
    expect(spawner.last.rollingEffectiveAtSpawn).toBe(true);
  });

  it("空闲计数被「录制中」打断后重新数(避免刚收播/重连瞬态就重启)", async () => {
    const id = addTask(false);
    const d = mkDaemon();
    await d.tick();
    store.updateTask(id, { rollingEffective: true });
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS - 1); // 已空闲 N-1
    spawner.last.goLive();
    await d.tick(); // 录制中 → 清零
    spawner.last.goIdle();
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS - 1);
    expect(spawner.spawned).toHaveLength(1); // 重新数,仍未到阈值
    await d.tick();
    expect(spawner.spawned).toHaveLength(2);
  });

  it("排空中(窗口结束但直播未收)不重启", async () => {
    const id = addTask(false);
    const d = mkDaemon();
    await d.tick();
    await mgr.stopGraceful(id);
    store.updateTask(id, { rollingEffective: true });
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS + 2);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.last.stopCalls).toBe(0);
  });

  it("无漂移:不动", async () => {
    addTask(true);
    const d = mkDaemon();
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS + 3);
    expect(spawner.spawned).toHaveLength(1);
    expect(spawner.last.stopCalls).toBe(0);
  });

  it("漂移期间任务被停用:走原有排空逻辑,漂移逻辑不介入、绝不重新拉起", async () => {
    const id = addTask(false);
    const d = mkDaemon();
    await d.tick();
    store.updateTask(id, { rollingEffective: true, enabled: false });
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS + 2);
    expect(mgr.isDraining(id)).toBe(true); // 停用 = 窗口外排空(原有行为),直播不腰斩
    expect(spawner.last.stopCalls).toBe(0);
    expect(spawner.spawned).toHaveLength(1);
  });

  it("磁盘低于水位:暂缓重启并只告警一次;回升后自动重启", async () => {
    const id = addTask(false);
    free = 50e9;
    const d = mkDaemon(10);
    await d.tick();
    free = 1e9; // 低于 10GB 水位
    store.updateTask(id, { rollingEffective: true });
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS + 3);
    expect(spawner.spawned).toHaveLength(1);
    expect(logs.filter((m) => m.includes("暂缓重启"))).toHaveLength(1);

    free = 50e9;
    await ticks(d, 1);
    expect(spawner.spawned).toHaveLength(2);
  });

  it("重启后漂移消失:再多 tick 也不会反复重启", async () => {
    const id = addTask(false);
    const d = mkDaemon();
    await d.tick();
    store.updateTask(id, { rollingEffective: true });
    await ticks(d, ROLLING_DRIFT_IDLE_TICKS);
    expect(spawner.spawned).toHaveLength(2);
    await ticks(d, 6);
    expect(spawner.spawned).toHaveLength(2);
  });
});
