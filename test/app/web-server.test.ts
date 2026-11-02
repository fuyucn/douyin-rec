/**
 * web-server.test.ts — light integration test of the http layer.
 *
 *   - matchRoute(): pure route + :id param extraction (no socket).
 *   - createWebServer(): a real listen on an ephemeral port + fetch, exercising
 *     JSON body parsing, status serialisation, the SPA route, and 404.
 *
 * Uses a real in-memory TaskStore + a trivial mock manager (no subprocess).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { request as httpRequest } from "node:http";
import { mkdtempSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { createWebServer, matchRoute, hostAllowed, originAllowed } from "../../packages/app/src/web/server.js";
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
  async stopWithin(id: number, _ms: number): Promise<boolean> {
    await this.stop(id);
    return true;
  }
  isStopping(_id: number): boolean {
    return false;
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

/**
 * 裸 node:http 请求(undici fetch 禁止覆盖 Host,Host/Origin 场景只能这样发)。
 * 只关心状态码;响应体直接 resume 丢弃。
 */
function raw(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/api/tasks", headers: opts.headers }, // issue-guard: allow
      (r) => {
        void r.resume();
        resolve({ status: r.statusCode ?? 0 });
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

/**
 * 裸 node:http 请求且**等完整响应**(headers + body 全部读完):用于验证 413 确实送达客户端
 * 且带 Connection: close(复审),而非连接被提前销毁只剩半截/重置。
 */
function rawFull(
  port: number,
  opts: { method?: string; path?: string; headers?: Record<string, string>; totalBytes?: number },
): Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, method: opts.method ?? "GET", path: opts.path ?? "/api/tasks", headers: opts.headers }, // issue-guard: allow
      (r) => {
        const chunks: Buffer[] = [];
        r.on("data", (c: Buffer) => chunks.push(c));
        r.on("end", () => resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks).toString("utf-8") }));
      },
    );
    req.on("error", reject);
    if (opts.totalBytes !== undefined) {
      // 大 body 分块写并尊重背压,模拟真实客户端边发边等;响应早到也能正常读完。
      const chunk = Buffer.alloc(64 * 1024, 0x78);
      let sent = 0;
      const total = opts.totalBytes;
      const writeMore = (): void => {
        while (sent < total) {
          const n = Math.min(chunk.length, total - sent);
          const ok = req.write(n === chunk.length ? chunk : chunk.subarray(0, n));
          sent += n;
          if (!ok) { req.once("drain", writeMore); return; }
        }
        req.end();
      };
      writeMore();
    } else {
      req.end();
    }
  });
}

/** 本测试文件里 fetch 的 JSON body 统一带 content-type(带 body 的请求会被 415 拒收,issue #427)。 */
const JSON_HEADERS = { "content-type": "application/json" };

