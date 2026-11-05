/**
 * Serve-side live gate (plans/042 Task 6): a started task whose room is not live holds no `record`
 * child process; serve polls the platform and spawns once it is live.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformForRoom } from "@drec/core";
import { TaskManager, type TaskManagerOpts } from "../../packages/app/src/task-manager.js";
import { TaskDaemon } from "../../packages/app/src/daemon.js";
import { TaskStore, type Task } from "../../packages/app/src/store.js";
import type { Spawner } from "../../packages/app/src/process/spawner.js";
import type { ExitInfo, RecorderProcess } from "../../packages/app/src/process/recorder-process.js";
import { probeRoomLiving, zeroDiskHasUnconfirmedParts } from "../../packages/app/src/live-gate.js";
import { livePumpStatePath } from "@drec/zero-upload";

class FakeProc implements RecorderProcess {
  readonly pid = 1;
  private exitCbs: ((i: ExitInfo) => void)[] = [];
  constructor(readonly taskId: number) {}
  start(): void {}
  async stop(): Promise<void> { this.exit({ code: 0, signal: null, expected: true }); }
  async stopGraceful(): Promise<void> {}
  onExit(cb: (i: ExitInfo) => void): void { this.exitCbs.push(cb); }
  onLog(): void {}
  exit(info: ExitInfo): void { for (const cb of this.exitCbs) cb(info); }
}

class Spawn implements Spawner {
  readonly spawned: FakeProc[] = [];
  spawn(task: { id: number }): RecorderProcess {
    const p = new FakeProc(task.id);
    this.spawned.push(p);
    return p;
  }
}

let store: TaskStore;
let spawner: Spawn;
let logs: string[];

beforeEach(() => {
  vi.useFakeTimers();
  store = new TaskStore(":memory:");
  spawner = new Spawn();
  logs = [];
});
afterEach(() => { vi.useRealTimers(); });

/** Manager whose probe is a controllable function; first poll fires at t=0 (random=0). */
function mk(probe: (t: Task) => Promise<boolean>, over: Partial<TaskManagerOpts> = {}): TaskManager {
  return new TaskManager(store, spawner, {
    probeLiving: probe,
    hasUnconfirmedZeroDisk: () => false,
    random: () => 0,
    log: (m) => logs.push(m),
    ...over,
  });
}
const add = (over: Partial<Parameters<TaskStore["addTask"]>[0]> = {}): number =>
  store.addTask({ room: "12345", ...over }).id;
const advance = (ms: number): Promise<void> => vi.advanceTimersByTimeAsync(ms);

