/**
 * web-server.test.ts — light integration test of the http layer.
 *
 *   - matchRoute(): pure route + :id param extraction (no socket).
 *   - createWebServer(): a real listen on an ephemeral port + fetch, exercising
 *     JSON body parsing, status serialisation, the SPA route, and 404.
 *
 * Uses a real in-memory TaskStore + a trivial mock manager (no subprocess).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { TaskStore } from "../../packages/app/src/store.js";
import { createWebServer, matchRoute } from "../../packages/app/src/web/server.js";
import type { ManagerLike } from "../../packages/app/src/web/api.js";

class MockManager implements ManagerLike {
  private running = new Set<number>();
  runningIds(): number[] {
    return [...this.running];
  }
  isRunning(id: number): boolean {
    return this.running.has(id);
  }
  start(id: number): boolean {
    if (this.running.has(id)) return false;
    this.running.add(id);
    return true;
  }
  async stop(id: number): Promise<void> {
    this.running.delete(id);
  }
  async stopGraceful(id: number): Promise<void> {
    this.running.delete(id);
  }
  getRuntime(id: number): { running: boolean; startedAt: number | null; elapsedMs: number | null; anchorName: string | null } {
    const running = this.running.has(id);
    return { running, startedAt: running ? 1000 : null, elapsedMs: running ? 5000 : null, anchorName: null };
  }
  getAnchorName(): string | null {
    return null;
  }
  isRecording(id: number): boolean {
    return this.running.has(id);
  }
  getLogs(): string[] {
    return [];
  }
}

describe("matchRoute", () => {
  it("routes the api surface with :id extraction", () => {
    expect(matchRoute("GET", "/")?.name).toBe("index");
    expect(matchRoute("GET", "/api/tasks")?.name).toBe("listTasks");
    expect(matchRoute("POST", "/api/tasks")).toMatchObject({ name: "createTask", needsBody: true });
    expect(matchRoute("GET", "/api/tasks/7")).toMatchObject({ name: "getTask", id: 7 });
    expect(matchRoute("PATCH", "/api/tasks/7")).toMatchObject({ name: "updateTask", id: 7, needsBody: true });
    expect(matchRoute("DELETE", "/api/tasks/7")).toMatchObject({ name: "deleteTask", id: 7 });
    expect(matchRoute("POST", "/api/tasks/7/start")).toMatchObject({ name: "startTask", id: 7 });
    expect(matchRoute("POST", "/api/tasks/7/stop")).toMatchObject({ name: "stopTask", id: 7 });
    expect(matchRoute("GET", "/api/tasks/7/logs")).toMatchObject({ name: "getTaskLogs", id: 7 });
    expect(matchRoute("POST", "/api/login/qr")?.name).toBe("startLogin");
    expect(matchRoute("GET", "/api/login/qr/login-abc_1")).toMatchObject({
      name: "pollLogin",
      sid: "login-abc_1",
    });
    expect(matchRoute("GET", "/api/cookie")?.name).toBe("getCookie");
    expect(matchRoute("POST", "/api/cookie")).toMatchObject({ name: "setCookie", needsBody: true });
    expect(matchRoute("DELETE", "/api/cookie")?.name).toBe("clearCookie");
    expect(matchRoute("GET", "/api/hub/rules")?.name).toBe("listHubRules");
    expect(matchRoute("POST", "/api/hub/rules")).toMatchObject({ name: "createHubRule", needsBody: true });
    expect(matchRoute("PATCH", "/api/hub/rules/123456")).toMatchObject({ name: "updateHubRule", slug: "123456", needsBody: true });
    expect(matchRoute("DELETE", "/api/hub/rules/123456")).toMatchObject({ name: "deleteHubRule", slug: "123456" });
  });

  it("returns null for unknown routes / wrong methods", () => {
    expect(matchRoute("GET", "/nope")).toBeNull();
    expect(matchRoute("PUT", "/api/tasks/7")).toBeNull();
    expect(matchRoute("GET", "/api/tasks/7/start")).toBeNull();
    expect(matchRoute("GET", "/api/login/qr")).toBeNull();
    expect(matchRoute("POST", "/api/login/qr/abc")).toBeNull();
    expect(matchRoute("PUT", "/api/cookie")).toBeNull();
  });
});

describe("createWebServer (live)", () => {
  let store: TaskStore;
  let server: Server;
  let base: string;

  beforeEach(async () => {
    store = new TaskStore(":memory:");
    // no-op anchor resolver so创建任务不会触发真实 getInfo（vitest 无法 import biliLive）。
    server = createWebServer({
      store,
      manager: new MockManager(),
      log: () => {},
      resolveAnchor: async () => null,
      resolveShortUrl: async () => null,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("GET / serves the SPA html", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<!DOCTYPE html>/i);
  });

  it("GET /api/tasks → json list", async () => {
    store.addTask({ room: "111" });
    const res = await fetch(`${base}/api/tasks`);
    expect(res.status).toBe(200);
    const tasks = (await res.json()) as Array<{ room: string; running: boolean }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0].room).toBe("https://live.douyin.com/111"); // 入库归一化
    expect(tasks[0].running).toBe(false);
  });

  it("POST /api/tasks parses body + creates (201)", async () => {
    const res = await fetch(`${base}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ room: "222", name: "t" }),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number; room: string };
    expect(t.room).toBe("https://live.douyin.com/222");
    expect(store.getTask(t.id)).not.toBeNull();
  });

  it("POST /api/tasks with bad json → 400", async () => {
    const res = await fetch(`${base}/api/tasks`, { method: "POST", body: "{not json" });
    expect(res.status).toBe(400);
  });

  it("unknown API route → 404 json", async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toMatch(/application\/json/);
  });

  it("unknown client route → SPA fallback (index.html)", async () => {
    // The React app uses BrowserRouter; any non-/api path serves index.html so
    // deep links / refreshes on client routes work.
    const res = await fetch(`${base}/task/7`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<!DOCTYPE html>/i);
  });

  it("PATCH /api/tasks/:id updates + reflects in GET", async () => {
    const created = await (await fetch(`${base}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ room: "333", name: "old" }),
    })).json() as { id: number };

    const patch = await fetch(`${base}/api/tasks/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ name: "new", danmu: 0 }),
    });
    expect(patch.status).toBe(200);
    const updated = (await patch.json()) as { name: string; danmu: number; room: string };
    expect(updated.name).toBe("new");
    expect(updated.danmu).toBe(0);
    expect(updated.room).toBe("https://live.douyin.com/333");

    const list = (await (await fetch(`${base}/api/tasks`)).json()) as Array<{ id: number; name: string }>;
    expect(list.find((t) => t.id === created.id)!.name).toBe("new");
  });

  it("hub rules CRUD via http (create → list → patch → delete)", async () => {
    const create = await fetch(`${base}/api/hub/rules`, {
      method: "POST",
      body: JSON.stringify({ room: "https://live.douyin.com/654321", config: { steps: { burnLivechat: false } } }),
    });
    expect(create.status).toBe(201);
    const rule = (await create.json()) as { roomSlug: string; enabled: boolean; config: { steps?: { burnLivechat?: boolean } } };
    expect(rule.roomSlug).toBe("654321");
    expect(rule.enabled).toBe(true);
    expect(rule.config.steps?.burnLivechat).toBe(false);

    const list = (await (await fetch(`${base}/api/hub/rules`)).json()) as Array<{ roomSlug: string }>;
    expect(list).toHaveLength(1);

    const patch = await fetch(`${base}/api/hub/rules/654321`, {
      method: "PATCH",
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { enabled: boolean }).enabled).toBe(false);

    const del = await fetch(`${base}/api/hub/rules/654321`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const missing = await fetch(`${base}/api/hub/rules/654321`, { method: "PATCH", body: JSON.stringify({ enabled: true }) });
    expect(missing.status).toBe(404);
  });

  it("start/stop lifecycle via http", async () => {
    const created = await (await fetch(`${base}/api/tasks`, {
      method: "POST",
      body: JSON.stringify({ room: "333" }),
    })).json() as { id: number };

    const start = await fetch(`${base}/api/tasks/${created.id}/start`, { method: "POST" });
    expect(start.status).toBe(200);
    // 启用是幂等的：已在运行再点启动 → 仍 200（不再 409）
    const again = await fetch(`${base}/api/tasks/${created.id}/start`, { method: "POST" });
    expect(again.status).toBe(200);

    const stop = await fetch(`${base}/api/tasks/${created.id}/stop`, { method: "POST" });
    expect(stop.status).toBe(200);
  });
});