describe("请求入口防护纯函数(issue #427)", () => {
  /** 造一个只带被测字段的最小 IncomingMessage 形状(originAllowed 只读 headers/socket)。 */
  const fakeReq = (headers: Record<string, string>, remoteAddress = "127.0.0.1"): // issue-guard: allow
    import("node:http").IncomingMessage =>
    ({ headers, socket: { remoteAddress } } as unknown as import("node:http").IncomingMessage);

  it("hostAllowed:缺失/空 Host → false(入口回 403)", () => {
    expect(hostAllowed(undefined)).toBe(false);
    expect(hostAllowed("")).toBe(false);
  });

  it("originAllowed:Origin null + 非回环 remoteAddress → false(入口回 403)", () => {
    expect(originAllowed(fakeReq({ origin: "null", host: "box.ts.net" }, "192.168.1.9"), "POST")).toBe(false); // issue-guard: allow
    // 对照:同头 + 回环 → 放行
    expect(originAllowed(fakeReq({ origin: "null", host: "box.ts.net" }), "POST")).toBe(true);
  });

  it("hostAllowed:单标签短名/`.local`/末尾点 FQDN 放行;伪装后缀/剥点后空仍拒(复审)", () => {
    expect(hostAllowed("master")).toBe(true); // Tailscale MagicDNS 短名
    expect(hostAllowed("master:7860")).toBe(true); // 带端口剥端口后同上
    expect(hostAllowed("mybox.local")).toBe(true); // mDNS/Bonjour
    expect(hostAllowed("x.tailnet.ts.net.")).toBe(true); // 末尾点 FQDN 与不带点等价
    expect(hostAllowed("x.tailnet.ts.net")).toBe(true);
    expect(hostAllowed("attacker.example.com.")).toBe(false); // 末尾点不构成白名单
    expect(hostAllowed("evil.local.attacker.io")).toBe(false); // 伪装后缀
    expect(hostAllowed(".")).toBe(false); // 剥点后为空
  });

  it("originAllowed:Host/Origin 主机部分末尾点归一后比较;端口仍参与判定(复审)", () => {
    const xfwd = { "x-forwarded-proto": "https" };
    expect(originAllowed(fakeReq({ origin: "https://x.tailnet.ts.net.", host: "x.tailnet.ts.net.", ...xfwd }), "POST")).toBe(true);
    expect(originAllowed(fakeReq({ origin: "https://x.tailnet.ts.net", host: "x.tailnet.ts.net.", ...xfwd }), "POST")).toBe(true);
    // 端口不同仍是不同 origin(归一只去末尾点,不抹端口)
    expect(originAllowed(fakeReq({ origin: "https://box.ts.net:8443", host: "box.ts.net", ...xfwd }), "POST")).toBe(false);
  });
});

