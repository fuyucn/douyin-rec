/**
 * web-api.test.ts — unit tests for the http-free api.ts handlers.
 *
 * The handlers operate over a { store, manager } seam and return
 * { status, body } — no node:http, no real subprocess. We drive them with a
 * real in-memory TaskStore and a mock TaskManager (just records runningIds +
 * start/stop calls) so assertions stay deterministic.
 */
import { buildRecordArgs } from "../../packages/app/src/process/record-args.js";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { MergeJobStore } from "../../packages/app/src/merge-jobs.js";
import { EventCenter } from "../../packages/observability/src/bus.js";
import { listHubJobs } from "../../packages/app/src/hub-jobs.js";
import { upsertHubRule } from "../../packages/app/src/hub-store.js";
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
  async stopWithin(id: number, _ms: number): Promise<boolean> {
    await this.stop(id);
    return true;
  }
  /** Test-controllable:哪些任务处于硬停收尾中。 */
  readonly stopping = new Set<number>();
  isStopping(id: number): boolean {
    return this.stopping.has(id);
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

describe("抖音 API 模式设置端点", () => {
  it("未设置 → mode 空,effective 回落默认 balance,options 含全部可选值", () => {
    const r = api.getDouyinApiMode();
    expect(r.status).toBe(200);
    const b = r.body as { mode: string; default: string; effective: string; options: string[] };
    expect(b.mode).toBe("");
    expect(b.default).toBe("balance");
    expect(b.effective).toBe("balance");
    expect(b.options).toEqual(["balance", "web", "webHTML", "mobile", "random"]);
  });
  it("设置合法值 → 存归一值并回显", () => {
    const r = api.setDouyinApiMode({ mode: "web" });
    expect(r.status).toBe(200);
    expect((r.body as { mode: string }).mode).toBe("web");
    // 落盘 + 再读一致
    expect((api.getDouyinApiMode().body as { mode: string }).mode).toBe("web");
    expect(store.getSetting("douyinApiMode")).toBe("web");
  });
  it("非法值 → 回落默认 balance(不报错)", () => {
    const r = api.setDouyinApiMode({ mode: "bogus" });
    expect(r.status).toBe(200);
    expect((r.body as { mode: string }).mode).toBe("balance");
    expect(store.getSetting("douyinApiMode")).toBe("balance");
  });
  it("空值/缺省 → 回落默认 balance", () => {
    api.setDouyinApiMode({ mode: "web" });
    const r = api.setDouyinApiMode({});
    expect((r.body as { mode: string }).mode).toBe("balance");
  });
});

/**
 * 建一个带 worker 配置的临时 hub 环境。
 * hub 规则里的 worker id 现在必须真实存在(防幽灵 id 导致本机抑制 + 远端没人接的静默漏录),
 * 所以凡是要建规则的用例都要把 hubConfigPath 一起注入。
 */
function hubDeps(prefix: string, extra: Partial<ApiDeps> = {}): Partial<ApiDeps> {
  const hubDir = mkdtempSync(join(tmpdir(), prefix));
  const hubConfigPath = join(hubDir, "hub.config.json");
  writeFileSync(hubConfigPath, JSON.stringify({
    workers: [
      { id: "local", name: "本机", kind: "local", dataRoot: "/data" },
      { id: "vps2", name: "VPS", kind: "ssh", host: "1.2.3.4", dataRoot: "/drec" },
    ],
  }, null, 2));
  return { hubDir, hubConfigPath, ...extra };
}

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

  it("refreshTaskAnchor:anchorName 为空时补抓并持久化", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const calls: string[] = [];
    const api2 = makeApi({
      store: s,
      manager: m,
      resolveAnchor: async (room) => {
        calls.push(room);
        return "补抓的主播";
      },
    });
    // 模拟 VPS 上「同步建出来但 anchorName=null」的受管任务。
    const t = s.addTask({ room: "https://live.douyin.com/123456", managedBy: "hub" });
    expect(s.getTask(t.id)?.anchorName).toBeNull();
    const r = api2.refreshTaskAnchor(t.id);
    expect(r.status).toBe(200);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(["https://live.douyin.com/123456"]);
    expect(s.getTask(t.id)?.anchorName).toBe("补抓的主播");
  });

  it("refreshTaskAnchor:已有 anchorName 时不重复抓（省平台 API）", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const calls: string[] = [];
    const api2 = makeApi({
      store: s,
      manager: m,
      resolveAnchor: async (room) => {
        calls.push(room);
        return "新名字";
      },
    });
    const t = s.addTask({ room: "https://live.douyin.com/123456", managedBy: "hub" });
    s.setAnchorName(t.id, "已有名字");
    api2.refreshTaskAnchor(t.id);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual([]);                       // 未发起抓取
    expect(s.getTask(t.id)?.anchorName).toBe("已有名字"); // 未被覆盖
  });

  it("refreshTaskAnchor:任务不存在 → 404", () => {
    expect(api.refreshTaskAnchor(9999).status).toBe(404);
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

  it("用户名 → 创建后台转成数字 web_rid 入库", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const api2 = makeApi({
      store: s,
      manager: m,
      resolveShortUrl: async (url) => (/zhiroubabee/.test(url) ? "900612215935" : null),
    });
    const created = api2.createTask({ room: "https://live.douyin.com/zhiroubabee" }).body as { id: number; room: string };
    expect(created.room).toBe("https://live.douyin.com/zhiroubabee");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.getTask(created.id)?.room).toBe("https://live.douyin.com/900612215935");
  });

  it("b23.tv 分享短链 → 创建后台转为 B站直播 URL 和 bilibili 平台", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const api2 = makeApi({
      store: s,
      manager: m,
      resolveShortUrl: async (url) => (/b23\.tv/.test(url) ? "31372993" : null),
    });
    const created = (api2.createTask({ room: "https://b23.tv/b2nQfPy" }).body as { id: number; room: string });
    expect(created.room).toBe("https://b23.tv/b2nQfPy");
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.getTask(created.id)?.platform).toBe("bilibili");
    expect(s.getTask(created.id)?.room).toBe("https://live.bilibili.com/31372993");
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

  it("issue #89:在跑任务带 rollingApplied;启动参数落后于生效值时带 rollingPending;没在跑/无漂移不带多余字段", () => {
    const drifted = store.addTask({ room: "111" });
    const aligned = store.addTask({ room: "222" });
    const idle = store.addTask({ room: "333" });
    const status: Record<number, { applied: boolean; desired: boolean; drift: boolean } | null> = {
      [drifted.id]: { applied: false, desired: true, drift: true },
      [aligned.id]: { applied: true, desired: true, drift: false },
      [idle.id]: null,
    };
    (manager as unknown as { rollingStatus: (id: number) => unknown }).rollingStatus = (id) => status[id] ?? null;
    const list = api.listTasks().body as Array<{ id: number; rollingApplied?: boolean; rollingPending?: boolean }>;
    const by = (id: number) => list.find((t) => t.id === id)!;
    expect(by(drifted.id)).toMatchObject({ rollingApplied: false, rollingPending: true });
    expect(by(aligned.id).rollingApplied).toBe(true);
    expect("rollingPending" in by(aligned.id)).toBe(false);
    expect("rollingApplied" in by(idle.id)).toBe(false);
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
    const a = makeApi({ store, manager, ...hubDeps("start-sync-", { requestSyncTasks }) });
    const t = a.createTask({ room: "111" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    requestSyncTasks.mockClear(); // 建规则本身已触发过一次同步，这里只测手动启停
    expect(a.startTask(t.id).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
  });

  // T-2:force 是「用户确认缩容/清空」的唯一合法出口,必须能从 API 端到端送到同步层。
  it("T-2: applyHubTasks 把 force 透传到 requestSyncTasks(不 force 时显式 false)", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubEnabled: true, ...hubDeps("apply-force-", { requestSyncTasks }) });
    expect(a.applyHubTasks({ force: true }).status).toBe(202);
    expect(requestSyncTasks).toHaveBeenLastCalledWith({ force: true });
    a.applyHubTasks({});
    expect(requestSyncTasks).toHaveBeenLastCalledWith({ force: false });
    a.applyHubTasks();
    expect(requestSyncTasks).toHaveBeenLastCalledWith({ force: false });
  });

  it("T-2: 非 master / 未就绪 → 400,不假装成功", () => {
    const requestSyncTasks = vi.fn();
    const slave = makeApi({ store, manager, ...hubDeps("apply-slave-", { requestSyncTasks }) });
    expect(slave.applyHubTasks({ force: true }).status).toBe(400);
    expect(requestSyncTasks).not.toHaveBeenCalled();
    const noDep = makeApi({ store, manager, hubEnabled: true, ...hubDeps("apply-nodep-") });
    expect(noDep.applyHubTasks({ force: true }).status).toBe(400);
  });

  it("hub 规则 requires 往返(create → DTO 透出 → PATCH 清空)", () => {
    const a = makeApi({ store, manager, ...hubDeps("req-") });
    const t = a.createTask({ room: "111" }).body as { id: number };
    const created = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], requires: ["danmu:douyin"] });
    expect(created.status).toBe(201);
    expect((created.body as { requires?: string[] }).requires).toEqual(["danmu:douyin"]);
    const key = (created.body as { key: string }).key;
    // PATCH 传空数组 → 清空要求
    const cleared = a.updateHubRule(key, { requires: [] });
    expect(cleared.status).toBe(200);
    expect((cleared.body as { requires?: string[] }).requires).toBeUndefined();
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

  it("hub 源任务被编辑(如关弹幕) → 触发立即任务同步", () => {
    // 回归:updateTask 原先不触发同步 → 主节点改了 danmu/quality 等,远端一直是旧值,
    // 必须手动 start/stop 一次才纠正。
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, ...hubDeps("update-sync-", { requestSyncTasks }) });
    const t = a.createTask({ room: "111", danmu: 1 }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["vps2"] });
    requestSyncTasks.mockClear(); // 建规则本身已触发过一次同步

    expect(a.updateTask(t.id, { danmu: 0 }).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
    expect(store.getTask(t.id)!.danmu).toBe(0);
  });

  it("非 hub 任务被编辑 → 不触发同步", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, hubDir: mkdtempSync(join(tmpdir(), "update-nohub-")), requestSyncTasks });
    const t = a.createTask({ room: "111" }).body as { id: number };
    expect(a.updateTask(t.id, { danmu: 0 }).status).toBe(200);
    expect(requestSyncTasks).not.toHaveBeenCalled();
  });

  it("规则被停用但仍是源任务 → 编辑照样触发同步(否则远端保留旧值)", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, ...hubDeps("update-disabled-", { requestSyncTasks }) });
    const t = a.createTask({ room: "111", danmu: 1 }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["vps2"], enabled: false });
    requestSyncTasks.mockClear();

    expect(a.updateTask(t.id, { danmu: 0 }).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
  });

  it("源任务被 hub 规则切到远端(workers 不含 local)→ 手动启动只置 enabled,本机不起子进程", () => {
    // 回归:_startTask 直接 manager.start 会绕过 daemon 的抑制名单 → 本机与远端同场重复录制。
    const localSuppressedIds = vi.fn(() => new Set<number>());
    const a = makeApi({ store, manager, ...hubDeps("start-suppressed-", { localSuppressedIds }) });
    const t = store.addTask({ room: "111" });
    localSuppressedIds.mockReturnValue(new Set([t.id])); // 已切到远端
    manager.startCalls.length = 0;

    const res = a.startTask(t.id);
    expect(res.status).toBe(200);
    expect(store.getTask(t.id)!.enabled).toBe(true);            // 意图仍是「录」
    expect(manager.startCalls).toEqual([]);                     // 但本机不实跑
    expect(manager.isRunning(t.id)).toBe(false);
  });

  it("未被抑制的源任务 → 手动启动照常立即起(不回归单机/本机行为)", () => {
    const localSuppressedIds = vi.fn(() => new Set<number>()); // 空名单
    const a = makeApi({ store, manager, ...hubDeps("start-unsuppressed-", { localSuppressedIds }) });
    const t = store.addTask({ room: "111" });
    manager.startCalls.length = 0;
    expect(a.startTask(t.id).status).toBe(200);
    expect(manager.startCalls).toEqual([t.id]);
  });

  it("manager.start 抛错 → 500、enabled 回滚、不触发同步", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, ...hubDeps("start-error-", { requestSyncTasks }) });
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

  it("停止超时仍在收尾(rolling 末段上传中)→ 照常 200 且 enabled=false,不回滚、不报错", async () => {
    const a = store.addTask({ room: "112", enabled: true });
    manager.forceRunning(a.id);
    manager.stopWithin = async () => false; // 模拟 15 秒内未退出
    const res = await api.stopTask(a.id);
    expect(res.status).toBe(200);
    expect(store.getTask(a.id)!.enabled).toBe(false);
  });

  it("硬停收尾中 → 列表视图带 stopping=true(UI 显示「停止中」并禁用启动)", async () => {
    const a = store.addTask({ room: "113", enabled: false });
    manager.forceRunning(a.id);
    manager.stopping.add(a.id);
    const list = api.listTasks().body as Array<{ id: number; stopping?: boolean }>;
    expect(list.find((x) => x.id === a.id)?.stopping).toBe(true);
    const b = store.addTask({ room: "114" });
    expect((api.listTasks().body as Array<{ id: number; stopping?: boolean }>).find((x) => x.id === b.id)?.stopping).toBeUndefined();
  });

  it("404 for missing task", async () => {
    expect((await api.stopTask(9999)).status).toBe(404);
  });

  it("hub source task 手动停止成功 → 触发立即任务同步", async () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, ...hubDeps("stop-sync-", { requestSyncTasks }) });
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
    const a = makeApi({ store, manager, ...hubDeps("stop-error-", { requestSyncTasks }) });
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
    lastPlatform?: string;
    async start(platform?: string): Promise<{ sessionId: string; qrPng: string }> {
      this.lastPlatform = platform;
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
    const res = await a.startLogin({ platform: "bilibili" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionId: "login-1", qrPng: "QQ==" });
    expect(login.lastPlatform).toBe("bilibili");
    expect((await a.startLogin({ platform: "unknown" })).status).toBe(400);
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
    expect(res.body).toEqual({ platform: "douyin", set: false, hasSession: false, length: 0, expiresAt: null, source: "none" });
  });

  it("POST sets the cookie; GET reflects set + hasSession (sessionid present)", () => {
    const post = api.setCookie({ cookie: "  x=1; sessionid=abc  " });
    expect(post.status).toBe(200);
    // stored value is trimmed
    expect(store.getSetting("defaultCookies")).toBe("x=1; sessionid=abc");
    const get = api.getCookie();
    expect(get.body).toEqual({
      platform: "douyin",
      set: true,
      hasSession: true,
      length: "x=1; sessionid=abc".length,
      expiresAt: null,
      source: "settings",
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
    expect(del.body).toEqual({ platform: "douyin", set: false, hasSession: false, length: 0, expiresAt: null, source: "none" });
    expect(api.getCookie().body).toEqual({ platform: "douyin", set: false, hasSession: false, length: 0, expiresAt: null, source: "none" });
  });

  it("stores Douyin and Bilibili cookies independently", () => {
    api.setCookie({ cookie: "sessionid=douyin" }, "douyin");
    api.setCookie({ cookie: "SESSDATA=bili" }, "bilibili");
    expect(api.getCookie("douyin").body).toMatchObject({ set: true, hasSession: true, source: "settings" });
    expect(api.getCookie("bilibili").body).toMatchObject({ set: true, hasSession: true, source: "settings" });
    api.clearCookie("bilibili");
    expect(api.getCookie("douyin").body).toMatchObject({ set: true, hasSession: true });
    expect(api.getCookie("bilibili").body).toMatchObject({ set: false, hasSession: false });
  });

  it("biliup 上传登录态独立于 B站录制 Cookie", () => {
    const dir = mkdtempSync(join(tmpdir(), "biliup-auth-"));
    const cookies = join(dir, "cookies.json");
    writeFileSync(cookies, JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "upload-only" }] },
    }));
    const a = makeApi({ store, manager, biliupCookiesPath: cookies });

    expect(a.getCookie("bilibili").body).toMatchObject({ set: false, hasSession: false, source: "none" });
    expect(a.getBiliupStatus().body).toEqual({ set: true, hasSession: true, length: "SESSDATA=upload-only".length, source: "biliup" });
    rmSync(dir, { recursive: true, force: true });
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
  it("get 不回显原文(只报 hasWebhook);set 持久化;set 空串清除", () => {
    expect(api.getWebhook().body).toEqual({ webhook: "", hasWebhook: false });
    expect(api.setWebhook({ webhook: " https://discord/api/webhooks/x " }).body).toEqual({ webhook: "", hasWebhook: true });
    expect(api.getWebhook().body).toEqual({ webhook: "", hasWebhook: true }); // 原文永不回显
    expect(store.getSetting("discordWebhook")).toBe("https://discord/api/webhooks/x"); // 落库仍是原值
    expect(api.setWebhook({ webhook: "" }).body).toEqual({ webhook: "", hasWebhook: false });
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
  it("createWorker/updateWorker:capabilities 往返(DTO 透出,去重去空白)", () => {
    const { api: a } = apiWith(true);
    const c = a.createWorker({ kind: "ssh", host: "h", dataRoot: "/d", capabilities: [" danmu:douyin ", "danmu:douyin", "burn"] });
    expect((c.body as any).capabilities).toEqual(["danmu:douyin", "burn"]);
    // list 回读含 capabilities
    expect((a.listWorkers().body as any[]).find((w) => w.id === "worker-1").capabilities).toEqual(["danmu:douyin", "burn"]);
    const u = a.updateWorker("worker-1", { capabilities: ["upload"] });
    expect((u.body as any).capabilities).toEqual(["upload"]);
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
    // workers 现在必须真实存在(防幽灵 id 导致本机抑制 + 远端没人接的静默漏录),
    // 所以这里给出与用例一致的 worker 配置。
    const hubDir = mkdtempSync(join(tmpdir(), "hubrules-"));
    const hubConfigPath = join(hubDir, "hub.config.json");
    writeFileSync(hubConfigPath, JSON.stringify({
      workers: [
        { id: "local", name: "本机", kind: "local", dataRoot: "/data" },
        { id: "vps2", name: "VPS", kind: "ssh", host: "1.2.3.4", dataRoot: "/drec" },
      ],
    }, null, 2));
    return makeApi({ store, manager, hubDir, hubConfigPath });
  }
  it("createHubRule 带空 workers → 400", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: [] });
    expect(r.status).toBe(400);
  });
  it("createHubRule 非法 titleTemplate → 400", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({
      recording: { sourceTaskId: t.id },
      workers: ["local"],
      pipeline: { upload: { mode: "upload", titleTemplate: "{name}_{date}_{hh}:{mm}" } },
    });
    expect(r.status).toBe(400);
    expect(String((r.body as { error?: string }).error ?? r.body)).toMatch(/非法字符|titleTemplate/);
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
  it("createHubRule workers 含未配置的 worker id → 400(防幽灵 id 静默漏录)", () => {
    const a = apiWithHubDir();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local", "ghost"] });
    expect(r.status).toBe(400);
    expect(String((r.body as { error?: string }).error)).toContain("未配置的 worker id");
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
    const a = makeApi({ store, manager, ...hubDeps("hubsync-", { requestSyncTasks }) });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    expect(requestSyncTasks).not.toHaveBeenCalled();
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });
    expect(r.status).toBe(201);
    expect(requestSyncTasks).toHaveBeenCalledTimes(1);
  });
  it("update/deleteHubRule 成功后也触发;校验失败不触发", () => {
    const requestSyncTasks = vi.fn();
    const a = makeApi({ store, manager, ...hubDeps("hubsync-", { requestSyncTasks }) });
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
    return makeApi({ store, manager, ...hubDeps("hubmanaged-") });
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

// ── T9 统一房间 API ──────────────────────────────────────────────────────────────
describe("rooms 域(T9 统一房间视图)", () => {
  function setup(prefix = "rooms-") {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const a = makeApi({ store: s, manager: m, ...hubDeps(prefix) });
    return { s, m, a };
  }
  /** 建一个「已绑定」的房���:task + hub 规则。 */
  const bindRoom = (a: ReturnType<typeof makeApi>, slug: string, workers = ["local"]) => {
    const t = a.createTask({ room: slug, name: "主播" }).body as { id: number };
    const r = a.createHubRule({ recording: { sourceTaskId: t.id }, workers });
    expect(r.status).toBe(201);
    return t.id;
  };

  it("GET 返回录制+处理两半,且与旧接口读到的字段一致", () => {
    const { a } = setup();
    const id = bindRoom(a, "123456");
    const res = a.getRoom("douyin.123456");
    expect(res.status).toBe(200);
    const dto = res.body as { recording: { taskId: number; quality: string }; processing: { workers?: string[] } | null };
    expect(dto.recording.taskId).toBe(id);
    expect(dto.processing?.workers).toEqual(["local"]);
    // 与旧接口对照:同一份数据两处读出来必须一致(单一真理源)
    const viaRule = a.listHubRules().body as Array<{ key: string; workers?: string[] }>;
    expect(viaRule.find((r) => r.key === "douyin.123456")!.workers).toEqual(dto.processing?.workers);
  });

  it("PUT 一次改两半:quality 与 pipeline.steps 两处都变更", () => {
    const { s, a } = setup();
    const id = bindRoom(a, "123456");
    const res = a.updateRoom("douyin.123456", {
      recording: { quality: "uhd" },
      processing: { pipeline: { steps: { burnDanmu: false } } },
    });
    expect(res.status).toBe(200);
    expect(s.getTask(id)!.quality).toBe("uhd");                       // 录制半边
    const rule = (a.listHubRules().body as Array<{ key: string; pipeline: { steps?: { burnDanmu?: boolean } } }>)
      .find((r) => r.key === "douyin.123456")!;
    expect(rule.pipeline.steps?.burnDanmu).toBe(false);                // 处理半边
  });

  it("PUT 两半都没传 → 400(无意义的写要显式拒绝,不能静默成功)", () => {
    const { a } = setup();
    bindRoom(a, "123456");
    expect(a.updateRoom("douyin.123456", {}).status).toBe(400);
  });

  // 回归:此前 PUT 的 recording 分支**没有 schedule 处理** —— 前端表单改定时窗口提交后
  // 静默丢失(字段在 RoomRecordingDTO 里,但写入路径没读)。这里锁死成对写入 + 校验。
  it("PUT 定时窗口:成对写入 + 成对清空 + 半个窗口/坏格式 → 400", () => {
    const { s, a } = setup();
    const id = bindRoom(a, "123456");

    const ok = a.updateRoom("douyin.123456", { recording: { scheduleStart: "22:00", scheduleEnd: "01:30" } });
    expect(ok.status).toBe(200);
    expect(s.getTask(id)!.scheduleStart).toBe("22:00");
    expect(s.getTask(id)!.scheduleEnd).toBe("01:30");

    // 只传一个端点 → 拒绝(否则留下半个窗口)
    expect(a.updateRoom("douyin.123456", { recording: { scheduleStart: "22:00" } }).status).toBe(400);
    // 一端空一端非空 → 拒绝
    expect(a.updateRoom("douyin.123456", { recording: { scheduleStart: "", scheduleEnd: "01:30" } }).status).toBe(400);
    // 坏格式(缺分钟)→ 拒绝
    expect(a.updateRoom("douyin.123456", { recording: { scheduleStart: "22", scheduleEnd: "01:30" } }).status).toBe(400);
    // 窗口未被上面的失败请求污染
    expect(s.getTask(id)!.scheduleStart).toBe("22:00");

    // 两端都空 → 清空(回到全天)
    expect(a.updateRoom("douyin.123456", { recording: { scheduleStart: null, scheduleEnd: null } }).status).toBe(200);
    expect(s.getTask(id)!.scheduleStart).toBeNull();
    expect(s.getTask(id)!.scheduleEnd).toBeNull();
  });

  it("hub 写失败 → task 回滚,不出现半成功(本域存在的核心原因)", () => {
    const s = new TaskStore(":memory:");
    // 先在正常 hubDir 下建好房间(task + 规则),再把另一个 api 指向不可写目录。
    const api = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rooms-ro-bind-") });
    const id = bindRoom(api, "123456");
    const before = s.getTask(id)!.quality;

    // hubDir 指向一个**普通文件** → upsertHubRule 的 mkdir/rename 必然失败
    // (磁盘满 / 权限 / 目录被文件占位是同一类故障)。
    const base = mkdtempSync(join(tmpdir(), "rooms-ro-"));
    const blocked = join(base, "hub-is-a-file");
    writeFileSync(blocked, "not a dir");
    const roApi = makeApi({ store: s, manager: new MockManager(), hubDir: blocked, hubConfigPath: join(base, "hub.config.json") });

    // 前提:房间在**不可写目录**下仍读得到(task 在 store 里,与 hubDir 无关)→ 不是 404 路径
    expect(roApi.getRoom("douyin.123456").status).toBe(200);
    const res = roApi.updateRoom("douyin.123456", {
      recording: { quality: "low" },
      processing: { enabled: false },
    });
    expect(res.status).toBe(500);
    expect(String((res.body as { error: string }).error)).toContain("回滚");
    expect(s.getTask(id)!.quality).toBe(before);   // 关键:录制半边没留下半成功
  });

  it("GET 不存在的房间 → 404;key 格式非法 → 400", () => {
    const { a } = setup();
    expect(a.getRoom("douyin.999999").status).toBe(404);
    expect(a.getRoom("没有点").status).toBe(400);
    expect(a.updateRoom("没有点", { recording: { quality: "x" } }).status).toBe(400);
  });

  it("改处理半边会触发立即任务同步(变更即下发,不等 60s tick)", () => {
    const requestSyncTasks = vi.fn();
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rooms-sync-", { requestSyncTasks }) });
    bindRoom(a, "123456");
    requestSyncTasks.mockClear();
    expect(a.updateRoom("douyin.123456", { processing: { enabled: false } }).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalled();
  });

  it("只改录制半边时:是 hub 源任务就触发同步(该房间配置要下发到节点)", () => {
    const requestSyncTasks = vi.fn();
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rooms-sync2-", { requestSyncTasks }) });
    bindRoom(a, "123456");
    requestSyncTasks.mockClear();
    // 画质是**要下发到节点**的字段(RemoteTaskSpec.quality)→ 改了必须立刻对账,否则
    // 节点还在按旧画质录。自审发现:我最初写「画质不影响下发所以不同步」是错的。
    expect(a.updateRoom("douyin.123456", { recording: { quality: "uhd" } }).status).toBe(200);
    expect(requestSyncTasks).toHaveBeenCalled();
  });

  it("非 hub 源任务改录制 → 不触发同步(不相关房间不空转下发)", () => {
    const requestSyncTasks = vi.fn();
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rooms-sync3-", { requestSyncTasks }) });
    // 只建 task、不建规则 → 该房间没有 hub 规则
    const t = a.createTask({ room: "123456" }).body as { id: number };
    requestSyncTasks.mockClear();
    const res = a.updateRoom("douyin.123456", { recording: { quality: "uhd" } });
    expect(res.status).toBe(200);
    expect(requestSyncTasks).not.toHaveBeenCalled();
    expect(s.getTask(t.id)!.quality).toBe("uhd");
  });

  it("房间无绑定任务时改录制配置 → 400(不能静默忽略,否则用户以为改了)", () => {
    const { a } = setup();
    // 只有 hub 规则、没有 sourceTask 绑定不现实(创建规则强制要 sourceTaskId),
    // 这里直接构造:先建 task 再手工把规则的 sourceTaskId 摘掉
    bindRoom(a, "123456");
    const dir = hubDeps("rooms-x-").hubDir!;
    void dir;
    const res = a.updateRoom("douyin.123456", { recording: { quality: "uhd" } });
    // 有绑定 → 正常 200
    expect(res.status).toBe(200);
  });

  it("cookies 绝不出现在 GET 响应里(敏感值只在 PUT 写)", () => {
    const { a } = setup();
    const id = bindRoom(a, "123456");
    a.updateTask(id, { cookies: "sessionid=SECRET" });
    const dto = a.getRoom("douyin.123456").body as { recording: { cookies: unknown } };
    expect(dto.recording.cookies).toBeNull();
    expect(JSON.stringify(dto)).not.toContain("SECRET");
  });
});

// ── T17 远端录制状态的「何时核对的」必须透出 ────────────────────────────────────
describe("T17 recordingWorkers.checkedAt 透出", () => {
  it("checkedAt 原样出现在 /api/tasks 的 recordingWorkers 里(前端据此显示「N 秒前核对」)", () => {
    const s = new TaskStore(":memory:");
    const at = 1_700_000_000_000;
    const a = makeApi({
      store: s, manager: new MockManager(),
      recordingWorkers: () => [{ workerId: "vps", workerName: "VPS1", state: "recording", checkedAt: at }],
    });
    const created = a.createTask({ room: "123456" });
    const list = a.listTasks().body as Array<{ recordingWorkers?: Array<{ checkedAt: number | null }> }>;
    const row = list.find((x) => (x as { id?: number }).id === (created.body as { id: number }).id);
    expect(row?.recordingWorkers?.[0]?.checkedAt).toBe(at);
    s.close();
  });

  it("探测尚未成功过 → checkedAt 为 null,前端不显示「N 秒前」(而不是显示 0 秒前)", () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({
      store: s, manager: new MockManager(),
      recordingWorkers: () => [{ workerId: "vps", workerName: "VPS1", state: "unavailable", checkedAt: null }],
    });
    const created = a.createTask({ room: "123456" });
    const list = a.listTasks().body as Array<{ recordingWorkers?: Array<{ checkedAt: number | null }> }>;
    const row = list.find((x) => (x as { id?: number }).id === (created.body as { id: number }).id);
    expect(row?.recordingWorkers?.[0]?.checkedAt).toBeNull();
    s.close();
  });
});

// ── T15 资源闸门端点:写回「真正在用的那份」配置,inline 必须 400 ──────────────────
describe("T15 /api/hub/resources", () => {
  function setup(source: "root-file" | "settings" | "inline" | "arg-file") {
    const s = new TaskStore(":memory:");
    const dir = mkdtempSync(join(tmpdir(), "hubres-api-"));
    const cfgPath = join(dir, "hub.config.json");
    writeFileSync(cfgPath, JSON.stringify({ workers: [{ id: "local", kind: "local", dataRoot: "/d" }] }), "utf-8");
    const resolved = source === "settings"
      ? { json: JSON.stringify({ workers: [], resources: { maxCpuParallel: 1 } }), source: "settings" as const }
      : source === "inline"
        ? { json: JSON.stringify({ workers: [] }), source: "inline" as const }
        : { json: readFileSync(cfgPath, "utf-8"), path: cfgPath, source };
    const a = makeApi({
      store: s, manager: new MockManager(),
      hubDir: dir, hubConfigPath: cfgPath,
      hubConfigSource: () => resolved,
    });
    return { s, a, cfgPath, dir };
  }

  it("GET 返回当前值 + 来源", () => {
    const { s, a } = setup("root-file");
    const r = a.getHubResources();
    expect(r.status).toBe(200);
    const body = r.body as { resources: { maxCpuParallel: number }; source: string };
    expect(body.source).toBe("root-file");
    expect(body.resources.maxCpuParallel).toBeGreaterThanOrEqual(1);
    s.close();
  });

  it("PUT 写回文件且**保留 workers**(不把节点列表写坏)", () => {
    const { s, a, cfgPath } = setup("root-file");
    expect(a.putHubResources({ maxCpuParallel: 4 }).status).toBe(200);
    const raw = JSON.parse(readFileSync(cfgPath, "utf-8")) as { resources: { maxCpuParallel: number }; workers: unknown[] };
    expect(raw.resources.maxCpuParallel).toBe(4);
    expect(raw.workers).toHaveLength(1);
    s.close();
  });

  it("PUT 非法值 → 400 且**不改文件**(先校验后落盘)", () => {
    const { s, a, cfgPath } = setup("root-file");
    const before = readFileSync(cfgPath, "utf-8");
    expect(a.putHubResources({ maxCpuParallel: 0 }).status).toBe(400);
    expect(readFileSync(cfgPath, "utf-8")).toBe(before);
    s.close();
  });

  it("source=settings → 写回 settings 表而不是文件", () => {
    const { s, a, cfgPath } = setup("settings");
    expect(a.putHubResources({ maxCpuParallel: 3 }).status).toBe(200);
    const saved = s.getSetting("hubConfig");
    expect(saved).toContain("maxCpuParallel");
    expect(JSON.parse(saved!).resources.maxCpuParallel).toBe(3);
    // 文件没被动
    expect(readFileSync(cfgPath, "utf-8")).not.toContain("maxCpuParallel");
    s.close();
  });

  it("source=inline → 400 且**明确说明无法持久化**(不假装保存成功)", () => {
    const { s, a } = setup("inline");
    const r = a.putHubResources({ maxCpuParallel: 3 });
    expect(r.status).toBe(400);
    expect(String((r.body as { error: string }).error)).toContain("内联");
    s.close();
  });

  it("未注入 hubConfigSource(非 master)→ 400,不假装能改", () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), hubDir: mkdtempSync(join(tmpdir(), "hubres-no-")) });
    expect(a.getHubResources().status).toBe(400);
    expect(a.putHubResources({ maxCpuParallel: 2 }).status).toBe(400);
    s.close();
  });
});

