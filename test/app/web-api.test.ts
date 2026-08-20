/**
 * web-api.test.ts — unit tests for the http-free api.ts handlers.
 *
 * The handlers operate over a { store, manager } seam and return
 * { status, body } — no node:http, no real subprocess. We drive them with a
 * real in-memory TaskStore and a mock TaskManager (just records runningIds +
 * start/stop calls) so assertions stay deterministic.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { MergeJobStore } from "../../packages/app/src/merge-jobs.js";
import { EventCenter } from "../../packages/observability/src/bus.js";
import { listHubJobs } from "../../packages/app/src/hub-jobs.js";
import {
  makeApi,
  type ApiDeps,
  type ManagerLike,
  type LoginManagerLike,
} from "../../packages/app/src/web/api.js";

/** Mock TaskManager: an in-memory running set + recorded calls. */
class MockManager implements ManagerLike {
  private running = new Set<number>();
  readonly startCalls: number[] = [];
  readonly stopCalls: number[] = [];
  startError: Error | null = null;
  stopError: Error | null = null;
  /** Test-controllable per-task log lines. */
  readonly logs = new Map<number, string[]>();

  runningIds(): number[] {
    return [...this.running];
  }
  isRunning(id: number): boolean {
    return this.running.has(id);
  }
  start(id: number): boolean {
    this.startCalls.push(id);
    if (this.startError) throw this.startError;
    if (this.running.has(id)) return false;
    this.running.add(id);
    return true;
  }
  async stop(id: number): Promise<void> {
    this.stopCalls.push(id);
    if (this.stopError) throw this.stopError;
    this.running.delete(id);
  }
  readonly gracefulCalls: number[] = [];
  async stopGraceful(id: number): Promise<void> {
    this.gracefulCalls.push(id);
    this.running.delete(id);
  }
  getRuntime(id: number): { running: boolean; startedAt: number | null; elapsedMs: number | null; anchorName: string | null } {
    const running = this.running.has(id);
    return {
      running,
      startedAt: running ? 1_700_000_000_000 : null,
      elapsedMs: running ? 42_000 : null,
      anchorName: null,
    };
  }
  getAnchorName(): string | null {
    return null;
  }
  isRecording(id: number): boolean {
    return this.running.has(id);
  }
  getLogs(id: number): string[] {
    return this.logs.get(id) ?? [];
  }
  /** Test hook: force a task into the running set. */
  forceRunning(id: number): void {
    this.running.add(id);
  }
}

let store: TaskStore;
let manager: MockManager;
let api: ReturnType<typeof makeApi>;

beforeEach(() => {
  store = new TaskStore(":memory:");
  manager = new MockManager();
  const deps: ApiDeps = { store, manager };
  api = makeApi(deps);
});

describe("createTask → resolveAnchor 创建即抓主播名", () => {
  it("注入 resolveAnchor 时，创建后台抓名并持久化，显示用 name>anchorName>room", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const calls: string[] = [];
    const api2 = makeApi({
      store: s,
      manager: m,
      resolveAnchor: async (room) => {
        calls.push(room);
        return "看看新闻Knews";
      },
    });
    const created = (api2.createTask({ room: "39330132276" }).body as { id: number });
    // fire-and-forget：让微任务跑完
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["https://live.douyin.com/39330132276"]); // 入库归一化后的房间
    // 持久化到 store
    expect(s.getTask(created.id)?.anchorName).toBe("看看新闻Knews");
    // 列表显示名走 anchorName（无手动 name 时）
    const listed = (api2.listTasks().body as Array<{ id: number; name: string | null; anchorName: string | null }>)
      .find((t) => t.id === created.id)!;
    expect(listed.name).toBeNull();
    expect(listed.anchorName).toBe("看看新闻Knews");
  });

  it("无 resolveAnchor（测试默认）时不抓，anchorName 为 null", () => {
    const created = api.createTask({ room: "111" }).body as { anchorName: string | null };
    expect(created.anchorName).toBeNull();
  });

  it("v.douyin.com 短链 → 创建后台转成 https://live.douyin.com/<web_rid> 入库", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const api2 = makeApi({
      store: s,
      manager: m,
      resolveShortUrl: async (url) => (/v\.douyin\.com/.test(url) ? "465721793855" : null),
    });
    const created = api2.createTask({ room: "https://v.douyin.com/zRkklNA8WIs" }).body as { id: number; room: string };
    // 创建瞬间还是短链（内部解析能录）
    expect(created.room).toContain("v.douyin.com");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // 后台转换后入库为 live.douyin.com/<web_rid>
    expect(s.getTask(created.id)?.room).toBe("https://live.douyin.com/465721793855");
  });
});

describe("listTasks", () => {
  it("returns tasks with running flag derived from manager", () => {
    const a = store.addTask({ room: "111" });
    const b = store.addTask({ room: "222" });
    manager.forceRunning(b.id);

    const res = api.listTasks();
    expect(res.status).toBe(200);
    const tasks = res.body as Array<{ id: number; running: boolean }>;
    expect(tasks).toHaveLength(2);
    expect(tasks.find((t) => t.id === a.id)!.running).toBe(false);
    expect(tasks.find((t) => t.id === b.id)!.running).toBe(true);
  });
});