describe("matchRoute", () => {
  it("非法 percent 编码 → 不匹配(而不是抛 URIError 崩进程)", () => {
    expect(matchRoute("GET", "/api/hub/jobs/%/log")).toBeNull();
    expect(matchRoute("POST", "/api/hub/jobs/%E0%A4%A/retry-node")).toBeNull();
    expect(matchRoute("GET", "/api/hub/jobs/douyin:1:2026-01-01/log")).toMatchObject({ name: "getHubJobLog" });
  });

  it("routes the api surface with :id extraction", () => {
    expect(matchRoute("GET", "/")?.name).toBe("index");
    expect(matchRoute("GET", "/api/tasks")?.name).toBe("listTasks");
    expect(matchRoute("POST", "/api/tasks")).toMatchObject({ name: "createTask", needsBody: true });
    expect(matchRoute("GET", "/api/tasks/7")).toMatchObject({ name: "getTask", id: 7 });
    expect(matchRoute("PATCH", "/api/tasks/7")).toMatchObject({ name: "updateTask", id: 7, needsBody: true });
    expect(matchRoute("DELETE", "/api/tasks/7")).toMatchObject({ name: "deleteTask", id: 7 });
    expect(matchRoute("POST", "/api/tasks/7/refresh-anchor")).toMatchObject({ name: "refreshTaskAnchor", id: 7 });
    expect(matchRoute("POST", "/api/tasks/7/start")).toMatchObject({ name: "startTask", id: 7 });
    expect(matchRoute("POST", "/api/tasks/7/stop")).toMatchObject({ name: "stopTask", id: 7 });
    // T18:排空是独立路由(不是 stop 的一个参数)—— 语义不同,不能靠 body 区分
    expect(matchRoute("POST", "/api/tasks/7/drain")).toMatchObject({ name: "drainTask", id: 7 });
    expect(matchRoute("GET", "/api/tasks/7/logs")).toMatchObject({ name: "getTaskLogs", id: 7 });
    expect(matchRoute("POST", "/api/login/qr")).toMatchObject({ name: "startLogin", needsBody: true });
    expect(matchRoute("GET", "/api/login/qr/login-abc_1")).toMatchObject({
      name: "pollLogin",
      sid: "login-abc_1",
    });
    expect(matchRoute("GET", "/api/cookie")?.name).toBe("getCookie");
    expect(matchRoute("POST", "/api/cookie")).toMatchObject({ name: "setCookie", needsBody: true });
    expect(matchRoute("DELETE", "/api/cookie")?.name).toBe("clearCookie");
    expect(matchRoute("GET", "/api/biliup/status")?.name).toBe("getBiliupStatus");
    expect(matchRoute("GET", "/api/cookies")?.name).toBe("listCookies");
    expect(matchRoute("GET", "/api/cookies/bilibili")).toMatchObject({ name: "getCookiePlatform", slug: "bilibili" });
    expect(matchRoute("POST", "/api/cookies/bilibili")).toMatchObject({ name: "setCookiePlatform", slug: "bilibili", needsBody: true });
    expect(matchRoute("DELETE", "/api/cookies/bilibili")).toMatchObject({ name: "clearCookiePlatform", slug: "bilibili" });
    expect(matchRoute("GET", "/api/hub/status")?.name).toBe("hubStatus");
    // T-2:force 通道入口(POST + query,无 body)
    expect(matchRoute("POST", "/api/hub/apply")?.name).toBe("applyHubTasks");
    expect(matchRoute("GET", "/api/hub/apply")).toBeNull();
    expect(matchRoute("GET", "/api/hub/rules")?.name).toBe("listHubRules");
    expect(matchRoute("POST", "/api/hub/rules")).toMatchObject({ name: "createHubRule", needsBody: true });
    expect(matchRoute("PATCH", "/api/hub/rules/douyin.123456")).toMatchObject({ name: "updateHubRule", slug: "douyin.123456", needsBody: true });
    expect(matchRoute("DELETE", "/api/hub/rules/douyin.123456")).toMatchObject({ name: "deleteHubRule", slug: "douyin.123456" });
    expect(matchRoute("GET", "/api/timezone")?.name).toBe("getTimezone");
    expect(matchRoute("POST", "/api/timezone")).toMatchObject({ name: "setTimezone", needsBody: true });
    expect(matchRoute("GET", "/api/hub/workers")?.name).toBe("listWorkers");
    expect(matchRoute("POST", "/api/hub/workers")).toMatchObject({ name: "createWorker", needsBody: true });
    expect(matchRoute("PATCH", "/api/hub/workers/worker-1")).toMatchObject({ name: "updateWorker", slug: "worker-1", needsBody: true });
    expect(matchRoute("DELETE", "/api/hub/workers/local")).toMatchObject({ name: "deleteWorker", slug: "local" });
    expect(matchRoute("POST", "/api/hub/workers/test")).toMatchObject({ name: "testWorker", needsBody: true });
    expect(matchRoute("GET", "/api/hub/workers/status")?.name).toBe("workersStatus");
    expect(matchRoute("GET", "/api/hub/jobs")?.name).toBe("listHubJobs");
    expect(matchRoute("GET", "/api/hub/jobs/douyin%3A123%3A2026-08-10/log")).toMatchObject({
      name: "getHubJobLog",
      sid: "douyin:123:2026-08-10",
    });
    expect(matchRoute("POST", "/api/hub/jobs/douyin%3A123%3A2026-08-10/retry-node")).toMatchObject({
      name: "retryHubNode",
      sid: "douyin:123:2026-08-10",
      needsBody: true,
    });
    expect(matchRoute("POST", "/api/hub/jobs/run")).toMatchObject({
      name: "runHubJob",
      needsBody: true,
    });
    expect(matchRoute("POST", "/api/hub/jobs/douyin%3A123%3A2026-08-10/stop")).toMatchObject({
      name: "stopHubJob",
      sid: "douyin:123:2026-08-10",
    });
    expect(matchRoute("POST", "/api/hub/jobs/douyin%3A123%3A2026-08-10/ack")).toMatchObject({
      name: "ackHubJob",
      sid: "douyin:123:2026-08-10",
      needsBody: true,
    });
    expect(matchRoute("GET", "/api/platforms")?.name).toBe("listPlatforms");
    expect(matchRoute("GET", "/api/webhook")?.name).toBe("getWebhook");
    expect(matchRoute("POST", "/api/webhook")).toMatchObject({ name: "setWebhook", needsBody: true });
    expect(matchRoute("POST", "/api/webhook/test")).toMatchObject({ name: "testWebhook", needsBody: true });
    expect(matchRoute("GET", "/api/version")?.name).toBe("getVersion");
    expect(matchRoute("GET", "/api/mesio-path")?.name).toBe("getMesioPath");
    expect(matchRoute("POST", "/api/mesio-path")).toMatchObject({ name: "setMesioPath", needsBody: true });
    expect(matchRoute("GET", "/api/events")?.name).toBe("getEvents");
    expect(matchRoute("GET", "/api/merges/merge-job-1")).toMatchObject({ name: "getMerge", sid: "merge-job-1" });
    expect(matchRoute("GET", "/api/tasks/7/recordings")).toMatchObject({ name: "listRecordings", id: 7 });
    expect(matchRoute("POST", "/api/tasks/7/merge")).toMatchObject({ name: "startMerge", id: 7, needsBody: true });
    // status 不能被 /:id 正则吞掉
    expect(matchRoute("GET", "/api/hub/workers/local")).toBeNull(); // GET /:id 无路由(只有 PATCH/DELETE)
  });

  it("normalises trailing slash and keeps root", () => {
    expect(matchRoute("GET", "/api/tasks/")?.name).toBe("listTasks");
    expect(matchRoute("GET", "/api/tasks/7/")).toMatchObject({ name: "getTask", id: 7 });
    expect(matchRoute("GET", "/")).toMatchObject({ name: "index" });
  });

  it("returns null for unknown routes / wrong methods", () => {
    expect(matchRoute("GET", "/nope")).toBeNull();
    expect(matchRoute("PUT", "/api/tasks/7")).toBeNull();
    expect(matchRoute("GET", "/api/tasks/7/start")).toBeNull();
    expect(matchRoute("GET", "/api/login/qr")).toBeNull();
    expect(matchRoute("POST", "/api/login/qr/abc")).toBeNull();
    expect(matchRoute("PUT", "/api/cookie")).toBeNull();
    expect(matchRoute("DELETE", "/api/hub/jobs/x/log")).toBeNull();
    expect(matchRoute("GET", "/api/merges")).toBeNull();
    expect(matchRoute("PATCH", "/api/tasks/7/recordings")).toBeNull();
  });
});