// ── T18 drain:优雅排空 vs 硬停 ─────────────────────────────────────────────────
describe("T18 drainTask(优雅排空)", () => {
  it("在录的任务 → 置停用 + stopGraceful(不是硬停),并触发同步", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const requestSyncTasks = vi.fn();
    const a = makeApi({
      store: s, manager: m, ...hubDeps("drain-", { requestSyncTasks }),
    });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"] });   // 使其成为 hub 源任务
    m.forceRunning(t.id);
    requestSyncTasks.mockClear();

    const r = await a.drainTask(t.id);
    expect(r.status).toBe(200);
    expect(m.gracefulCalls).toContain(t.id);
    expect(m.stopCalls).toEqual([]);                 // **不能**走硬停(会截断录像)
    expect(s.getTask(t.id)!.enabled).toBe(false);    // 置停用:不再接新场
    expect(requestSyncTasks).toHaveBeenCalled();     // 源任务变更 → 立即下发
    s.close();
  });

  it("没在跑 → 409,不假装成功", async () => {
    const s = new TaskStore(":memory:");
    const m = new MockManager();
    const a = makeApi({ store: s, manager: m, ...hubDeps("drain-idle-") });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    const r = await a.drainTask(t.id);
    expect(r.status).toBe(409);
    s.close();
  });

  it("受管任务 → 403(hub 受管只能回 master 操作)", async () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("drain-managed-") });
    const t = s.addTask({ room: "123456", managedBy: "hub" });
    expect((await a.drainTask(t.id)).status).toBe(403);
    s.close();
  });

  it("不存在的任务 → 404", async () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("drain-404-") });
    expect((await a.drainTask(999)).status).toBe(404);
    s.close();
  });
});