describe("createTask", () => {
  it("creates a task and returns it (201)", () => {
    const res = api.createTask({ room: "333", name: "tester", quality: "hd", danmu: 0 });
    expect(res.status).toBe(201);
    const t = res.body as { id: number; room: string; name: string | null; quality: string; danmu: number };
    expect(t.room).toBe("https://live.douyin.com/333"); // 入库归一化
    expect(t.name).toBe("tester");
    expect(t.quality).toBe("hd");
    expect(t.danmu).toBe(0);
    // persisted
    expect(store.getTask(t.id)).not.toBeNull();
  });

  it("coerces useCookie (boolean/number) and defaults to true", () => {
    const def = api.createTask({ room: "uc-default" }).body as { useCookie: boolean };
    expect(def.useCookie).toBe(true);

    const off = api.createTask({ room: "uc-off", useCookie: false }).body as { useCookie: boolean };
    expect(off.useCookie).toBe(false);

    const zero = api.createTask({ room: "uc-zero", useCookie: 0 }).body as { useCookie: boolean };
    expect(zero.useCookie).toBe(false);

    const one = api.createTask({ room: "uc-one", useCookie: 1 }).body as { useCookie: boolean };
    expect(one.useCookie).toBe(true);
  });

  it("listTasks exposes useCookie on each task", () => {
    api.createTask({ room: "lc-on", useCookie: true });
    api.createTask({ room: "lc-off", useCookie: false });
    const tasks = api.listTasks().body as Array<{ room: string; useCookie: boolean }>;
    expect(tasks.find((t) => t.room === "lc-on")!.useCookie).toBe(true);
    expect(tasks.find((t) => t.room === "lc-off")!.useCookie).toBe(false);
  });

  it("400 when room missing/blank", () => {
    expect(api.createTask({} as { room?: string }).status).toBe(400);
    expect(api.createTask({ room: "  " }).status).toBe(400);
    expect(store.listTasks()).toHaveLength(0);
  });

  it("parses schedule HH:MM-HH:MM into start/end", () => {
    const res = api.createTask({ room: "444", schedule: "06:00-09:00" });
    expect(res.status).toBe(201);
    const t = res.body as { scheduleStart: string | null; scheduleEnd: string | null };
    expect(t.scheduleStart).toBe("06:00");
    expect(t.scheduleEnd).toBe("09:00");
  });

  it("400 on malformed schedule", () => {
    expect(api.createTask({ room: "555", schedule: "nonsense" }).status).toBe(400);
  });
});

describe("updateTask", () => {
  it("partial update: only provided fields change, others untouched", () => {
    const a = store.addTask({ room: "111", name: "old", quality: "origin", danmu: 1 });
    const res = api.updateTask(a.id, { name: "new" });
    expect(res.status).toBe(200);
    const t = res.body as { name: string; room: string; quality: string; danmu: number };
    expect(t.name).toBe("new");
    expect(t.room).toBe("https://live.douyin.com/111"); // 入库归一化
    expect(t.quality).toBe("origin");
    expect(t.danmu).toBe(1);
  });

  it("returns the task enriched with running flag", () => {
    const a = store.addTask({ room: "111" });
    manager.forceRunning(a.id);
    const res = api.updateTask(a.id, { name: "x" });
    expect((res.body as { running: boolean }).running).toBe(true);
  });

  it("parses schedule HH:MM-HH:MM into start/end", () => {
    const a = store.addTask({ room: "111" });
    const res = api.updateTask(a.id, { schedule: "06:00-09:00" });
    const t = res.body as { scheduleStart: string | null; scheduleEnd: string | null };
    expect(t.scheduleStart).toBe("06:00");
    expect(t.scheduleEnd).toBe("09:00");
  });

  it("empty schedule string clears scheduleStart/End", () => {
    const a = store.addTask({ room: "111", scheduleStart: "06:00", scheduleEnd: "09:00" });
    const res = api.updateTask(a.id, { schedule: "" });
    const t = res.body as { scheduleStart: string | null; scheduleEnd: string | null };
    expect(t.scheduleStart).toBeNull();
    expect(t.scheduleEnd).toBeNull();
  });

  it("400 on malformed schedule", () => {
    const a = store.addTask({ room: "111" });
    expect(api.updateTask(a.id, { schedule: "nonsense" }).status).toBe(400);
  });

  it("coerces danmu (boolean/number) to 0/1", () => {
    const a = store.addTask({ room: "111", danmu: 1 });
    expect((api.updateTask(a.id, { danmu: false }).body as { danmu: number }).danmu).toBe(0);
    expect((api.updateTask(a.id, { danmu: 1 }).body as { danmu: number }).danmu).toBe(1);
    expect((api.updateTask(a.id, { danmu: 0 }).body as { danmu: number }).danmu).toBe(0);
  });

  it("coerces useCookie (boolean/number) to boolean", () => {
    const a = store.addTask({ room: "111", useCookie: true });
    expect((api.updateTask(a.id, { useCookie: 0 }).body as { useCookie: boolean }).useCookie).toBe(false);
    expect((api.updateTask(a.id, { useCookie: true }).body as { useCookie: boolean }).useCookie).toBe(true);
  });

  it("404 for missing task", () => {
    expect(api.updateTask(9999, { name: "x" }).status).toBe(404);
  });

  it("400 when room is provided but blank", () => {
    const a = store.addTask({ room: "111" });
    expect(api.updateTask(a.id, { room: "   " }).status).toBe(400);
    // unchanged
    expect(store.getTask(a.id)!.room).toBe("https://live.douyin.com/111");
  });

  it("does not change id / createdAt / status", () => {
    const a = store.addTask({ room: "111" });
    manager.forceRunning(a.id);
    store.setStatus(a.id, "running");
    const res = api.updateTask(a.id, { name: "x" });
    const t = res.body as { id: number; createdAt: string; status: string };
    expect(t.id).toBe(a.id);
    expect(t.createdAt).toBe(a.createdAt);
    expect(t.status).toBe("running");
  });
});

describe("getTask", () => {
  it("returns task + running, or 404", () => {
    const a = store.addTask({ room: "111" });
    const ok = api.getTask(a.id);
    expect(ok.status).toBe(200);
    expect((ok.body as { id: number; running: boolean }).running).toBe(false);

    expect(api.getTask(9999).status).toBe(404);
  });

  it("includes runtime { running, startedAt, elapsedMs } from the manager", () => {
    const a = store.addTask({ room: "111" });
    // stopped → null runtime fields
    const stopped = api.getTask(a.id).body as {
      runtime: { running: boolean; startedAt: number | null; elapsedMs: number | null; anchorName: string | null };
    };
    expect(stopped.runtime).toEqual({ running: false, startedAt: null, elapsedMs: null, anchorName: null });

    // running → manager surfaces startedAt + elapsedMs
    manager.forceRunning(a.id);
    const running = api.getTask(a.id).body as {
      running: boolean;
      runtime: { running: boolean; startedAt: number | null; elapsedMs: number | null; anchorName: string | null };
    };
    expect(running.running).toBe(true);
    expect(running.runtime).toEqual({
      running: true,
      startedAt: 1_700_000_000_000,
      elapsedMs: 42_000,
      anchorName: null,
    });
  });
});