describe("live gate: not live", () => {
  it("holds no process but reads as running (not recording, status running, gated)", async () => {
    const id = add();
    const probe = vi.fn(async () => false);
    const mgr = mk(probe);
    expect(mgr.start(id)).toBe(true);
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(spawner.spawned).toHaveLength(0);
    expect(mgr.isRunning(id)).toBe(true);
    expect(mgr.runningIds()).toEqual([id]);
    expect(mgr.isRecording(id)).toBe(false);
    expect(mgr.isGated(id)).toBe(true);
    expect(store.getTask(id)!.status).toBe("running");
    expect(mgr.start(id)).toBe(false); // already started: no second gate
  });

  it("polls every 30s by default and spawns exactly once when the room goes live", async () => {
    const id = add();
    let live = false;
    const probe = vi.fn(async () => live);
    const mgr = mk(probe);
    mgr.start(id);
    await advance(0);
    await advance(30_000);
    expect(probe).toHaveBeenCalledTimes(2);
    live = true;
    await advance(30_000);
    expect(spawner.spawned).toHaveLength(1);
    expect(mgr.isGated(id)).toBe(false);
    expect(mgr.isRunning(id)).toBe(true);
    await advance(120_000);
    expect(probe).toHaveBeenCalledTimes(3); // no polling once the child owns the room
    expect(spawner.spawned).toHaveLength(1);
  });

  it("first poll is jittered within 0-5s", async () => {
    const id = add();
    const probe = vi.fn(async () => false);
    mk(probe, { random: () => 0.5 }).start(id);
    await advance(2_499);
    expect(probe).not.toHaveBeenCalled();
    await advance(2);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("uses the platform pollIntervalMs when set (kuaishou-style)", async () => {
    const id = add();
    const p = platformForRoom("12345");
    const prev = p.pollIntervalMs;
    p.pollIntervalMs = 300_000;
    try {
      const probe = vi.fn(async () => false);
      mk(probe).start(id);
      await advance(0);
      await advance(299_000);
      expect(probe).toHaveBeenCalledTimes(1);
      await advance(1_001);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      p.pollIntervalMs = prev;
    }
  });
});

describe("live gate: probe failures (#308)", () => {
  it("keeps polling with 30s→5min backoff, never errors, never spawns, logs 1st and every 10th", async () => {
    const id = add();
    const downs: string[] = [];
    const probe = vi.fn(async (): Promise<boolean> => { throw new Error("risk control"); });
    const mgr = mk(probe, { onTaskDown: (_i, r) => downs.push(r), autoRestart: true, maxRestarts: 1 });
    mgr.start(id);
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1); // t=0
    await advance(29_999);
    expect(probe).toHaveBeenCalledTimes(1);
    await advance(1); // +30s
    expect(probe).toHaveBeenCalledTimes(2);
    await advance(60_000); // +60s
    expect(probe).toHaveBeenCalledTimes(3);
    await advance(120_000); // +120s
    expect(probe).toHaveBeenCalledTimes(4);
    await advance(240_000); // +240s
    expect(probe).toHaveBeenCalledTimes(5);
    await advance(299_999); // capped at 300s, not 480s
    expect(probe).toHaveBeenCalledTimes(5);
    await advance(1);
    expect(probe).toHaveBeenCalledTimes(6);
    for (let i = 0; i < 4; i++) await advance(300_000); // failures 7..10
    expect(probe).toHaveBeenCalledTimes(10);
    await advance(300_000);
    expect(probe).toHaveBeenCalledTimes(11);

    expect(spawner.spawned).toHaveLength(0);
    expect(store.getTask(id)!.status).toBe("running");
    expect(mgr.isGated(id)).toBe(true);
    expect(downs).toEqual([]);
    const failLogs = logs.filter((m) => m.includes("判活失败"));
    expect(failLogs).toHaveLength(2);
    expect(failLogs[0]).toContain("连续 1 次");
    expect(failLogs[1]).toContain("连续 10 次");
  });

  it("recovers: a successful probe resets the backoff and a live room spawns; the budget is untouched", async () => {
    const id = add();
    let mode: "throw" | "off" | "live" = "throw";
    const probe = vi.fn(async () => {
      if (mode === "throw") throw new Error("net");
      return mode === "live";
    });
    const mgr = mk(probe, { autoRestart: true, maxRestarts: 1, restartDelayMs: 0, schedule: (cb) => cb() });
    mgr.start(id);
    await advance(0); // fail #1 -> next in 30s
    await advance(30_000); // fail #2 -> next in 60s
    mode = "off";
    await advance(60_000); // ok, not live -> next in 30s (reset)
    expect(probe).toHaveBeenCalledTimes(3);
    await advance(30_000);
    expect(probe).toHaveBeenCalledTimes(4);
    mode = "live";
    await advance(30_000);
    expect(spawner.spawned).toHaveLength(1);
    // The one allowed crash restart still works: probe failures never consumed it.
    spawner.spawned[0]!.exit({ code: 1, signal: null, expected: false });
    expect(spawner.spawned).toHaveLength(2);
  });

  it("a hung probe counts as a failure after the timeout instead of stalling the gate", async () => {
    const id = add();
    let n = 0;
    const probe = vi.fn(() => (n++ === 0 ? new Promise<boolean>(() => {}) : Promise.resolve(true)));
    const mgr = mk(probe);
    mgr.start(id);
    await advance(0);
    await advance(60_000); // timeout -> failure #1 -> backoff 30s
    await advance(30_000);
    expect(spawner.spawned).toHaveLength(1);
  });
});

describe("live gate: stop paths cancel immediately", () => {
  it("stop() while waiting for the next poll", async () => {
    const id = add();
    const probe = vi.fn(async () => false);
    const mgr = mk(probe);
    mgr.start(id);
    await advance(0);
    await mgr.stop(id);
    expect(mgr.isRunning(id)).toBe(false);
    expect(mgr.isGated(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
    await advance(10 * 60_000);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(spawner.spawned).toHaveLength(0);
  });

  it("stop() while a probe is in flight: a live answer afterwards must not spawn", async () => {
    const id = add();
    let resolve!: (v: boolean) => void;
    const probe = vi.fn(() => new Promise<boolean>((r) => { resolve = r; }));
    const mgr = mk(probe);
    mgr.start(id);
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    await mgr.stop(id);
    resolve(true);
    await advance(0);
    expect(spawner.spawned).toHaveLength(0);
    expect(store.getTask(id)!.status).toBe("stopped");
    await advance(120_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("an in-flight probe from a cancelled gate cannot spawn into a NEW gate of the same task", async () => {
    const id = add();
    const resolvers: Array<(v: boolean) => void> = [];
    const probe = vi.fn(() => new Promise<boolean>((r) => { resolvers.push(r); }));
    const mgr = mk(probe);
    mgr.start(id);
    await advance(0);
    await mgr.stop(id);
    mgr.start(id); // fresh gate while the old probe is still pending
    resolvers[0]!(true); // stale answer
    await advance(0);
    expect(spawner.spawned).toHaveLength(0);
    expect(mgr.isGated(id)).toBe(true);
  });

  it("stopGraceful (window end drain) is an immediate stop for a gated task", async () => {
    const id = add();
    const probe = vi.fn(async () => false);
    const mgr = mk(probe);
    mgr.start(id);
    await advance(0);
    await mgr.stopGraceful(id);
    expect(mgr.isRunning(id)).toBe(false);
    expect(mgr.isDraining(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
    await advance(60_000);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("requestStop (hub suppression) and stopWithin (web stop) cancel too; stopAll covers gated tasks", async () => {
    const a = add({ room: "111" });
    const b = add({ room: "222" });
    const c = add({ room: "333" });
    const mgr = mk(async () => false);
    mgr.start(a); mgr.start(b); mgr.start(c);
    await advance(0);
    mgr.requestStop(a);
    expect(await mgr.stopWithin(b, 1000)).toBe(true);
    await mgr.stopAll();
    expect(mgr.runningIds()).toEqual([]);
    for (const id of [a, b, c]) expect(store.getTask(id)!.status).toBe("stopped");
    await advance(120_000);
    expect(spawner.spawned).toHaveLength(0);
  });

  it("a gate whose task was deleted drops itself without spawning", async () => {
    const id = add();
    let live = false;
    const mgr = mk(async () => live);
    mgr.start(id);
    await advance(0);
    store.removeTask(id);
    live = true;
    await advance(30_000);
    expect(spawner.spawned).toHaveLength(0);
    expect(mgr.isRunning(id)).toBe(false);
  });
});

describe("live gate: which tasks are gated", () => {
  it("liveGate=false spawns directly (old behaviour) without probing", async () => {
    store.setSetting("liveGate", "false");
    const id = add();
    const probe = vi.fn(async () => false);
    mk(probe).start(id);
    expect(spawner.spawned).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("turning the setting off while tasks are gated spawns them all immediately (releaseGates)", async () => {
    const ids = [add({ room: "111" }), add({ room: "222" })];
    const mgr = mk(async () => false);
    ids.forEach((i) => mgr.start(i));
    await advance(0);
    expect(spawner.spawned).toHaveLength(0);
    store.setSetting("liveGate", "false");
    expect(mgr.releaseGates()).toBe(2);
    expect(spawner.spawned).toHaveLength(2);
    expect(ids.every((i) => !mgr.isGated(i) && mgr.isRunning(i))).toBe(true);
  });

  it("the poll itself also notices the setting being off (safety net when releaseGates is not called)", async () => {
    const id = add();
    const probe = vi.fn(async () => false);
    mk(probe).start(id);
    await advance(0);
    store.setSetting("liveGate", "false");
    await advance(30_000);
    expect(spawner.spawned).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("rolling-upload tasks are gated", async () => {
    const id = add();
    store.updateTask(id, { rollingEffective: true });
    mk(async () => false).start(id);
    await advance(0);
    expect(spawner.spawned).toHaveLength(0);
  });

  it("zero-disk task WITHOUT unconfirmed parts is gated", async () => {
    const id = add({ streamUpload: true });
    const mgr = mk(async () => false, { hasUnconfirmedZeroDisk: () => false });
    mgr.start(id);
    await advance(0);
    expect(spawner.spawned).toHaveLength(0);
    expect(mgr.isGated(id)).toBe(true);
  });

  it("zero-disk task WITH unconfirmed parts spawns immediately without probing", async () => {
    const id = add({ streamUpload: true });
    const probe = vi.fn(async () => false);
    mk(probe, { hasUnconfirmedZeroDisk: () => true }).start(id);
    expect(spawner.spawned).toHaveLength(1);
    expect(probe).not.toHaveBeenCalled();
  });

  it("the unconfirmed check only applies to zero-disk tasks", async () => {
    const id = add(); // plain task
    const check = vi.fn(() => true);
    mk(async () => false, { hasUnconfirmedZeroDisk: check }).start(id);
    await advance(0);
    expect(check).not.toHaveBeenCalled();
    expect(spawner.spawned).toHaveLength(0);
  });

  it("a gated zero-disk task blocks a second zero-disk task for the same room (duplicate-archive guard)", async () => {
    const a = add({ streamUpload: true });
    const b = add({ streamUpload: true });
    const mgr = mk(async () => false);
    expect(mgr.start(a)).toBe(true);
    expect(mgr.start(b)).toBe(false);
  });
});

describe("live gate: after the gate", () => {
  it("crash restarts spawn directly without probing and the gate is not re-entered", async () => {
    const id = add();
    const probe = vi.fn(async () => true);
    const mgr = mk(probe, { autoRestart: true, restartDelayMs: 0, schedule: (cb) => cb() });
    mgr.start(id);
    await advance(0);
    expect(spawner.spawned).toHaveLength(1);
    spawner.spawned[0]!.exit({ code: 1, signal: null, expected: false });
    expect(spawner.spawned).toHaveLength(2);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(mgr.isGated(id)).toBe(false);
  });

  it("a normal exit after the broadcast does not return to the gate (deferred by design)", async () => {
    const id = add();
    const mgr = mk(async () => true);
    mgr.start(id);
    await advance(0);
    spawner.spawned[0]!.exit({ code: 0, signal: null, expected: true });
    expect(mgr.isRunning(id)).toBe(false);
    expect(mgr.isGated(id)).toBe(false);
  });

  it("hub zero-disk preflight runs in start() BEFORE the gate: a refusal fails at once (error, one alert, no probe)", async () => {
    const id = add({ streamUpload: true, managedBy: "hub" });
    const downs: string[] = [];
    const probe = vi.fn(async () => true);
    const mgr = mk(probe, {
      zeroDiskPreflight: () => ({ ok: false, refusal: { code: "delivery_missing", message: "no delivery" } }) as never,
      onTaskDown: (_i, r) => downs.push(r),
    });
    expect(mgr.start(id)).toBe(false);
    await advance(60_000);
    expect(probe).not.toHaveBeenCalled();
    expect(mgr.isRunning(id)).toBe(false);
    expect(spawner.spawned).toHaveLength(0);
    expect(store.getTask(id)!.status).toBe("error");
    expect(downs).toHaveLength(1);
  });

  it("the preflight also runs again at spawn time: accepted at start, refused when the gate opens", async () => {
    const id = add({ streamUpload: true, managedBy: "hub" });
    let ok = true;
    const mgr = mk(async () => true, {
      zeroDiskPreflight: () => (ok
        ? { ok: true, delivery: {}, cookiesPath: "/x", credentialSource: "node-default" }
        : { ok: false, refusal: { code: "account_mismatch", message: "differs" } }) as never,
      random: () => 0.9,
    });
    expect(mgr.start(id)).toBe(true);
    expect(mgr.isGated(id)).toBe(true);
    ok = false;
    await advance(5_000);
    expect(spawner.spawned).toHaveLength(0);
    expect(store.getTask(id)!.status).toBe("error");
    expect(mgr.isRunning(id)).toBe(false);
  });

  it("beforeSpawn runs at open time, reading the latest values", async () => {
    const id = add();
    const seen: number[] = [];
    const mgr = mk(async () => true, { beforeSpawn: (t) => seen.push(t) });
    mgr.start(id);
    expect(seen).toEqual([]);
    await advance(0);
    expect(seen).toEqual([id]);
  });

  it("daemon ticks do not re-start or double-gate a gated task", async () => {
    const id = store.addTask({ room: "12345", enabled: true }).id;
    const probe = vi.fn(async () => false);
    const mgr = mk(probe);
    const daemon = new TaskDaemon(store, mgr, { log: () => {}, now: () => new Date(2026, 0, 1, 12, 0) });
    await daemon.tick();
    await daemon.tick();
    await daemon.tick();
    await advance(0);
    expect(probe).toHaveBeenCalledTimes(1);
    expect(mgr.runningIds()).toEqual([id]);
    expect(logs.filter((m) => m.includes("启动任务")).length).toBe(1);
  });

  it("daemon window end stops a gated task immediately", async () => {
    const id = store.addTask({ room: "12345", enabled: true, scheduleStart: "10:00", scheduleEnd: "11:00" }).id;
    const mgr = mk(async () => false);
    let hour = 10;
    const daemon = new TaskDaemon(store, mgr, { log: () => {}, now: () => new Date(2026, 0, 1, hour, 30) });
    await daemon.tick();
    expect(mgr.isGated(id)).toBe(true);
    hour = 12;
    await daemon.tick();
    expect(mgr.isRunning(id)).toBe(false);
    expect(store.getTask(id)!.status).toBe("stopped");
  });
});

describe("zero-disk unconfirmed-parts check (real state files)", () => {
  let dir: string;
  beforeEach(() => { vi.useRealTimers(); dir = mkdtempSync(join(tmpdir(), "live-gate-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const mkTask = (): Task => store.addTask({ room: "12345", streamUpload: true, outDir: dir });
  const statePath = (): string => livePumpStatePath(dir, "12345");
  const state = (parts: Array<{ confirmed: boolean }>, extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ schemaVersion: 1, room: "12345", parts, ...extra });

  it("missing state file = nothing to recover = gate", () => {
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "legacy")).toBe(false);
  });
  it("all parts confirmed = gate", () => {
    writeFileSync(statePath(), state([{ confirmed: true }]));
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "legacy")).toBe(false);
  });
  it("an unconfirmed part = spawn now", () => {
    writeFileSync(statePath(), state([{ confirmed: true }, { confirmed: false }]));
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "legacy")).toBe(true);
  });
  it("a pending WAL entry = spawn now", () => {
    writeFileSync(statePath(), state([{ confirmed: true }], { pending: { spoolPath: "/x", stem: "s" } }));
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "legacy")).toBe(true);
  });
  it("present but unparsable = treated as unconfirmed = spawn now", () => {
    writeFileSync(statePath(), "{truncated");
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "legacy")).toBe(true);
  });
  it("present but wrong schema = treated as unconfirmed", () => {
    writeFileSync(statePath(), JSON.stringify({ schemaVersion: 9 }));
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "legacy")).toBe(true);
  });
  it("room layout: a legacy ACTIVE state at the root stays authoritative (same resolution as the child)", () => {
    writeFileSync(statePath(), state([{ confirmed: false }]));
    expect(zeroDiskHasUnconfirmedParts(mkTask(), "room")).toBe(true);
  });
  it("room layout: unconfirmed state in the room directory is found", () => {
    const task = mkTask();
    // The room directory path is the helper's own resolution; plant the state where the child would read it.
    const probe = zeroDiskHasUnconfirmedParts(task, "room");
    expect(probe).toBe(false);
    const roomDir = join(dir, "anchor_douyin_12345");
    mkdirSync(roomDir, { recursive: true });
    writeFileSync(livePumpStatePath(roomDir, "12345"), state([{ confirmed: false }]));
    store.updateTask(task.id, { name: "anchor" });
    expect(zeroDiskHasUnconfirmedParts(store.getTask(task.id)!, "room")).toBe(true);
  });

  it("TaskManager default wiring: unconfirmed state spawns immediately, missing state gates", async () => {
    vi.useFakeTimers();
    const a = store.addTask({ room: "12345", streamUpload: true, outDir: dir });
    const mgr = new TaskManager(store, spawner, { probeLiving: async () => false, random: () => 0, log: () => {} });
    mgr.start(a.id);
    expect(spawner.spawned).toHaveLength(0);
    await mgr.stop(a.id);
    writeFileSync(statePath(), "{broken");
    mgr.start(a.id);
    expect(spawner.spawned).toHaveLength(1);
  });
});

/**
 * Issue #479: the gate passes the Douyin API mode as a per-call option instead of rewriting
 * `process.env`. The old approach was only correct while the platform read the mode synchronously before
 * its first await, and concurrent probes could observe each other's value.
 */
describe("douyin API mode passed to the gate probe (issue #479)", () => {
  afterEach(() => { vi.restoreAllMocks(); delete process.env.DOUYIN_REC_API_MODE; });

  /** Fake platform getLiving that records the per-call apiMode it received (undefined = not passed). */
  function spyMode(platform: ReturnType<typeof platformForRoom>, seen: Array<string | undefined>, result = false) {
    vi.spyOn(platform, "getLiving").mockImplementation(async (_room: string, opts?: { apiMode?: string }) => {
      seen.push(opts?.apiMode);
      return result;
    });
  }

  it("passes settings.douyinApiMode as a per-call option and never touches the env", async () => {
    vi.useRealTimers();
    const platform = platformForRoom("12345");
    const seen: Array<string | undefined> = [];
    spyMode(platform, seen, true);
    const envBefore = process.env.DOUYIN_REC_API_MODE;

    expect(await probeRoomLiving({ room: "12345" }, "web")).toBe(true);
    expect(seen).toEqual(["web"]);
    expect(process.env.DOUYIN_REC_API_MODE).toBe(envBefore); // no mutation at all, before or after the await
  });

  it("two concurrent probes with different modes each see their own mode", async () => {
    vi.useRealTimers();
    const platform = platformForRoom("12345");
    const seen: Array<string | undefined> = [];
    // The second probe resolves only after the first has been observed, so a shared mutable source would bleed.
    let releaseFirst!: () => void;
    const firstSeen = new Promise<void>((r) => { releaseFirst = r; });
    vi.spyOn(platform, "getLiving").mockImplementation(async (_room: string, opts?: { apiMode?: string }) => {
      seen.push(opts?.apiMode);
      await firstSeen;
      return false;
    });
    const envBefore = process.env.DOUYIN_REC_API_MODE;
    const a = probeRoomLiving({ room: "12345" }, "web");
    const b = probeRoomLiving({ room: "12345" }, "mobile");
    expect(seen).toEqual(["web", "mobile"]); // each call carries its own mode
    releaseFirst();
    await Promise.all([a, b]);
    expect(seen).toEqual(["web", "mobile"]);
    expect(process.env.DOUYIN_REC_API_MODE).toBe(envBefore);
  });

  it("no configured mode → the option is omitted, so the platform keeps reading the env", async () => {
    vi.useRealTimers();
    const platform = platformForRoom("12345");
    const seen: Array<string | undefined> = [];
    spyMode(platform, seen);
    process.env.DOUYIN_REC_API_MODE = "mobile";
    await probeRoomLiving({ room: "12345" }, undefined);
    expect(seen).toEqual([undefined]); // not passed: env stays the single default source
    expect(process.env.DOUYIN_REC_API_MODE).toBe("mobile");
  });

  it("TaskManager default probe reads the setting at call time", async () => {
    vi.useFakeTimers();
    const platform = platformForRoom("12345");
    const seen: Array<string | undefined> = [];
    spyMode(platform, seen);
    store.setSetting("douyinApiMode", "webHTML");
    const mgr = new TaskManager(store, spawner, { random: () => 0, log: () => {}, hasUnconfirmedZeroDisk: () => false });
    mgr.start(add());
    await advance(0);
    expect(seen).toEqual(["webHTML"]);
    store.setSetting("douyinApiMode", "balance");
    await advance(30_000);
    expect(seen).toEqual(["webHTML", "balance"]);
  });
});

describe("live gate: crash-restart timer vs gate (single owner of the next spawn)", () => {
  /** Manager with a deferred restart scheduler the test fires by hand. */
  function deferred(probe: (t: Task) => Promise<boolean>): { mgr: TaskManager; fire: () => void } {
    const pending: Array<() => void> = [];
    const mgr = mk(probe, { autoRestart: true, restartDelayMs: 5_000, schedule: (cb) => { pending.push(cb); } });
    return { mgr, fire: () => { for (const cb of pending.splice(0)) cb(); } };
  }

  it("a start() during the restart delay creates a gate; the stale timer must not spawn a second owner", async () => {
    const id = add();
    let live = true;
    const { mgr, fire } = deferred(async () => live);
    mgr.start(id);
    await advance(0);
    expect(spawner.spawned).toHaveLength(1);
    live = false;
    spawner.spawned[0]!.exit({ code: 1, signal: null, expected: false }); // crash: restart timer pending
    expect(mgr.start(id)).toBe(true); // daemon tick / manual start during the delay -> gate
    expect(mgr.isGated(id)).toBe(true);
    fire();
    expect(spawner.spawned).toHaveLength(1); // timer stood down
    live = true;
    await advance(30_000);
    expect(spawner.spawned).toHaveLength(2); // the gate is the only spawner
    expect(mgr.isGated(id)).toBe(false);
  });

  it("stop after that sequence leaves neither a gate nor a later spawn", async () => {
    const id = add();
    let live = true;
    const { mgr, fire } = deferred(async () => live);
    mgr.start(id);
    await advance(0);
    live = false;
    spawner.spawned[0]!.exit({ code: 1, signal: null, expected: false });
    mgr.start(id);
    fire();
    await mgr.stop(id);
    live = true;
    await advance(10 * 60_000);
    expect(mgr.isGated(id)).toBe(false);
    expect(mgr.isRunning(id)).toBe(false);
    expect(spawner.spawned).toHaveLength(1);
    expect(store.getTask(id)!.status).toBe("stopped");
  });

  it("stopGraceful also cancels the gate", async () => {
    const id = add();
    const { mgr } = deferred(async () => false);
    mgr.start(id);
    await advance(0);
    await mgr.stopGraceful(id);
    expect(mgr.isGated(id)).toBe(false);
  });

  it("trySpawn refuses to run while a gate exists (only openGate may spawn)", async () => {
    const id = add();
    const mgr = mk(async () => false);
    mgr.start(id);
    expect((mgr as unknown as { trySpawn(i: number): boolean }).trySpawn(id)).toBe(false);
    expect(spawner.spawned).toHaveLength(0);
  });

  it("probe-failure backoff never polls faster than the platform interval", async () => {
    const id = add();
    const p = platformForRoom("12345");
    const prev = p.pollIntervalMs;
    p.pollIntervalMs = 300_000;
    try {
      const probe = vi.fn(async (): Promise<boolean> => { throw new Error("x"); });
      mk(probe).start(id);
      await advance(0);
      await advance(299_000);
      expect(probe).toHaveBeenCalledTimes(1); // plain backoff would have retried at 30s
      await advance(1_001);
      expect(probe).toHaveBeenCalledTimes(2);
    } finally {
      p.pollIntervalMs = prev;
    }
  });

  it("trySpawn refusing because of a gate sets error + alerts (never leaves running with no owner)", async () => {
    const id = add();
    const downs: string[] = [];
    const mgr = mk(async () => false, { onTaskDown: (_i, r) => downs.push(r) });
    mgr.start(id);
    (mgr as unknown as { trySpawn(i: number): boolean }).trySpawn(id);
    expect(store.getTask(id)!.status).toBe("error");
    expect(downs).toHaveLength(1);
  });

  it("start() taking over a pending crash restart keeps the counter: a crash loop still gives up", async () => {
    const id = add();
    const downs: string[] = [];
    const pending: Array<() => void> = [];
    const mgr = mk(async () => true, {
      autoRestart: true, maxRestarts: 2, restartDelayMs: 5_000, onTaskDown: (_i, r) => downs.push(r),
      schedule: (cb) => { pending.push(cb); },
    });
    mgr.start(id);
    await advance(0);
    for (let i = 0; i < 3 && downs.length === 0; i++) {
      spawner.spawned.at(-1)!.exit({ code: 1, signal: null, expected: false }); // crash -> restart pending
      if (downs.length) break;
      mgr.start(id); // daemon takes over during the delay
      await advance(0);
      pending.splice(0).forEach((cb) => cb());
    }
    expect(downs).toHaveLength(1);
    expect(mgr.restartCooldownRemainingMs(id)).toBeGreaterThan(0);
  });

  it("manual start after give-up still resets the counter", async () => {
    const id = add();
    const mgr = mk(async () => true, { autoRestart: true, maxRestarts: 1, restartDelayMs: 0, schedule: (cb) => cb() });
    mgr.start(id);
    await advance(0);
    spawner.spawned.at(-1)!.exit({ code: 1, signal: null, expected: false }); // restart 1
    spawner.spawned.at(-1)!.exit({ code: 1, signal: null, expected: false }); // gives up
    expect(mgr.restartCooldownRemainingMs(id)).toBeGreaterThan(0);
    expect(mgr.start(id)).toBe(true);
    expect(mgr.restartCooldownRemainingMs(id)).toBe(0);
    await advance(0);
    const n = spawner.spawned.length;
    spawner.spawned.at(-1)!.exit({ code: 1, signal: null, expected: false });
    expect(spawner.spawned.length).toBe(n + 1); // fresh budget: one restart allowed again
  });

  it("a clean exit followed by a fresh start does not inherit a stale counter", async () => {
    const id = add();
    const mgr = mk(async () => true, { autoRestart: true, maxRestarts: 1, restartDelayMs: 0, schedule: (cb) => cb() });
    mgr.start(id);
    await advance(0);
    spawner.spawned.at(-1)!.exit({ code: 1, signal: null, expected: false }); // restart 1 (count=1)
    spawner.spawned.at(-1)!.exit({ code: 0, signal: null, expected: true }); // clean stop, no pending restart
    mgr.start(id);
    await advance(0);
    const n = spawner.spawned.length;
    spawner.spawned.at(-1)!.exit({ code: 1, signal: null, expected: false });
    expect(spawner.spawned.length).toBe(n + 1);
  });
});