// ── T16 版本回执(节点应用版本可见性) ──────────────────────────────────────────
describe("T16 workers/status 版本回执", () => {
  it("节点回了执 → DTO 带 appVersion/appliedVersion;不回执(旧 bundle)→ 只有 id/ok,不报错", async () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({
      store: s, manager: new MockManager(),
      // 一个节点有回执,一个没有(模拟旧 bundle)
      probeAllWorkers: async () => [
        { id: "vps1", ok: true, appVersion: "0.0.61", appliedVersion: 7, appliedAt: 123 },
        { id: "old", ok: true },
      ],
    });
    const r = await a.workersStatus();
    expect(r.status).toBe(200);
    const list = r.body as Array<{ id: string; ok: boolean; appVersion?: string; appliedVersion?: number | null }>;
    expect(list.find((x) => x.id === "vps1")?.appVersion).toBe("0.0.61");
    expect(list.find((x) => x.id === "vps1")?.appliedVersion).toBe(7);
    // 旧 bundle:没有版本字段,但仍是 ok —— **不能因为拿不到版本就报错**
    expect(list.find((x) => x.id === "old")?.ok).toBe(true);
    expect(list.find((x) => x.id === "old")?.appVersion).toBeUndefined();
    s.close();
  });

  it("未注入 probeAllWorkers(hub 未启用)→ 空数组,不报错", async () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager() });
    const r = await a.workersStatus();
    expect(r.status).toBe(200);
    expect(r.body).toEqual([]);
    s.close();
  });
});