describe("getTaskLogs", () => {
  it("404 for a missing task", () => {
    expect(api.getTaskLogs(9999).status).toBe(404);
  });

  it("returns { lines } from the manager for an existing task", () => {
    const a = store.addTask({ room: "111" });
    // empty when nothing captured yet
    expect(api.getTaskLogs(a.id)).toEqual({ status: 200, body: { lines: [] } });

    manager.logs.set(a.id, ["[09:00:00] ▶ 启动", "[09:00:01] recording…"]);
    const res = api.getTaskLogs(a.id);
    expect(res.status).toBe(200);
    expect((res.body as { lines: string[] }).lines).toEqual([
      "[09:00:00] ▶ 启动",
      "[09:00:01] recording…",
    ]);
  });
});

describe("startTask", () => {
  it("404 for missing task", () => {
    expect(api.startTask(9999).status).toBe(404);
  });

  it("enables + (no schedule → eligible) starts immediately → 200, running, enabled", () => {
    const a = store.addTask({ room: "111" }); // 默认 enabled=false，无窗口
    const res = api.startTask(a.id);
    expect(res.status).toBe(200);
    expect(manager.startCalls).toEqual([a.id]); // 无窗口 = eligible → 立即起
    expect(manager.isRunning(a.id)).toBe(true);
    expect(store.getTask(a.id)!.enabled).toBe(true);
    expect((res.body as { enabled: boolean }).enabled).toBe(true);
  });

  it("already running → idempotent enable (200, no extra start)", () => {
    const a = store.addTask({ room: "111" });
    manager.forceRunning(a.id);
    const res = api.startTask(a.id);
    expect(res.status).toBe(200);
    expect(manager.startCalls).toEqual([]); // 已在跑，不重复 start
    expect(store.getTask(a.id)!.enabled).toBe(true);
  });

  it("hub source task 手动启动成功 → 触发立即任务同步", () => {
    const requestSyncTasks = vi.fn();
    const hubDir = mkdtempSync(join(tmpdir(), "start-sync-"));
    const a = makeApi({ store, manager, hubDir, requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    requestSyncTasks.mockClear(); // 建规则本身已触发过一次同步，这里只测手动启停
    expect(a.startTask(t.id).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
  });

  it("非 hub 任务启动成功 → 不触发同步", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir: mkdtempSync(join(tmpdir(), "start-nohub-")), requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    expect(a.startTask(t.id).status).toBe(200);
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });

  it("受管任务禁止手动启动 → 403 且不触发同步", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir: mkdtempSync(join(tmpdir(), "start-managed-")), requestSyncTasks });
    const t = store.addTask({ room: "111", managedBy: "hub" });
    expect(a.startTask(t.id).status).toBe(403);
    expect(store.getTask(t.id)!.enabled).toBe(false);
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });

  it("manager.start 抛错 → 500、enabled 回滚、不触发同步", () => {
    const requestSyncTasks = vi.fn();
    const hubDir = mkdtempSync(join(tmpdir(), "start-error-"));
    const a = makeApi({ store, manager, hubDir, requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    requestSyncTasks.mockClear();
    manager.startError = new Error("spawn failed");
    const res = a.startTask(t.id);
    expect(res.status).toBe(500);
    expect(store.getTask(t.id)!.enabled).toBe(false); // 失败不落库，也不外传
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });
});

describe("stopTask", () => {
  it("disables + HARD stops a running task → 200 (enabled=false, 立即停)", async () => {
    const a = store.addTask({ room: "111", enabled: true });
    manager.forceRunning(a.id);
    const res = await api.stopTask(a.id);
    expect(res.status).toBe(200);
    expect(manager.stopCalls).toEqual([a.id]);   // 硬停（用户主动停=立即）
    expect(manager.gracefulCalls).toEqual([]);    // 不走优雅排空
    expect(store.getTask(a.id)!.enabled).toBe(false); // 停用 → daemon 不再拉起
  });

  it("404 for missing task", async () => {
    expect((await api.stopTask(9999)).status).toBe(404);
  });

  it("hub source task 手动停止成功 → 触发立即任务同步", async () => {
    const requestSyncTasks = vi.fn();
    const hubDir = mkdtempSync(join(tmpdir(), "stop-sync-"));
    const a = makeApi({ store, manager, hubDir, requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    requestSyncTasks.mockClear();
    store.setEnabled(t.id, true);
    expect((await a.stopTask(t.id)).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
  });

  it("非 hub 任务停止成功 → 不触发同步", async () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir: mkdtempSync(join(tmpdir(), "stop-nohub-")), requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    store.setEnabled(t.id, true);
    expect((await a.stopTask(t.id)).status).toBe(200);
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });

  it("受管任务禁止手动停止 → 403 且不触发同步", async () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir: mkdtempSync(join(tmpdir(), "stop-managed-")), requestSyncTasks });
    const t = store.addTask({ room: "111", managedBy: "hub", enabled: true });
    expect((await a.stopTask(t.id)).status).toBe(403);
    expect(store.getTask(t.id)!.enabled).toBe(true);
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });

  it("internal 停止放行 hub 受管任务(仅本机回环 _apply-tasks 通道)", async () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir: mkdtempSync(join(tmpdir(), "stop-internal-")), requestSyncTasks });
    const t = store.addTask({ room: "111", managedBy: "hub", enabled: true });
    manager.forceRunning(t.id);
    const res = await a.stopTask(t.id, { internal: true });
    expect(res.status).toBe(200);
    expect(manager.stopCalls).toEqual([t.id]);
    expect(store.getTask(t.id)!.enabled).toBe(false);
    expect(requestSyncTasks).not.toHaveBeenCalled(); // 节点内部硬停不回 master 同步
  });

  it("manager.stop 抛错 → 500、enabled 回滚、不触发同步", async () => {
    const requestSyncTasks = vi.fn();
    const hubDir = mkdtempSync(join(tmpdir(), "stop-error-"));
    const a = makeApi({ store, manager, hubDir, requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    store.setEnabled(t.id, true);
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    requestSyncTasks.mockClear();
    manager.forceRunning(t.id);
    manager.stopError = new Error("SIGTERM timeout");
    const res = await a.stopTask(t.id);
    expect(res.status).toBe(500);
    expect(store.getTask(t.id)!.enabled).toBe(true); // 失败保持原状态，不外传
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });
});

