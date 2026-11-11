/**
 * issue #600 / #419 P1: remote Web access must require the shared secret.
 * Pure helpers + a live server (real HTTP + cookie/Bearer/header matrix).
 */
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { TaskStore } from "../../packages/app/src/store.js";
import { createWebServer, hostAllowed } from "../../packages/app/src/web/server.js";
import {
  isLoopbackHost,
  resolveWebAuth,
  sessionCookieHeader,
  tokenMatches,
  webTokenPath,
  type WebAuthConfig,
} from "../../packages/app/src/web/auth.js";
import type { ManagerLike } from "../../packages/app/src/web/api.js";

const TOKEN = "test-web-access-secret";
const manager = {
  isRunning: (): boolean => false,
  getAnchorName: (): undefined => undefined,
} as unknown as ManagerLike;

const opened: Server[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  for (const s of opened.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.DREC_ALLOWED_HOSTS;
});

async function start(auth?: WebAuthConfig, allowedHosts?: readonly string[]) {
  const store = new TaskStore(":memory:");
  const server = createWebServer({
    store,
    manager,
    auth,
    allowedHosts,
    log: () => {},
    resolveAnchor: async () => null,
    resolveShortUrl: async () => null,
  });
  await new Promise<void>((r) => server.listen(0, "localhost", r));
  opened.push(server);
  return { base: `http://localhost:${(server.address() as AddressInfo).port}`, store };
}

describe("resolveWebAuth", () => {
  it("回环 + 无密钥 → 不启用鉴权（本机信任，保持旧行为）", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("all")).toBe(false);
    const root = mkdtempSync(join(tmpdir(), "web-auth-"));
    tempDirs.push(root);
    expect(resolveWebAuth({ host: "localhost", root, env: {} })).toBeUndefined();
  });

  it("非回环 + 无密钥 → 首启生成 0600 文件；第二次读同一密钥", () => {
    const root = mkdtempSync(join(tmpdir(), "web-auth-"));
    tempDirs.push(root);
    const a = resolveWebAuth({ host: "all", root, env: {} });
    expect(a?.token.length).toBeGreaterThan(20);
    const path = webTokenPath(root);
    expect(statSync(path).mode & 0o077).toBe(0);
    expect(readFileSync(path, "utf-8").trim()).toBe(a?.token);
    expect(resolveWebAuth({ host: "all", root, env: {} })?.token).toBe(a?.token);
  });

  it("环境变量优先于文件", () => {
    const root = mkdtempSync(join(tmpdir(), "web-auth-"));
    tempDirs.push(root);
    const a = resolveWebAuth({ host: "all", root, env: { DREC_WEB_TOKEN: "from-env" } });
    expect(a?.token).toBe("from-env");
  });

  it("密钥比较定长且空值一律拒绝", () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
    expect(tokenMatches(`${TOKEN}x`, TOKEN)).toBe(false);
    expect(tokenMatches("", TOKEN)).toBe(false);
    expect(tokenMatches(TOKEN, "")).toBe(false);
  });

  it("会话票据只含摘要，不写原文", () => {
    const cookie = sessionCookieHeader({ token: TOKEN, cookieName: "drec_session", maxAgeSec: 60 }, false);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain(TOKEN);
  });
});

describe("hostAllowed (#600: 不再放行任意 IP 字面量)", () => {
  it("回环/单标签/.local/.ts.net 保持放行", () => {
    expect(hostAllowed("localhost:7860")).toBe(true);
    expect(hostAllowed("master")).toBe(true);
    expect(hostAllowed("box.local")).toBe(true);
    expect(hostAllowed("box.tailnet.ts.net")).toBe(true);
  });

  it("局域网 IP 默认拒绝；显式允许后放行", () => {
    expect(hostAllowed("192.168.1.10:7860")).toBe(false); // issue-guard: allow
    expect(hostAllowed("192.168.1.10:7860", ["192.168.1.10"])).toBe(true); // issue-guard: allow
    process.env.DREC_ALLOWED_HOSTS = "192.168.1.10"; // issue-guard: allow
    expect(hostAllowed("192.168.1.10:7860")).toBe(true); // issue-guard: allow
  });

  it("自定义域名仍只认允许列表", () => {
    expect(hostAllowed("rec.example.com")).toBe(false);
    expect(hostAllowed("rec.example.com", ["rec.example.com"])).toBe(true);
  });
});

describe("createWebServer + auth (live)", () => {
  it("鉴权开启：无密钥 401；版本/会话端点公开", async () => {
    const auth: WebAuthConfig = { token: TOKEN, cookieName: "drec_session", maxAgeSec: 3600 };
    const { base } = await start(auth);
    expect((await fetch(`${base}/api/tasks`)).status).toBe(401);
    expect((await fetch(`${base}/api/version`)).status).toBe(200);
    expect((await fetch(`${base}/api/session`)).status).toBe(200);
    expect((await fetch(`${base}/`)).status).toBe(200); // 静态资源/登录页公开
  });

  it("错误密钥 401；正确密钥种会话票据；cookie 可继续访问", async () => {
    const auth: WebAuthConfig = { token: TOKEN, cookieName: "drec_session", maxAgeSec: 3600 };
    const { base } = await start(auth);
    const bad = await fetch(`${base}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "wrong" }),
    });
    expect(bad.status).toBe(401);

    const ok = await fetch(`${base}/api/session`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: TOKEN }),
    });
    expect(ok.status).toBe(200);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("HttpOnly");
    const cookie = setCookie.split(";")[0]!;
    expect((await fetch(`${base}/api/tasks`, { headers: { cookie } })).status).toBe(200);
  });

  it("Bearer 与自定义请求头都能过；退出会清票据", async () => {
    const auth: WebAuthConfig = { token: TOKEN, cookieName: "drec_session", maxAgeSec: 3600 };
    const { base } = await start(auth);
    expect((await fetch(`${base}/api/tasks`, { headers: { authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
    expect((await fetch(`${base}/api/tasks`, { headers: { "x-drec-token": TOKEN } })).status).toBe(200);
    const out = await fetch(`${base}/api/session`, { method: "DELETE" });
    expect(out.status).toBe(200);
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("未开启鉴权：GET /api/tasks 仍 200（旧行为）", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/tasks`)).status).toBe(200);
    const session = (await (await fetch(`${base}/api/session`)).json()) as { authRequired: boolean };
    expect(session.authRequired).toBe(false);
  });
});