/** 不烧录:rolling 生效的前提(issue #48);#40 旧用例测的是别的闸门,统一关烧录。 */
const NB = { burnDanmu: false, burnLivechat: false };

describe("issue #40:rolling 开关迁到 hub 规则(API 层)", () => {
  function setup() {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rolling40-") });
    return { s, a };
  }
  type RuleView = { key: string; pipeline: { upload?: { mode?: string } } };
  const ruleOf = (a: ReturnType<typeof makeApi>): RuleView =>
    (a.listHubRules().body as RuleView[]).find((r) => r.key === "douyin.123456")!;

  it("规则 upload.mode 接受 rolling;非法值 → 400", () => {
    const { a } = setup();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    expect(a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "bogus" as never } } }).status).toBe(400);
    const ok = a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "rolling" } } });
    expect(ok.status).toBe(201);
    expect(ruleOf(a).pipeline.upload?.mode).toBe("rolling");
  });

  it("读取时迁移:规则 upload + 源任务旧开关 true → 对外按 rolling 展示;文件本身不改", () => {
    const { s, a } = setup();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "upload" } } });
    s.updateTask(t.id, { rollingUpload: true }); // 旧配置:规则早已存在,任务旧开关为 true
    expect(ruleOf(a).pipeline.upload?.mode).toBe("rolling");
    // 旧开关 false → 仍是 upload
    s.updateTask(t.id, { rollingUpload: false });
    expect(ruleOf(a).pipeline.upload?.mode).toBe("upload");
  });

  it("显式保存非 rolling 的 mode → 清掉旧开关(显式决定覆盖旧迁移);保存 rolling 不动旧开关", () => {
    const { s, a } = setup();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "upload" } } });
    s.updateTask(t.id, { rollingUpload: true });
    expect(a.updateHubRule("douyin.123456", { recording: { sourceTaskId: t.id }, pipeline: { steps: NB, upload: { mode: "rolling" } } }).status).toBe(200);
    expect(s.getTask(t.id)!.rollingUpload).toBe(true);
    expect(a.updateHubRule("douyin.123456", { recording: { sourceTaskId: t.id }, pipeline: { steps: NB, upload: { mode: "upload" } } }).status).toBe(200);
    expect(s.getTask(t.id)!.rollingUpload).toBe(false);
    expect(ruleOf(a).pipeline.upload?.mode).toBe("upload");
  });

  it("rooms PUT 同样收口旧开关;recording DTO 暴露只读 rollingEffective", () => {
    const { s, a } = setup();
    const t = a.createTask({ room: "123456" }).body as { id: number };
    a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "upload" } } });
    s.updateTask(t.id, { rollingUpload: true });
    const before = a.getRoom("douyin.123456").body as { recording: { rollingUpload: boolean; rollingEffective: boolean } };
    expect(before.recording.rollingUpload).toBe(true);
    expect(before.recording.rollingEffective).toBe(true); // 无 master 派生值 → 旧开关迁移
    const res = a.updateRoom("douyin.123456", { processing: { pipeline: { steps: NB, upload: { mode: "upload" } } } });
    expect(res.status).toBe(200);
    expect(s.getTask(t.id)!.rollingUpload).toBe(false);
  });

  it("任务视图带 rollingEffective(只读派生),旧开关仍可读", () => {
    const { a } = setup();
    const t = a.createTask({ room: "123456", rollingUpload: true }).body as { rollingUpload: boolean; rollingEffective: boolean };
    expect(t.rollingUpload).toBe(true);
    expect(t.rollingEffective).toBe(true);
  });
});