describe("deleteTask", () => {
  it("404 for missing task", async () => {
    expect((await api.deleteTask(9999)).status).toBe(404);
  });

  it("deletes a stopped task (enabled=false, not running)", async () => {
    const a = store.addTask({ room: "111" }); // 默认 enabled=false
    const res = await api.deleteTask(a.id);
    expect(res.status).toBe(200);
    expect(store.getTask(a.id)).toBeNull();
  });

  it("refuses to delete a RUNNING task → 409 (must stop first)", async () => {
    const a = store.addTask({ room: "111" });
    manager.forceRunning(a.id);
    const res = await api.deleteTask(a.id);
    expect(res.status).toBe(409);
    expect(store.getTask(a.id)).not.toBeNull(); // 未删除
  });

  it("refuses to delete an ENABLED task → 409 (must stop first)", async () => {
    const a = store.addTask({ room: "111", enabled: true });
    const res = await api.deleteTask(a.id);
    expect(res.status).toBe(409);
    expect(store.getTask(a.id)).not.toBeNull();
  });
});

describe("login handlers", () => {
  /** Mock login manager (the LoginManagerLike slice). */
  class MockLogin implements LoginManagerLike {
    pollResult: { state: string; cookie?: string } = { state: "pending" };
    async start(): Promise<{ sessionId: string; qrPng: string }> {
      return { sessionId: "login-1", qrPng: "QQ==" };
    }
    async poll(sessionId: string): Promise<{ state: string; cookie?: string }> {
      if (sessionId !== "login-1") return { state: "unknown" };
      return this.pollResult;
    }
  }

  it("501 when no login manager is wired (playwright absent)", async () => {
    const noLogin = makeApi({ store, manager });
    expect((await noLogin.startLogin()).status).toBe(501);
    expect((await noLogin.pollLogin("x")).status).toBe(501);
  });

  it("startLogin returns sessionId + qrPng", async () => {
    const login = new MockLogin();
    const a = makeApi({ store, manager, login });
    const res = await a.startLogin();
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId: "login-1", qrPng: "QQ==" });
  });

  it("pollLogin returns state pending, and 404 for unknown session", async () => {
    const login = new MockLogin();
    const a = makeApi({ store, manager, login });
    const r = await a.pollLogin("login-1");
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("pending");
    expect((await a.pollLogin("nope")).status).toBe(404);
  });

  it("pollLogin returns state confirmed WITHOUT leaking the raw cookie", async () => {
    const login = new MockLogin();
    login.pollResult = { state: "confirmed", cookie: "sessionid=abc" };
    const a = makeApi({ store, manager, login });
    const r = await a.pollLogin("login-1");
    expect(r.status).toBe(200);
    expect((r.body as { state: string }).state).toBe("confirmed");
    // privacy: the raw cookie is never surfaced through poll anymore.
    expect((r.body as Record<string, unknown>).cookie).toBeUndefined();
  });
});

describe("cookie handlers (global account cookie)", () => {
  it("GET reports unset when no cookie stored", () => {
    const res = api.getCookie();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ set: false, hasSession: false, length: 0, expiresAt: null });
  });

  it("POST sets the cookie; GET reflects set + hasSession (sessionid present)", () => {
    const post = api.setCookie({ cookie: "  x=1; sessionid=abc  " });
    expect(post.status).toBe(200);
    // stored value is trimmed
    expect(store.getSetting("defaultCookies")).toBe("x=1; sessionid=abc");
    const get = api.getCookie();
    expect(get.body).toEqual({
      set: true,
      hasSession: true,
      length: "x=1; sessionid=abc".length,
      expiresAt: null,
    });
  });

  it("GET cookie: 从 sid_guard 解析出过期时间 expiresAt", () => {
    // sid_guard = token|登录时间戳秒|有效期秒|过期GMT串（| 可能被 URL 编码为 %7C）
    api.setCookie({ cookie: "sessionid=abc; sid_guard=tok%7C1781324389%7C5184000%7CWed" });
    const body = api.getCookie().body as { expiresAt: number | null };
    expect(body.expiresAt).toBe((1781324389 + 5184000) * 1000);
  });

  it("hasSession false when cookie has no sessionid", () => {
    api.setCookie({ cookie: "ttwid=foo; bar=baz" });
    expect(api.getCookie().body).toMatchObject({ set: true, hasSession: false });
  });

  it("detects sessionid_ss too", () => {
    api.setCookie({ cookie: "sessionid_ss=deadbeef" });
    expect(api.getCookie().body).toMatchObject({ set: true, hasSession: true });
  });

  it("POST 400 on empty/blank cookie", () => {
    expect(api.setCookie({}).status).toBe(400);
    expect(api.setCookie({ cookie: "   " }).status).toBe(400);
    expect(store.getSetting("defaultCookies")).toBeNull();
  });

  it("DELETE clears the cookie → GET unset (empty treated as unset)", () => {
    api.setCookie({ cookie: "sessionid=abc" });
    const del = api.clearCookie();
    expect(del.status).toBe(200);
    expect(del.body).toEqual({ set: false, hasSession: false, length: 0, expiresAt: null });
    expect(api.getCookie().body).toEqual({ set: false, hasSession: false, length: 0, expiresAt: null });
  });
});

