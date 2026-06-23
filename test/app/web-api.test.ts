/**
 * web-api.test.ts — unit tests for the http-free api.ts handlers.
 *
 * The handlers operate over a { store, manager } seam and return
 * { status, body } — no node:http, no real subprocess. We drive them with a
 * real in-memory TaskStore and a mock TaskManager (just records runningIds +
 * start/stop calls) so assertions stay deterministic.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { MergeJobStore } from "../../packages/app/src/merge-jobs.js";
import { EventCenter } from "../../packages/app/src/events.js";
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
    if (this.running.has(id)) return false;
    this.running.add(id);
    return true;
  }
  async stop(id: number): Promise<void> {
    this.stopCalls.push(id);
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