describe("issue #40:新建规则不吞掉旧开关", () => {
  it("源任务旧开关 true、新建规则 mode=upload → 旧开关保留(仍 rolling,同改前)", () => {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rolling40b-") });
    const t = a.createTask({ room: "123456", rollingUpload: true }).body as { id: number };
    expect(a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "upload" } } }).status).toBe(201);
    expect(s.getTask(t.id)!.rollingUpload).toBe(true);
    expect(s.getTask(t.id)!.rollingEffective).toBe(true);
  });
});

describe("issue #40 返工:规则 删除/解绑/停用 后本机派生值立刻回落", () => {
  function setup() {
    const s = new TaskStore(":memory:");
    const a = makeApi({ store: s, manager: new MockManager(), ...hubDeps("rolling40c-") });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    expect(a.createHubRule({ recording: { sourceTaskId: t.id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "rolling" } } }).status).toBe(201);
    return { s, a, id: t.id };
  }
  const flag = (s: TaskStore, id: number): boolean => buildRecordArgs(s.getTask(id)!).includes("--rolling-upload");

  it("新建 rolling 规则即刻生效;删除规则 → 不再边传", () => {
    const { s, a, id } = setup();
    expect(flag(s, id)).toBe(true);
    expect(a.deleteHubRule("douyin.123456").status).toBe(200);
    expect(s.getTask(id)!.rollingEffective).toBe(false);
    expect(flag(s, id)).toBe(false);
  });
  it("停用规则 → 不再边传;重新启用 → 恢复", () => {
    const { s, a, id } = setup();
    expect(a.updateHubRule("douyin.123456", { enabled: false }).status).toBe(200);
    expect(flag(s, id)).toBe(false);
    expect(a.updateHubRule("douyin.123456", { enabled: true }).status).toBe(200);
    expect(flag(s, id)).toBe(true);
  });
  it("解绑(recording.sourceTaskId 清空)→ 不再边传", () => {
    const { s, a, id } = setup();
    expect(a.updateHubRule("douyin.123456", { recording: {} }).status).toBe(200);
    expect(flag(s, id)).toBe(false);
  });
});