describe("每任务 webhook 字段", () => {
  it("创建带 webhook → 持久化 + DTO 暴露;空串归一化为 null(回落全局)", () => {
    const a = api.createTask({ room: "111", webhook: "https://discord.test/hook" }).body as { id: number; webhook: string | null };
    expect(a.webhook).toBe("https://discord.test/hook");
    const b = api.createTask({ room: "222", webhook: "   " }).body as { webhook: string | null };
    expect(b.webhook).toBeNull();
    const c = api.createTask({ room: "333" }).body as { webhook: string | null };
    expect(c.webhook).toBeNull();
  });

  it("PATCH 更新 webhook;传空串清空回 null", () => {
    const t = api.createTask({ room: "111" }).body as { id: number };
    expect((api.updateTask(t.id, { webhook: "https://x/y" }).body as { webhook: string | null }).webhook).toBe("https://x/y");
    expect((api.updateTask(t.id, { webhook: "" }).body as { webhook: string | null }).webhook).toBeNull();
  });
});

describe("GET /recordings + POST /merge 校验", () => {
  it("listRecordings 未知任务 → 404", () => {
    expect(api.listRecordings(9999).status).toBe(404);
  });

  it("listRecordings 无录制目录 → 200 空列表", () => {
    const t = api.createTask({ room: "111", name: "测试主播" }).body as { id: number };
    const r = api.listRecordings(t.id);
    expect(r.status).toBe(200);
    expect((r.body as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it("listRecordings 列出会话(按 base 时间序),hasXml 反映会话级 .xml", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec_"));
    const sub = join(dir, "主播A");
    mkdirSync(sub, { recursive: true });
    // 两个会话:S2 有 2 段 + 会话级 xml;S1 单段无 xml。乱序写,期望按 base 排序。
    writeFileSync(join(sub, "主播A_2026-06-15_10-00-00.ts"), "");
    writeFileSync(join(sub, "主播A_2026-06-15_08-00-00_001.ts"), "");
    writeFileSync(join(sub, "主播A_2026-06-15_08-00-00_002.ts"), "");
    writeFileSync(join(sub, "主播A_2026-06-15_08-00-00.xml"), "<i></i>");
    const t = api.createTask({ room: "111", name: "主播A", outDir: dir }).body as { id: number };
    const body = api.listRecordings(t.id).body as { sessions: { base: string; segments: number; hasXml: boolean }[] };
    expect(body.sessions.map((s) => s.base)).toEqual([
      "主播A_2026-06-15_08-00-00",
      "主播A_2026-06-15_10-00-00",
    ]);
    expect(body.sessions[0]).toMatchObject({ segments: 2, hasXml: true });
    expect(body.sessions[1]).toMatchObject({ segments: 1, hasXml: false });
    rmSync(dir, { recursive: true, force: true });
  });

  it("startMerge 未启用 mergeJobs → 501", () => {
    const t = api.createTask({ room: "111", name: "X" }).body as { id: number };
    expect(api.startMerge(t.id, { sessions: ["a"] }).status).toBe(501);
  });

  it("startMerge 空选择 → 400;未知会话 → 400;getMerge 未知 → 404", () => {
    const dir = mkdtempSync(join(tmpdir(), "rec_"));
    const sub = join(dir, "X");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "X_2026-06-15_08-00-00.ts"), "");
    const mergeJobs = new MergeJobStore(store.db);
    const api2 = makeApi({ store, manager, mergeJobs });
    const t = api2.createTask({ room: "111", name: "X", outDir: dir }).body as { id: number };
    expect(api2.startMerge(t.id, { sessions: [] }).status).toBe(400);
    expect(api2.startMerge(t.id, { sessions: ["不存在"] }).status).toBe(400);
    expect(api2.getMerge("nope").status).toBe(404);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET /api/events", () => {
  it("无 events 依赖 → 空流;注入 EventCenter → 增量返回 + 推进游标", () => {
    const noEvents = api.getEvents(0);
    expect(noEvents.status).toBe(200);
    expect(noEvents.body).toEqual({ events: [], cursor: 0 });

    const events = new EventCenter();
    const api2 = makeApi({ store, manager, events });
    events.emit(1, { kind: "mergeDone", file: "/x.mp4" });
    const r = api2.getEvents(0).body as { events: { event: { kind: string } }[]; cursor: number };
    expect(r.events.map((e) => e.event.kind)).toEqual(["mergeDone"]);
    expect(r.cursor).toBe(1);
    expect((api2.getEvents(1).body as { events: unknown[] }).events).toEqual([]);
  });
});

describe("全局 webhook 端点", () => {
  it("get 默认空;set 持久化 + 回读;set 空串清除", () => {
    expect((api.getWebhook().body as { webhook: string }).webhook).toBe("");
    expect((api.setWebhook({ webhook: " https://discord/api/webhooks/x " }).body as { webhook: string }).webhook).toBe("https://discord/api/webhooks/x");
    expect((api.getWebhook().body as { webhook: string }).webhook).toBe("https://discord/api/webhooks/x");
    expect(store.getSetting("discordWebhook")).toBe("https://discord/api/webhooks/x");
    expect((api.setWebhook({ webhook: "" }).body as { webhook: string }).webhook).toBe("");
  });
});

describe("通知类型 webhook 开关端点", () => {
  it("get 默认全关;put 持久化 + 回读;未知键/非布尔丢弃", () => {
    const off = { live: false, recordEnd: false, merge: false, hub: false, error: false };
    expect(api.getNotifSettings().body).toEqual(off);

    const r = api.setNotifSettings({ live: true, error: true, merge: "yes" as never, future: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ...off, live: true, error: true });
    expect(store.getSetting("notifWebhookToggles")).toContain('"live":true');
    expect(store.getSetting("notifWebhookToggles")).not.toContain("future");
    expect(api.getNotifSettings().body).toEqual({ ...off, live: true, error: true });

    // 关闭某类后再回读,其余保持。
    api.setNotifSettings({ error: false });
    expect(api.getNotifSettings().body).toEqual({ ...off, live: true });
  });
});

describe("hub workers 端点(CRUD + hubEnabled 门)", () => {
  function apiWith(hubEnabled: boolean): { api: ReturnType<typeof makeApi>; cfg: string } {
    const cfg = join(mkdtempSync(join(tmpdir(), "wapi-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ platform: "douyin",
      workers: [{ id: "local", name: "本机", kind: "local", dataRoot: "/data" }] }, null, 2));
    return { api: makeApi({ store, manager, hubEnabled, hubConfigPath: cfg }), cfg };
  }
  it("hub 未启用 → 端点返回 400 hub 未启用", () => {
    const { api: a } = apiWith(false);
    expect(a.listWorkers().status).toBe(400);
    expect(a.createWorker({ kind: "ssh", host: "h", dataRoot: "/d" }).status).toBe(400);
  });
  it("list 含 local;create 返 worker-1;update/delete 往返", () => {
    const { api: a } = apiWith(true);
    expect((a.listWorkers().body as any[]).map((w) => w.id)).toEqual(["local"]);
    const c = a.createWorker({ kind: "ssh", host: "1.2.3.4", dataRoot: "/drec", name: "港" });
    expect(c.status).toBe(201);
    expect((c.body as any).id).toBe("worker-1");
    expect(a.updateWorker("worker-1", { name: "港2" }).status).toBe(200);
    expect(a.deleteWorker("worker-1").status).toBe(200);
    expect(a.deleteWorker("worker-1").status).toBe(404);   // 已删
  });
  it("create 校验错 → 400;local 保护 → 400", () => {
    const { api: a } = apiWith(true);
    expect(a.createWorker({ kind: "ssh", dataRoot: "/d" } as any).status).toBe(400); // 缺 host
    expect(a.deleteWorker("local").status).toBe(400);
    expect(a.updateWorker("local", { kind: "ssh" }).status).toBe(400);
  });
  it("testWorker:注入 fake → 端点透传结果;未注入(hub 未启用)→ 400", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "wt-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const fake = vi.fn(async () => ({ ok: true }));
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, testWorker: fake });
    const r = await a.testWorker({ kind: "ssh", host: "h", dataRoot: "/d" });
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(true);
    expect(fake).toHaveBeenCalledOnce();
    const noDep = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg });
    expect((await noDep.testWorker({ kind: "ssh", host: "h", dataRoot: "/d" })).status).toBe(400);
  });
  it("testWorker:注入 fake RESOLVES 不可达 → 200 + 结构化 {ok:false,...}(不是错误状态码)", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "wt-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const fake = vi.fn(async () => ({ ok: false, error: "连接测试超时 20000ms" }));
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, testWorker: fake });
    const r = await a.testWorker({ kind: "ssh", host: "h", dataRoot: "/d" });
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(false);
    expect((r.body as any).error).toBe("连接测试超时 20000ms");
  });
  it("testWorker:注入 fake THROWS → catch 分支仍回 200 结构化 error(绝不 500/崩)", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "wt-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const fake = vi.fn(async () => { throw new Error("ECONNREFUSED"); });
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, testWorker: fake });
    const r = await a.testWorker({ kind: "ssh", host: "h", dataRoot: "/d" });
    expect(r.status).toBe(200);
    expect((r.body as any).ok).toBe(false);
    expect((r.body as any).error).toBe("ECONNREFUSED");
  });
  it("workersStatus:注入 probeAllWorkers fake → 端点透传数组", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "ws-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const fake = vi.fn(async () => [
      { id: "local", ok: true },
      { id: "worker-1", ok: false, error: "ssh ping 超时 6000ms" },
    ]);
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, probeAllWorkers: fake });
    const r = await a.workersStatus();
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { id: "local", ok: true },
      { id: "worker-1", ok: false, error: "ssh ping 超时 6000ms" },
    ]);
    expect(fake).toHaveBeenCalledOnce();
  });
  it("workersStatus:未注入 probeAllWorkers → 200 []", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "ws-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg });
    const r = await a.workersStatus();
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
  it("workersStatus:probeAllWorkers 抛错 → 200 [](不崩)", async () => {
    const cfg = join(mkdtempSync(join(tmpdir(), "ws-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [] }));
    const fake = vi.fn(async () => { throw new Error("boom"); });
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, probeAllWorkers: fake });
    const r = await a.workersStatus();
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
  });
});