describe("createWebServer (live)", () => {
  let store: TaskStore;
  let server: Server;
  let base: string;
  let hubDir: string;
  const prevTZ = process.env.TZ; // timezone 测试会覆盖 process.env.TZ,每个 it 后还原,不泄漏到别的测试文件。

  beforeEach(async () => {
    store = new TaskStore(":memory:");
    hubDir = mkdtempSync(join(tmpdir(), "web-hub-")); // 文件版 hub 配置 → 临时目录
    // no-op anchor resolver so创建任务不会触发真实 getInfo（vitest 无法 import biliLive）。
    server = createWebServer({
      store,
      manager: new MockManager(),
      log: () => {},
      resolveAnchor: async () => null,
      resolveShortUrl: async () => null,
      hubDir,
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const addr = server.address() as AddressInfo;
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  });

  it("GET / serves the SPA html", async () => {
    const res = await fetch(`${base}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toMatch(/<!DOCTYPE html>/i);
  });

  // T-2 端到端:HTTP → 路由 → api → requestSyncTasks({force})。
  // 只在 master(hubEnabled)且注入了 requestSyncTasks 时才 202,否则 400 —— 语义见 hub-rules.applyHubTasks。
  it("POST /api/hub/apply?force=1 → 202 且 requestSyncTasks 收到 force", async () => {
    const requestSyncTasks = vi.fn();
    const s2 = createWebServer({
      store, manager: new MockManager(), log: () => {},
      resolveAnchor: async () => null, resolveShortUrl: async () => null,
      hubDir, hubEnabled: true, requestSyncTasks,
    });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    try {
      const forced = await fetch(`${b2}/api/hub/apply?force=1`, { method: "POST" });
      expect(forced.status).toBe(202);
      expect(requestSyncTasks).toHaveBeenLastCalledWith({ force: true });
      await fetch(`${b2}/api/hub/apply`, { method: "POST" });
      expect(requestSyncTasks).toHaveBeenLastCalledWith({ force: false });
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
    // 非 master(默认 beforeEach 没注入 hubEnabled)→ 400,不触发同步
    const slave = await fetch(`${base}/api/hub/apply?force=1`, { method: "POST" });
    expect(slave.status).toBe(400);
    expect(requestSyncTasks).toHaveBeenCalledTimes(2);
  });

  // 回归:资源端点必须**经由 server.ts 的 deps 转发**生效。
  // 之前我在 WebServerDeps 加了 hubConfigSource 却忘了转进 makeApi,
  // 而 web-api.test 直接往 makeApi 注入 → 两端各自绿,线上却是「hub 未启用」(自审发现)。
  it("GET /api/hub/resources 经由 server deps 转发(hubConfigSource 不能只加在类型上)", async () => {
    const cfgPath = join(hubDir, "hub.config.json");
    writeFileSync(cfgPath, JSON.stringify({ resources: { maxCpuParallel: 1 } }), "utf-8");
    const s2 = createWebServer({
      store, manager: new MockManager(), log: () => {},
      resolveAnchor: async () => null, resolveShortUrl: async () => null,
      hubDir, hubEnabled: true,
      hubConfigSource: () => ({ json: readFileSync(cfgPath, "utf-8"), path: cfgPath, source: "root-file" }),
    });
    await new Promise<void>((r) => s2.listen(0, "127.0.0.1", r));
    const b2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`;
    try {
      const got = await fetch(`${b2}/api/hub/resources`);
      expect(got.status).toBe(200);
      const body = (await got.json()) as { source: string; resources: { maxCpuParallel: number } };
      expect(body.source).toBe("root-file");
      const put = await fetch(`${b2}/api/hub/resources`, {
        method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ maxCpuParallel: 4 }),
      });
      expect(put.status).toBe(200);
      expect((JSON.parse(readFileSync(cfgPath, "utf-8")) as { resources: { maxCpuParallel: number } })
        .resources.maxCpuParallel).toBe(4);
    } finally {
      await new Promise<void>((r) => s2.close(() => r()));
    }
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
      headers: JSON_HEADERS,
      body: JSON.stringify({ room: "222", name: "t" }),
    });
    expect(res.status).toBe(201);
    const t = (await res.json()) as { id: number; room: string };
    expect(t.room).toBe("https://live.douyin.com/222");
    expect(store.getTask(t.id)).not.toBeNull();
  });

  it("非法 percent 编码 → 400,且服务仍存活(修复远端 DoS)", async () => {
    const bad = await fetch(`${base}/api/hub/jobs/%/log`);
    expect(bad.status).toBe(400);
    const ok = await fetch(`${base}/api/tasks`);
    expect(ok.status).toBe(200); // 进程没被打死
  });

  it("POST /api/tasks with bad json → 400", async () => {
    const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: JSON_HEADERS, body: "{not json" });
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
      headers: JSON_HEADERS,
      body: JSON.stringify({ room: "333", name: "old" }),
    })).json() as { id: number };

    const patch = await fetch(`${base}/api/tasks/${created.id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
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

  it("timezone via http(config 驱动,覆盖 process.env.TZ;非法值 400;空串回落默认)", async () => {
    const get1 = await fetch(`${base}/api/timezone`);
    expect(get1.status).toBe(200);
    const body1 = (await get1.json()) as { timezone: string; default: string; effective: string };
    expect(body1.timezone).toBe(""); // 未设置
    expect(body1.default).toBeTruthy();

    const bad = await fetch(`${base}/api/timezone`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ timezone: "Not/A/Zone" }) });
    expect(bad.status).toBe(400);

    const set = await fetch(`${base}/api/timezone`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ timezone: "Asia/Shanghai" }) });
    expect(set.status).toBe(200);
    const setBody = (await set.json()) as { timezone: string; effective: string };
    expect(setBody.timezone).toBe("Asia/Shanghai");
    expect(setBody.effective).toBe("Asia/Shanghai");
    expect(process.env.TZ).toBe("Asia/Shanghai"); // 真的覆盖了进程环境变量

    const clear = await fetch(`${base}/api/timezone`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ timezone: "" }) });
    expect(((await clear.json()) as { effective: string }).effective).toBe(body1.default); // 清空回落默认
  });

  it("hub status via http(未注入 hubEnabled → enabled:false,= slave/child node)", async () => {
    const res = await fetch(`${base}/api/hub/status`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { enabled: boolean }).enabled).toBe(false);
  });

  it("hub rules CRUD via http(文件版,key={platform}.{roomSlug};建/删落到 hubDir 文件)", async () => {
    // 新规则必须绑定一个 master 源任务:房间/roomSlug 从该任务派生。
    const task = await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ room: "654321" }),
    });
    expect(task.status).toBe(201);
    const { id: sourceTaskId } = (await task.json()) as { id: number };

    const create = await fetch(`${base}/api/hub/rules`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        recording: { sourceTaskId },
        pipeline: { steps: { burnLivechat: false } },
      }),
    });
    expect(create.status).toBe(201);
    const rule = (await create.json()) as { key: string; roomSlug: string; platform: string; enabled: boolean; pipeline: { steps?: { burnLivechat?: boolean } } };
    expect(rule.key).toBe("douyin.654321");
    expect(rule.roomSlug).toBe("654321");
    expect(rule.enabled).toBe(true);
    expect(rule.pipeline.steps?.burnLivechat).toBe(false);
    // 文件真的落到 hubDir
    expect(existsSync(join(hubDir, "douyin.654321.json"))).toBe(true);

    const list = (await (await fetch(`${base}/api/hub/rules`)).json()) as Array<{ key: string }>;
    expect(list.map((r) => r.key)).toEqual(["douyin.654321"]);

    const patch = await fetch(`${base}/api/hub/rules/douyin.654321`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { enabled: boolean }).enabled).toBe(false);

    const del = await fetch(`${base}/api/hub/rules/douyin.654321`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(existsSync(join(hubDir, "douyin.654321.json"))).toBe(false); // 删文件
    const missing = await fetch(`${base}/api/hub/rules/douyin.654321`, { method: "PATCH", headers: JSON_HEADERS, body: JSON.stringify({ enabled: true }) });
    expect(missing.status).toBe(404);
  });

  it("start/stop lifecycle via http", async () => {
    const created = await (await fetch(`${base}/api/tasks`, {
      method: "POST",
      headers: JSON_HEADERS,
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

  // ── 请求入口防护(issue #427 P1)──
  it("Host 白名单:IP 字面量/localhost/*.ts.net 放行(忽略端口),其余 403", async () => {
    const port = Number(new URL(base).port);
    expect((await raw(port, { headers: { host: "127.0.0.1" } })).status).toBe(200); // issue-guard: allow
    expect((await raw(port, { headers: { host: "localhost:7860" } })).status).toBe(200);
    expect((await raw(port, { headers: { host: "mybox.ts.net" } })).status).toBe(200);
    expect((await raw(port, { headers: { host: "[::1]:7860" } })).status).toBe(200);
    expect((await raw(port, { headers: { host: "attacker.example.com" } })).status).toBe(403);
    // 后缀匹配:裸 ts.net 与伪装后缀不在白名单
    expect((await raw(port, { headers: { host: "ts.net" } })).status).toBe(403);
    expect((await raw(port, { headers: { host: "evil.ts.net.attacker.io" } })).status).toBe(403);
  });

  it("Host 白名单放宽(复审):单标签短名/`.local`/末尾点 FQDN 放行,伪装后缀仍 403", async () => {
    const port = Number(new URL(base).port);
    expect((await raw(port, { headers: { host: "master" } })).status).toBe(200);
    expect((await raw(port, { headers: { host: "mybox.local" } })).status).toBe(200);
    expect((await raw(port, { headers: { host: "x.tailnet.ts.net." } })).status).toBe(200);
    expect((await raw(port, { headers: { host: "attacker.example.com." } })).status).toBe(403);
    expect((await raw(port, { headers: { host: "evil.local.attacker.io" } })).status).toBe(403);
  });

  it("DREC_ALLOWED_HOSTS 逗号分隔追加白名单,比对忽略端口", async () => {
    const port = Number(new URL(base).port);
    const prev = process.env.DREC_ALLOWED_HOSTS;
    try {
      process.env.DREC_ALLOWED_HOSTS = "master.example.com, backup.corp:8443";
      expect((await raw(port, { headers: { host: "master.example.com" } })).status).toBe(200);
      expect((await raw(port, { headers: { host: "backup.corp:9000" } })).status).toBe(200);
      expect((await raw(port, { headers: { host: "other.example.com" } })).status).toBe(403);
    } finally {
      if (prev === undefined) delete process.env.DREC_ALLOWED_HOSTS;
      else process.env.DREC_ALLOWED_HOSTS = prev;
    }
  });

  it("Origin 校验:同源放行 / 跨站 403 / Origin null 仅回环 / 无 Origin 放行 / GET 豁免", async () => {
    const port = Number(new URL(base).port);
    const created = await (await fetch(`${base}/api/tasks`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ room: "444" }),
    })).json() as { id: number };
    const stopPath = `/api/tasks/${created.id}/stop`;
    const self = `http://127.0.0.1:${port}`; // issue-guard: allow
    // 同源(浏览器 same-origin POST 必带 Origin)→ 200
    expect((await raw(port, { method: "POST", path: stopPath, headers: { origin: self } })).status).toBe(200);
    // 跨站 Origin → 403
    expect((await raw(port, { method: "POST", path: stopPath, headers: { origin: "http://evil.example.com" } })).status).toBe(403);
    // Origin: null + 本机回环 → 200
    expect((await raw(port, { method: "POST", path: stopPath, headers: { origin: "null" } })).status).toBe(200);
    // 无 Origin(curl、内部 fetch)→ 200
    expect((await raw(port, { method: "POST", path: stopPath })).status).toBe(200);
    // GET 豁免 Origin 校验
    expect((await raw(port, { path: "/api/tasks", headers: { origin: "http://evil.example.com" } })).status).toBe(200);
  });

  it("x-forwarded-proto:https 反代同源放行;无该头时 https Origin 仍 403(复审)", async () => {
    const port = Number(new URL(base).port);
    const created = await (await fetch(`${base}/api/tasks`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ room: "446" }),
    })).json() as { id: number };
    const stopPath = `/api/tasks/${created.id}/stop`;
    // 反代 TLS 终止:x-forwarded-proto: https + 同源 https Origin → 放行
    expect((await raw(port, {
      method: "POST", path: stopPath,
      headers: { host: "box.ts.net", origin: "https://box.ts.net", "x-forwarded-proto": "https" },
    })).status).toBe(200);
    // 无 x-forwarded-proto:服务端按 http 比对 https Origin → 403(scheme 不符)
    expect((await raw(port, {
      method: "POST", path: stopPath,
      headers: { host: "box.ts.net", origin: "https://box.ts.net" },
    })).status).toBe(403);
  });

  it("PUT/DELETE 跨站 Origin → 403(复审)", async () => {
    const port = Number(new URL(base).port);
    expect((await raw(port, { method: "PUT", path: "/api/hub/resources", headers: { origin: "http://evil.example.com" } })).status).toBe(403);
    const created = await (await fetch(`${base}/api/tasks`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ room: "447" }),
    })).json() as { id: number };
    expect((await raw(port, { method: "DELETE", path: `/api/tasks/${created.id}`, headers: { origin: "http://evil.example.com" } })).status).toBe(403);
  });

  it("content-type:空 body POST 豁免;带 body 的 text/plain → 415;application/json → 放行", async () => {
    // 空体(undici fetch 无 body 不发 content-type)→ 豁免,进入 handler
    const empty = await fetch(`${base}/api/timezone`, { method: "POST" });
    expect(empty.status).toBe(200);
    // 带 body 但 text/plain(undici 对 string body 的默认)→ 415
    const plain = await fetch(`${base}/api/tasks`, { method: "POST", body: JSON.stringify({ room: "1" }) });
    expect(plain.status).toBe(415);
    // application/json → 放行
    const json = await fetch(`${base}/api/tasks`, {
      method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ room: "445" }),
    });
    expect(json.status).toBe(201);
  });

  it("body 超过 2 MiB → 413,服务仍存活", async () => {
    const big = JSON.stringify({ room: "1", name: "x".repeat(2 * 1024 * 1024 + 16) });
    const res = await fetch(`${base}/api/tasks`, { method: "POST", headers: JSON_HEADERS, body: big });
    expect(res.status).toBe(413);
    const ok = await fetch(`${base}/api/tasks`);
    expect(ok.status).toBe(200);
  });

  it("body 超过 2 MiB → 413:原始 http 客户端必须真收到 413 + Connection: close(复审,Node 24)", async () => {
    const port = Number(new URL(base).port);
    // 4 MiB:远超上限,服务端在客户端仍在发送途中就要把 413 送出去。
    const res = await rawFull(port, {
      method: "POST",
      headers: JSON_HEADERS,
      totalBytes: 4 * 1024 * 1024,
    });
    expect(res.status).toBe(413);
    expect(res.headers["connection"]).toBe("close"); // 旧实现(超限即抛)发不出这个头,变异可感
    expect(res.body).toContain("2097152"); // 完整错误 JSON 送达(而非半截/重置)
    // 服务仍存活
    const ok = await fetch(`${base}/api/tasks`);
    expect(ok.status).toBe(200);
  });

  it("body 超过 2 MiB → 413:客户端收到响应头即停发,2s 内仍读到完整 JSON body(复审二轮)", async () => {
    const port = Number(new URL(base).port);
    const t0 = Date.now();
    const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const timer = setTimeout(() => { req.destroy(); reject(new Error("2s 内未读完 413 响应")); }, 2000);
      const req = httpRequest(
        { host: "127.0.0.1", port, method: "POST", path: "/api/tasks", headers: JSON_HEADERS }, // issue-guard: allow
        (r) => {
          const chunks: Buffer[] = [];
          r.on("data", (c: Buffer) => chunks.push(c));
          r.on("end", () => {
            clearTimeout(timer);
            resolve({ status: r.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") });
            req.destroy();
          });
        },
      );
      req.on("error", () => { /* 收到响应后主动销毁,忽略 */ });
      // 超限后既不 end 也不再写:模拟收到 413 即停发的客户端
      req.write(Buffer.alloc(2 * 1024 * 1024 + 64 * 1024, 0x78));
    });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body).error).toContain("2097152");
    expect(Date.now() - t0).toBeLessThan(2000);
    const ok = await fetch(`${base}/api/tasks`);
    expect(ok.status).toBe(200);
  });

  it("静态资源:仅 /assets/ 长 immutable 缓存,其余 no-cache(附带 P3)", async () => {
    const staticRoot = mkdtempSync(join(tmpdir(), "web-static-"));
    writeFileSync(join(staticRoot, "index.html"), "<!DOCTYPE html><html><body>427</body></html>");
    mkdirSync(join(staticRoot, "assets"));
    writeFileSync(join(staticRoot, "assets", "index-abc123.js"), "console.log(1);\n");
    writeFileSync(join(staticRoot, "favicon.ico"), Buffer.from([0, 1, 2]));
    const prevStatic = process.env.DOUYIN_REC_STATIC;
    process.env.DOUYIN_REC_STATIC = staticRoot;
    try {
      const asset = await fetch(`${base}/assets/index-abc123.js`);
      expect(asset.status).toBe(200);
      expect(asset.headers.get("cache-control")).toBe("public, max-age=31536000, immutable"); // issue-guard: allow
      const favicon = await fetch(`${base}/favicon.ico`);
      expect(favicon.status).toBe(200);
      expect(favicon.headers.get("cache-control")).toBe("no-cache");
    } finally {
      if (prevStatic === undefined) delete process.env.DOUYIN_REC_STATIC;
      else process.env.DOUYIN_REC_STATIC = prevStatic;
    }
  });
});