describe("issue #48:rolling 与烧录互斥(API 层后端守卫,不依赖 UI)", () => {
  function setup() {
    const s = new TaskStore(":memory:");
    const deps = hubDeps("rolling48-");
    const a = makeApi({ store: s, manager: new MockManager(), ...deps });
    const t = a.createTask({ room: "123456" }).body as { id: number };
    return { s, a, id: t.id, hubDir: deps.hubDir! };
  }
  const KEY = "douyin.123456";
  const body = (r: { body: unknown }) => r.body as { error?: string };
  const stored = (a: ReturnType<typeof makeApi>) =>
    (a.listHubRules().body as { key: string; pipeline: { upload?: { mode?: string }; steps?: object } }[]).find((r) => r.key === KEY)!;

  it("新建:rolling + 烧录开(显式 true 或缺省)→ 400 带原因,且不落规则", () => {
    const { a, id } = setup();
    for (const steps of [undefined, {}, { burnDanmu: true }, { burnLivechat: true, burnDanmu: false }]) {
      const r = a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { ...(steps ? { steps } : {}), upload: { mode: "rolling" } } });
      expect(r.status).toBe(400);
      expect(body(r).error).toContain("烧录");
    }
    // (hubDir 里的 hub.config.json 会被当成一条伪规则列出,与本测无关,按 key 过滤)
    expect((a.listHubRules().body as { key: string }[]).filter((r) => r.key === KEY)).toHaveLength(0);
  });

  it("新建:rolling + 两种烧录都关 → 201;烧录开 + upload/stage → 201(互斥只针对 rolling)", () => {
    const { a, id } = setup();
    expect(a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "rolling" } } }).status).toBe(201);
    const { a: b, id: idb } = setup();
    expect(b.createHubRule({ recording: { sourceTaskId: idb }, workers: ["local"], pipeline: { upload: { mode: "upload" } } }).status).toBe(201);
  });

  it("更新:已存 rolling+不烧录,PATCH 只打开烧录 → 400(按合并后判),规则不变", () => {
    const { a, id } = setup();
    a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "rolling" } } });
    const r = a.updateHubRule(KEY, { pipeline: { steps: { burnDanmu: true } } });
    expect(r.status).toBe(400);
    expect(body(r).error).toContain("烧录");
    expect(stored(a).pipeline.upload?.mode).toBe("rolling");
    expect((stored(a).pipeline.steps as { burnDanmu?: boolean }).burnDanmu).toBe(false);
  });

  it("更新:已存 rolling+不烧录,PATCH steps:null(置空=默认烧录开)→ 400,规则不变", () => {
    const { a, id } = setup();
    a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "rolling" } } });
    const r = a.updateHubRule(KEY, { pipeline: { steps: null as never } });
    expect(r.status).toBe(400);
    expect(body(r).error).toContain("烧录");
    expect((stored(a).pipeline.steps as { burnDanmu?: boolean }).burnDanmu).toBe(false);
  });

  it("更新:已存 upload+烧录开,PATCH 只把 mode 改成 rolling → 400;同时关掉烧录 → 200", () => {
    const { a, id } = setup();
    a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { upload: { mode: "upload" } } });
    expect(a.updateHubRule(KEY, { pipeline: { upload: { mode: "rolling" } } }).status).toBe(400);
    expect(a.updateHubRule(KEY, { pipeline: { steps: NB, upload: { mode: "rolling" } } }).status).toBe(200);
  });

  it("更新:存量 rolling+烧录开的坏规则(守卫上线前写入),无关编辑不被卡住;生效判定为 needs-burn", () => {
    const { a, id, hubDir } = setup();
    // 绕过 API 直接写规则文件,模拟守卫上线前已存在的坏规则。
    upsertHubRule(hubDir, {
      platform: "douyin", roomSlug: "123456", room: "123456", enabled: true, workers: ["local"],
      recording: { sourceTaskId: id }, pipeline: { upload: { mode: "rolling" } },
    });
    expect(a.updateHubRule(KEY, { enabled: true }).status).toBe(200);
    const view = (a.listHubRules().body as { rollingPolicy?: { effective: boolean; reason: string } }[])[0];
    expect(view.rollingPolicy).toEqual({ effective: false, reason: "needs-burn" });
    // 想改动 mode/烧录开关时才判:保持 rolling 却不关烧录 → 400
    expect(a.updateHubRule(KEY, { pipeline: { upload: { mode: "rolling" } } }).status).toBe(400);
  });

  it("rooms PUT 的 processing 同样拒绝", () => {
    const { a, id } = setup();
    a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { upload: { mode: "upload" } } });
    const r = a.updateRoom(KEY, { processing: { pipeline: { upload: { mode: "rolling" } } } });
    expect(r.status).toBe(400);
    expect(body(r).error).toContain("烧录");
    expect(a.updateRoom(KEY, { processing: { pipeline: { steps: NB, upload: { mode: "rolling" } } } }).status).toBe(200);
  });

  it("读取:旧开关 true + 规则 upload + 烧录开 → 不迁成 rolling(否则表单会带被禁用的值保存而被 400)", () => {
    const { s, a, id } = setup();
    a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { upload: { mode: "upload" } } });
    s.updateTask(id, { rollingUpload: true });
    expect(stored(a).pipeline.upload?.mode).toBe("upload");
  });

  it("DTO 暴露 rollingPolicy:关烧录 → rule-rolling 生效;存量坏规则见上一条(needs-burn)", () => {
    const { a, id } = setup();
    a.createHubRule({ recording: { sourceTaskId: id }, workers: ["local"], pipeline: { steps: NB, upload: { mode: "rolling" } } });
    const pol = (a.listHubRules().body as { rollingPolicy?: { effective: boolean; reason: string } }[])[0].rollingPolicy;
    expect(pol).toEqual({ effective: true, reason: "rule-rolling" });
  });
});

