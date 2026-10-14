import { describe, it, expect, beforeEach } from "vitest";
import { TaskManager } from "../../packages/app/src/task-manager.js";
import { TaskDaemon } from "../../packages/app/src/daemon.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type { RecorderProcess, ExitInfo } from "../../packages/app/src/process/recorder-process.js";
import { TaskStore } from "../../packages/app/src/store.js";

/** 停止很慢的进程(模拟 rolling 任务给末段上传留宽限):release() 之前 stop() 不返回。 */
class SlowStopProcess implements RecorderProcess {
  readonly pid = 1;
  stopCalls = 0;
  private listeners: ((i: ExitInfo) => void)[] = [];
  private release!: () => void;
  private readonly gate = new Promise<void>((r) => { this.release = r; });
  failWith: Error | null = null;
  constructor(readonly taskId: number) {}
  start(): void {}
  async stop(): Promise<void> {
    this.stopCalls++;
    if (this.failWith) throw this.failWith;
    await this.gate;
    for (const cb of this.listeners) cb({ code: 0, signal: null, expected: true });
  }
  gracefulCalls = 0;
  async stopGraceful(): Promise<void> {
    this.gracefulCalls++;
    await this.gate; // 与真实实现一致:排空要等到进程退出
  }
  finish(): void { this.release(); }
  onExit(cb: (i: ExitInfo) => void): void { this.listeners.push(cb); }
  onLog(): void {}
}

let store: TaskStore;
let proc: SlowStopProcess;
let mgr: TaskManager;
let logs: string[];
let id: number;

beforeEach(() => {
  store = new TaskStore(":memory:");
  logs = [];
  const spawner: Spawner = { spawn: (t) => (proc = new SlowStopProcess(t.id)) } as Spawner;
  mgr = new TaskManager(store, spawner, { log: (m) => logs.push(m) });
  id = store.addTask({ room: "12345" }).id;
  mgr.start(id);
});

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("TaskManager 停止不阻塞调用方", () => {
  it("stop() 重复调用共用同一次停止:只给进程发一次信号", async () => {
    const a = mgr.stop(id);
    const b = mgr.stop(id);
    expect(a).toBe(b);
    expect(proc.stopCalls).toBe(1);
    proc.finish();
    await a;
    expect(mgr.isRunning(id)).toBe(false);
  });

  it("requestStop 立即返回(不等退出);进程退出后收尾", async () => {
    mgr.requestStop(id);
    expect(proc.stopCalls).toBe(1);
    expect(mgr.isRunning(id)).toBe(true); // 还在停止中
    proc.finish();
    await tick();
    expect(mgr.isRunning(id)).toBe(false);
  });

  it("requestStop 失败只记日志,不抛未处理拒绝", async () => {
    proc.failWith = new Error("kill 失败");
    mgr.requestStop(id);
    await tick();
    expect(logs.some((l) => l.includes("停止任务失败") && l.includes("kill 失败"))).toBe(true);
  });

  it("stopWithin:快退出 → true;超时 → false 且停止仍在进行,之后仍能收尾", async () => {
    const slow = mgr.stopWithin(id, 30);
    expect(await slow).toBe(false);
    expect(mgr.isRunning(id)).toBe(true);
    proc.finish();
    await tick();
    expect(mgr.isRunning(id)).toBe(false);

    mgr.start(id);
    const fast = mgr.stopWithin(id, 1000);
    proc.finish();
    expect(await fast).toBe(true);
  });

  it("stopWithin:停止本身失败 → 抛出(让 API 层回滚 enabled)", async () => {
    proc.failWith = new Error("boom");
    await expect(mgr.stopWithin(id, 1000)).rejects.toThrow("boom");
  });

  it("硬停在途时 stopGraceful 让位:不改 draining 状态、不发 SIGUSR2、不重新阻塞", async () => {
    store.setStatus(id, "running");
    mgr.requestStop(id);
    await mgr.stopGraceful(id); // 若被当成排空,会 await 到进程退出 → 这里直接挂住
    expect(mgr.isDraining(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("running");
    expect(proc.gracefulCalls).toBe(0);
    proc.finish();
  });

  it("daemon tick:被 hub 抑制而本机硬停的任务不再卡住整个 tick", async () => {
    const daemon = new TaskDaemon(store, mgr, { log: () => {}, localSuppressedIds: () => new Set([id]) });
    const done = await Promise.race([daemon.tick().then(() => true), tick(500).then(() => false)]);
    expect(done).toBe(true);
    expect(proc.stopCalls).toBe(1);
    proc.finish();
  });
});