describe("hub 单节点重跑端点", () => {
  it("注入 retryNode → 200 + 透传结果,force 透传 true", async () => {
    const fake = vi.fn(async (_key: string, node: string, opts?: { force?: boolean }) =>
      ({ ok: true, node, force: opts?.force === true }));
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "retry-")), "x-sync.db"),
      retryNode: fake,
    });
    const r = await a.retryHubNode("douyin:123:2026-08-10", { node: "upload_plain", force: true });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, node: "upload_plain", force: true });
    expect(fake).toHaveBeenCalledWith("douyin:123:2026-08-10", "upload_plain", { force: true });
  });
  it("缺 node → 400 且不调 retryNode", async () => {
    const fake = vi.fn(async () => ({ ok: true }));
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "retry-")), "x-sync.db"),
      retryNode: fake,
    });
    const r = await a.retryHubNode("douyin:123:2026-08-10", {});
    expect(r.status).toBe(400);
    expect(fake).not.toHaveBeenCalled();
  });
  it("未注入 retryNode/syncDbPath → 400 hub 未启用", async () => {
    const a = makeApi({ store, manager });
    const r = await a.retryHubNode("douyin:123:2026-08-10", { node: "merge" });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toContain("hub 未启用");
  });
});

describe("hub 停止 / 立即执行端点", () => {
  it("注入 stopJob → 200 + 透传结果", async () => {
    const fake = vi.fn(async (key: string) => ({ ok: true, streamKey: key }));
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "stop-")), "x-sync.db"),
      stopJob: fake,
    });
    const r = await a.stopHubJob("douyin:123:2026-08-10");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, streamKey: "douyin:123:2026-08-10" });
    expect(fake).toHaveBeenCalledWith("douyin:123:2026-08-10");
  });
  it("stopJob 失败 → 透传 code", async () => {
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "stop-")), "x-sync.db"),
      stopJob: async () => ({ ok: false, error: "已完成,不能停止", code: 409 }),
    });
    const r = await a.stopHubJob("douyin:123:2026-08-10");
    expect(r.status).toBe(409);
    expect((r.body as { error?: string }).error).toContain("已完成");
  });
  it("未注入 stopJob/syncDbPath → 400 hub 未启用", async () => {
    const a = makeApi({ store, manager });
    const r = await a.stopHubJob("douyin:123:2026-08-10");
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toContain("hub 未启用");
  });
  it("注入 runNow → 默认 202,wait/winnerWorker 透传", async () => {
    const fake = vi.fn(async (opts: { streamKey: string; winnerWorker?: string; wait?: boolean }) =>
      ({ ok: true, code: opts.wait ? 200 : 202, streamKey: opts.streamKey }));
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "run-")), "x-sync.db"),
      runNow: fake,
    });
    const r = await a.runHubJob({ streamKey: "douyin:123:2026-08-10", winnerWorker: "vps", wait: false });
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ ok: true, code: 202, streamKey: "douyin:123:2026-08-10" });
    expect(fake).toHaveBeenCalledWith({ streamKey: "douyin:123:2026-08-10", winnerWorker: "vps", wait: false });
  });
  it("runNow wait=true → 200", async () => {
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "run-")), "x-sync.db"),
      runNow: async () => ({ ok: true, code: 200, streamKey: "douyin:123:2026-08-10" }),
    });
    const r = await a.runHubJob({ streamKey: "douyin:123:2026-08-10", wait: true });
    expect(r.status).toBe(200);
  });
  it("缺 streamKey → 400 且不调 runNow", async () => {
    const fake = vi.fn(async () => ({ ok: true, code: 202 }));
    const a = makeApi({
      store,
      manager,
      syncDbPath: join(mkdtempSync(join(tmpdir(), "run-")), "x-sync.db"),
      runNow: fake,
    });
    const r = await a.runHubJob({});
    expect(r.status).toBe(400);
    expect(fake).not.toHaveBeenCalled();
  });
  it("未注入 runNow/syncDbPath → 400 hub 未启用", async () => {
    const a = makeApi({ store, manager });
    const r = await a.runHubJob({ streamKey: "douyin:123:2026-08-10" });
    expect(r.status).toBe(400);
    expect((r.body as { error?: string }).error).toContain("hub 未启用");
  });
});