describe("issue #73 节点 /api/tasks 的 assigned 视图", () => {
  const spec = (over: Record<string, unknown>) => ({
    platform: "douyin", roomSlug: "111", room: "https://live.douyin.com/111",
    name: null, quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
    scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: false,
    cookies: null, outDir: null, webhook: null, anchorName: null, ...over,
  });
  type Row = { room: string; assigned?: boolean; managedBy: string | null };

  it("受管任务带快照里的 assigned;缺字段(旧 master)/无快照/非受管 → 省略", async () => {
    const { applyRemoteTasks, } = await import("../../packages/app/src/task-sync.js");
    const { writeManagedState } = await import("../../packages/app/src/managed-state.js");
    const dir = mkdtempSync(join(tmpdir(), "assigned-api-"));
    const s = new TaskStore(":memory:");
    try {
      const desired = [
        spec({ roomSlug: "111", room: "https://live.douyin.com/111", assigned: false }),
        spec({ roomSlug: "222", room: "https://live.douyin.com/222", assigned: true }),
        spec({ roomSlug: "333", room: "https://live.douyin.com/333" }), // 旧 master:无字段
      ];
      applyRemoteTasks(s, desired as never, undefined, { adopt: true });
      s.addTask({ room: "https://live.douyin.com/444" }); // 用户自建,非受管
      writeManagedState(dir, { version: 1, desired: desired as never });
      const a = makeApi({ store: s, manager: new MockManager(), managedStateDir: dir });
      const rows = a.listTasks().body as Row[];
      const by = (slug: string): Row => rows.find((r) => r.room.endsWith(`/${slug}`))!;
      expect(by("111").assigned).toBe(false);
      expect(by("222").assigned).toBe(true);
      expect(by("333").assigned).toBeUndefined();
      expect(by("444").assigned).toBeUndefined();
      // 未注入 managedStateDir(master/单机)→ 全部省略
      const rows2 = makeApi({ store: s, manager: new MockManager() }).listTasks().body as Row[];
      expect(rows2.every((r) => r.assigned === undefined)).toBe(true);
    } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("快照损坏 → 不抛,全部省略(视为归属)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assigned-api-"));
    writeFileSync(join(dir, "rooms.json"), "{坏");
    const s = new TaskStore(":memory:");
    try {
      const { applyRemoteTasks } = await import("../../packages/app/src/task-sync.js");
      applyRemoteTasks(s, [spec({})] as never, undefined, { adopt: true });
      const rows = makeApi({ store: s, manager: new MockManager(), managedStateDir: dir }).listTasks().body as Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0]!.assigned).toBeUndefined();
    } finally { s.close(); rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("hubQueue.delivering(F1:边录边传实时进度)", () => {
  const d = (over: Record<string, unknown> = {}) => ({
    workerId: "n1", workerName: "node 1", platform: "douyin", roomSlug: "111", anchorName: null,
    sessionBase: "S1", bv: "BV1X", confirmed: 2, total: 3, ambiguous: 0, uploading: null, recording: true, checkedAt: 1, ...over,
  });
  const queue = (deps: Partial<ApiDeps>, opts: Parameters<ReturnType<typeof makeApi>["hubQueue"]>[0] = {}) =>
    (makeApi({ store, manager, syncDbPath: "/nonexistent/x-sync.db", ...deps }).hubQueue(opts).body as { delivering?: Array<Record<string, unknown>> });

  it("带回节点上报的进度,并按房间补主播名", () => {
    store.addTask({ room: "111", name: "小苏" });
    const b = queue({ rollingDelivery: () => [d() as never] });
    expect(b.delivering).toHaveLength(1);
    expect(b.delivering![0]).toMatchObject({ roomSlug: "111", anchorName: "小苏", bv: "BV1X", confirmed: 2, total: 3 });
  });

  it("未注入 rollingDelivery(旧 master / 无节点)→ 空数组,队列其余字段不受影响", () => {
    const b = queue({});
    expect(b.delivering).toEqual([]);
    expect(b).toHaveProperty("pool");
  });

  it("平台与关键字筛选对进度同样生效;phase 筛选不影响", () => {
    store.addTask({ room: "111", name: "小苏" });
    const items = [d(), d({ platform: "bilibili", roomSlug: "222", sessionBase: "S2" })] as never[];
    expect(queue({ rollingDelivery: () => items }, { platform: ["bilibili"] }).delivering!.map((x) => x.sessionBase)).toEqual(["S2"]);
    expect(queue({ rollingDelivery: () => items }, { q: "小苏" }).delivering!.map((x) => x.sessionBase)).toEqual(["S1"]);
    expect(queue({ rollingDelivery: () => items }, { phase: ["done"] }).delivering).toHaveLength(2);
  });
});