describe("hub rules workers 字段(校验 + 往返)", () => {
  function apiWithHubDir(): ReturnType<typeof makeApi> {
    const hubDir = mkdtempSync(join(tmpdir(), "hubrules-"));
    return makeApi({ store, manager, hubDir });
  }
  it("createHubRule 带空 workers → 400", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: [] });
    expect(r.status).toBe(400);
  });
  it("createHubRule 带非空 workers → 201 且回显", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local", "vps2"] });
    expect(r.status).toBe(201);
    expect((r.body as { workers?: string[] }).workers).toEqual(["local", "vps2"]);
  });
  it("createHubRule 不带 workers → 201(向后兼容,workers 缺省)", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id } });
    expect(r.status).toBe(201);
    expect((r.body as { workers?: string[] }).workers).toBeUndefined();
  });
  it("createHubRule workers 含非字符串 → 400", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: [1 as unknown as string] });
    expect(r.status).toBe(400);
  });
  it("updateHubRule 改 workers 生效", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local", "vps2"] });
    const u = a.updateHubRule("douyin.123456", { workers: ["local"] });
    expect(u.status).toBe(200);
    expect((u.body as { workers?: string[] }).workers).toEqual(["local"]);
  });
  it("updateHubRule 带空 workers → 400", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    expect(a.updateHubRule("douyin.123456", { workers: [] }).status).toBe(400);
  });
});

describe("hub 规则/worker 变更立即触发任务同步", () => {
  it("createHubRule 成功后调用 requestSyncTasks", () => {
    const requestSyncTasks = vi.fn();
    const hubDir = mkdtempSync(join(tmpdir(), "hubsync-"));
    const a = makeApi({ store, manager, hubDir, requestSyncTasks });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    expect(requestSyncTasks).not.toHaveBeenCalled();
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    expect(r.status).toBe(201);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
  });
  it("update/deleteHubRule 成功后也触发;校验失败不触发", () => {
    const requestSyncTasks = vi.fn();
    const hubDir = mkdtempSync(join(tmpdir(), "hubsync-"));
    const a = makeApi({ store, manager, hubDir, requestSyncTasks });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id } });
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
    expect(a.updateHubRule("douyin.123456", { enabled: false }).status).toBe(200);
    expect(a.deleteHubRule("douyin.123456").status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(3);
    expect(a.createHubRule({}).status).toBe(400);
    expect(requestSyncTasks).toHaveBeenCalledTimes(3);
  });
  it("create/update/deleteWorker 成功后触发", () => {
    const requestSyncTasks = vi.fn();
    const cfg = join(mkdtempSync(join(tmpdir(), "wsync-")), "hub.config.json");
    writeFileSync(cfg, JSON.stringify({ workers: [{ id: "local", kind: "local", dataRoot: "/data" }] }));
    const a = makeApi({ store, manager, hubEnabled: true, hubConfigPath: cfg, requestSyncTasks });
    expect(a.createWorker({ kind: "ssh", host: "1.2.3.4", dataRoot: "/drec" }).status).toBe(201);
    expect(a.updateWorker("worker-1", { name: "港2" }).status).toBe(200);
    expect(a.deleteWorker("worker-1").status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(3);
  });
});

describe("删除 hub 规则同时清理该直播间历史 run", () => {
  function makeSyncDb(): string {
    const p = join(mkdtempSync(join(tmpdir(), "hubdel-")), "sync.db");
    const db = new DatabaseSync(p);
    db.exec(`CREATE TABLE sync_jobs(streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE sync_job_events(streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
    db.exec(`CREATE TABLE sync_job_steps(streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT)`);
    db.exec(`CREATE TABLE sync_candidates(streamKey TEXT NOT NULL, workerId TEXT NOT NULL,
      coverage REAL NOT NULL, durationSec REAL NOT NULL, startMs INTEGER NOT NULL, endMs INTEGER NOT NULL,
      totalGapSec REAL NOT NULL, isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, workerId))`);
    db.exec(`CREATE TABLE sync_node_states(streamKey TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL,
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, node))`);
    db.close();
    return p;
  }

  it("删除成功后清掉该房间历史,其他房间不动", () => {
    const syncDbPath = makeSyncDb();
    const hubDir = mkdtempSync(join(tmpdir(), "hubdel-rule-"));
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir, syncDbPath, requestSyncTasks });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id } });

    const db = new DatabaseSync(syncDbPath);
    db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,error,fails,updatedAt) VALUES(?,?,?,?,?,0,?)")
      .run("douyin:123456:2026-08-11", "done", "local", null, null, 1_700_000_000_000);
    db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,error,fails,updatedAt) VALUES(?,?,?,?,?,0,?)")
      .run("douyin:999:2026-08-11", "done", "local", null, null, 1_700_000_000_001);
    db.close();

    const r = a.deleteHubRule("douyin.123456");
    expect(r.status).toBe(200);
    expect((r.body as { deletedHistory: number }).deletedHistory).toBe(1);
    expect(requestSyncTasks).toHaveBeenCalledTimes(2);
    const { jobs } = listHubJobs(syncDbPath, { limit: 50 });
    expect(jobs.map((j) => j.streamKey)).toEqual(["douyin:999:2026-08-11"]);
  });

  it("有进行中 run → 409 且规则保留;终态后可删", () => {
    const syncDbPath = makeSyncDb();
    const hubDir = mkdtempSync(join(tmpdir(), "hubdel-active-"));
    const a = makeApi({ store, manager, hubDir, syncDbPath });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id } });

    const db = new DatabaseSync(syncDbPath);
    db.prepare("INSERT INTO sync_jobs(streamKey,state,winnerWorker,bv,error,fails,updatedAt) VALUES(?,?,?,?,?,0,?)")
      .run("douyin:123456:2026-08-11", "merging", "local", null, null, 1_700_000_000_000);
    db.close();

    const blocked = a.deleteHubRule("douyin.123456");
    expect(blocked.status).toBe(409);
    expect((blocked.body as { error: string }).error).toContain("进行中");
    expect((a.listHubRules().body as { key: string }[]).some((r) => r.key === "douyin.123456")).toBe(true);

    const db2 = new DatabaseSync(syncDbPath);
    db2.prepare("UPDATE sync_jobs SET state='done' WHERE streamKey=?").run("douyin:123456:2026-08-11");
    db2.close();
    expect(a.deleteHubRule("douyin.123456").status).toBe(200);
  });
});

describe("hub 受管任务与规则录制下发", () => {
  function apiWithHubDir(): ReturnType<typeof makeApi> {
    const hubDir = mkdtempSync(join(tmpdir(), "hubmanaged-"));
    return makeApi({ store, manager, hubDir });
  }
  it("受管任务(managedBy=hub)禁止编辑 → 403 且字段不动", () => {
    const a = apiWithHubDir();
    const t = store.addTask({ room: "123456", managedBy: "hub" });
    const r = a.updateTask(t.id, { name: "hack" });
    expect(r.status).toBe(403);
    expect(store.getTask(t.id)!.name).toBeNull();
  });
  it("受管任务禁止删除 → 403(即使已停用)", async () => {
    const a = apiWithHubDir();
    const t = store.addTask({ room: "123456", managedBy: "hub", enabled: false });
    const r = await a.deleteTask(t.id);
    expect(r.status).toBe(403);
    expect(store.getTask(t.id)).not.toBeNull();
  });
  it("createHubRule 绑定不存在的 sourceTask → 400", () => {
    const a = apiWithHubDir();
    const r = a.createHubRule({ recording: { sourceTaskId: 9999 } });
    expect(r.status).toBe(400);
  });
  it("createHubRule 未绑定 sourceTask → 400", () => {
    const a = apiWithHubDir();
    const r = a.createHubRule({});
    expect(r.status).toBe(400);
  });
  it("createHubRule 绑定 sourceTask → 201,房间/key 取自任务,DTO 解析 sourceTask", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456", name: "主播A" }).body as { id: number };
    const r = a.createHubRule({ workers: ["local"], recording: { sourceTaskId: t.id } });
    expect(r.status).toBe(201);
    const body = r.body as {
      key: string;
      room: string;
      roomSlug: string;
      recording?: { sourceTaskId?: number | null };
      sourceTask?: { id: number; name: string | null } | null;
    };
    expect(body.key).toBe("douyin.123456");
    expect(body.roomSlug).toBe("123456");
    expect(body.room).toBe("https://live.douyin.com/123456");
    expect(body.recording?.sourceTaskId).toBe(t.id);
    expect(body.sourceTask?.id).toBe(t.id);
    expect(body.sourceTask?.name).toBe("主播A");
    const listed = (a.listHubRules().body as Array<{ recording?: { sourceTaskId?: number | null }; sourceTask?: { id: number } | null }>)
      .find((x) => x.recording?.sourceTaskId === t.id)!;
    expect(listed.sourceTask?.id).toBe(t.id);
  });
  it("updateHubRule 可挂载 / 清空 recording", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id } });
    const clear = a.updateHubRule("douyin.123456", { recording: { sourceTaskId: null } });
    expect(clear.status).toBe(200);
    expect((clear.body as { recording?: { sourceTaskId?: number | null } }).recording?.sourceTaskId).toBeNull();
    const attach = a.updateHubRule("douyin.123456", { recording: { sourceTaskId: t.id } });
    expect(attach.status).toBe(200);
    expect((attach.body as { recording?: { sourceTaskId?: number | null } }).recording?.sourceTaskId).toBe(t.id);
  });
});
