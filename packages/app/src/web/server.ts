/**
 * app/web/server.ts — thin node:http layer over the api.ts handlers.
 *
 * Responsibilities (and ONLY these):
 *   - method + path routing via a small route table (with :id params),
 *   - JSON request-body parsing,
 *   - calling the matched api.ts handler and serialising { status, body },
 *   - serving the SPA (GET / → index.html),
 *   - clean error handling (404 unknown route, 400 bad json, 500 on throw).
 *
 * All business logic lives in api.ts; this file holds no task semantics. The
 * route-matching function is exported pure so it can be unit-tested without a
 * socket.
 */
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import {
  makeApi,
  type Api,
  type ApiResult,
  type ManagerLike,
  type LoginManagerLike,
} from "./api.js";
import { loadIndexHtml, loadStaticAsset } from "./static-html.js";
import { fetchAnchorName, resolveShortUrl } from "../anchor.js";
import type { TaskStore } from "../store.js";
import { MergeJobStore } from "../merge-jobs.js";
import type { EventCenter } from "../events.js";

/** A matched route: the api method to call + extracted :id (if any). */
export interface RouteMatch {
  /** Logical handler name. */
  name:
    | "listTasks"
    | "createTask"
    | "updateTask"
    | "getTask"
    | "getTaskLogs"
    | "deleteTask"
    | "startTask"
    | "stopTask"
    | "startLogin"
    | "pollLogin"
    | "getCookie"
    | "setCookie"
    | "clearCookie"
    | "getWebhook"
    | "setWebhook"
    | "testWebhook"
    | "getVersion"
    | "getMesioPath"
    | "setMesioPath"
    | "listRecordings"
    | "startMerge"
    | "getMerge"
    | "getEvents"
    | "listPlatforms"
    | "index";
  /** Path param when the route has /:id. */
  id?: number;
  /** Path param for string-keyed routes (e.g. login session id). */
  sid?: string;
  /** Whether the handler consumes a JSON request body. */
  needsBody?: boolean;
}

/**
 * PURE router. Maps (method, pathname) → RouteMatch or null (404). Exported for
 * unit testing of param extraction without spinning up a server.
 */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  // normalise trailing slash (but keep root "/")
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  if (method === "GET" && (p === "/" || p === "/index.html")) {
    return { name: "index" };
  }
  if (p === "/api/tasks") {
    if (method === "GET") return { name: "listTasks" };
    if (method === "POST") return { name: "createTask", needsBody: true };
    return null;
  }
  if (p === "/api/platforms" && method === "GET") return { name: "listPlatforms" };
  // 全局 cookie: GET / POST / DELETE /api/cookie
  if (p === "/api/cookie") {
    if (method === "GET") return { name: "getCookie" };
    if (method === "POST") return { name: "setCookie", needsBody: true };
    if (method === "DELETE") return { name: "clearCookie" };
    return null;
  }
  // QR-login: POST /api/login/qr (start) + GET /api/login/qr/:sid (poll)
  if (p === "/api/login/qr") {
    if (method === "POST") return { name: "startLogin" };
    return null;
  }
  const lm = /^\/api\/login\/qr\/([A-Za-z0-9_-]+)$/.exec(p);
  if (lm) {
    if (method === "GET") return { name: "pollLogin", sid: lm[1] };
    return null;
  }
  // 全局 webhook: POST /api/webhook/test(发测试通知)
  if (p === "/api/webhook/test") {
    if (method === "POST") return { name: "testWebhook", needsBody: true };
    return null;
  }
  // 全局 webhook: GET / POST /api/webhook
  if (p === "/api/webhook") {
    if (method === "GET") return { name: "getWebhook" };
    if (method === "POST") return { name: "setWebhook", needsBody: true };
    return null;
  }
  // 版本号: GET /api/version
  if (p === "/api/version" && method === "GET") return { name: "getVersion" };
  // mesio 路径设置: GET / POST /api/mesio-path
  if (p === "/api/mesio-path") {
    if (method === "GET") return { name: "getMesioPath" };
    if (method === "POST") return { name: "setMesioPath", needsBody: true };
    return null;
  }
  // 站内事件流: GET /api/events(?since=N 在 dispatch 解析 query)
  if (p === "/api/events") {
    if (method === "GET") return { name: "getEvents" };
    return null;
  }
  // 合成任务轮询: GET /api/merges/:jobId
  const mj = /^\/api\/merges\/([A-Za-z0-9_-]+)$/.exec(p);
  if (mj) {
    if (method === "GET") return { name: "getMerge", sid: mj[1] };
    return null;
  }
  // /api/tasks/:id  and  /api/tasks/:id/{start,stop,logs,recordings,merge}
  const m = /^\/api\/tasks\/(\d+)(\/start|\/stop|\/logs|\/recordings|\/merge)?$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    const sub = m[2];
    if (sub === "/start" && method === "POST") return { name: "startTask", id };
    if (sub === "/stop" && method === "POST") return { name: "stopTask", id };
    if (sub === "/logs" && method === "GET") return { name: "getTaskLogs", id };
    if (sub === "/recordings" && method === "GET") return { name: "listRecordings", id };
    if (sub === "/merge" && method === "POST") return { name: "startMerge", id, needsBody: true };
    if (!sub) {
      if (method === "GET") return { name: "getTask", id };
      if (method === "PATCH") return { name: "updateTask", id, needsBody: true };
      if (method === "DELETE") return { name: "deleteTask", id };
    }
    return null;
  }
  return null;
}

export interface WebServerDeps {
  store: TaskStore;
  /** A real TaskManager satisfies ManagerLike. */
  manager: ManagerLike;
  /** Optional QR-login manager; omit to disable /api/login endpoints. */
  login?: LoginManagerLike;
  /** Logger. Default console.log. */
  log?: (m: string) => void;
  /** 主播名解析器（默认 core/anchor.fetchAnchorName，用 getInfo）。测试可注入 no-op。 */
  resolveAnchor?: (room: string, cookies: string | null) => Promise<string | null>;
  /** 短链→web_rid 解析器（默认 core/anchor.resolveShortUrl）。测试可注入 no-op。 */
  resolveShortUrl?: (url: string) => Promise<string | null>;
  /** 站内事件中枢（合成完成/错误 + 开播/录完观察器 emit 到此 → 本地流 + webhook）。 */
  events?: EventCenter;
}

/** Read the whole request body and JSON.parse it (empty body → {}). */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
  });
  res.end(html);
}

function sendAsset(res: ServerResponse, body: Buffer, contentType: string): void {
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": body.byteLength,
    // Hashed Vite assets are immutable; index.html is served via sendHtml (no cache).
    "cache-control": "public, max-age=31536000, immutable",
  });
  res.end(body);
}

/** Dispatch a matched route to the api, parsing a JSON body if needed. */
async function dispatch(
  api: Api,
  match: RouteMatch,
  req: IncomingMessage,
): Promise<ApiResult> {
  switch (match.name) {
    case "listTasks":
      return api.listTasks();
    case "listPlatforms":
      return api.listPlatforms();
    case "createTask": {
      const body = (await readJson(req)) as Parameters<Api["createTask"]>[0];
      return api.createTask(body ?? {});
    }
    case "updateTask": {
      const body = (await readJson(req)) as Parameters<Api["updateTask"]>[1];
      return api.updateTask(match.id!, body ?? {});
    }
    case "getTask":
      return api.getTask(match.id!);
    case "getTaskLogs":
      return api.getTaskLogs(match.id!);
    case "deleteTask":
      return api.deleteTask(match.id!);
    case "startTask":
      return api.startTask(match.id!);
    case "stopTask":
      return api.stopTask(match.id!);
    case "startLogin":
      return api.startLogin();
    case "pollLogin":
      return api.pollLogin(match.sid!);
    case "getCookie":
      return api.getCookie();
    case "setCookie": {
      const body = (await readJson(req)) as { cookie?: string };
      return api.setCookie(body ?? {});
    }
    case "clearCookie":
      return api.clearCookie();
    case "getWebhook":
      return api.getWebhook();
    case "setWebhook": {
      const body = (await readJson(req)) as { webhook?: string };
      return api.setWebhook(body ?? {});
    }
    case "testWebhook": {
      const body = (await readJson(req)) as { content?: string };
      return api.testWebhook(body ?? {});
    }
    case "getVersion":
      return api.getVersion();
    case "getMesioPath":
      return api.getMesioPath();
    case "setMesioPath": {
      const body = (await readJson(req)) as { mesioPath?: string };
      return api.setMesioPath(body ?? {});
    }
    case "listRecordings":
      return api.listRecordings(match.id!);
    case "startMerge": {
      const body = (await readJson(req)) as { sessions?: string[] };
      return api.startMerge(match.id!, body ?? {});
    }
    case "getMerge":
      return api.getMerge(match.sid!);
    case "getEvents": {
      const since = Number(new URL(req.url ?? "/", "http://localhost").searchParams.get("since") ?? "0");
      return api.getEvents(since);
    }
    case "index":
      // handled by caller (html, not json)
      return { status: 200, body: null };
  }
}

/** Build (but don't listen on) the http server. Caller calls .listen(). */
export function createWebServer(deps: WebServerDeps): Server {
  const log = deps.log ?? ((m: string): void => console.log(m));
  const api = makeApi({
    store: deps.store,
    manager: deps.manager,
    login: deps.login,
    resolveAnchor: deps.resolveAnchor ?? fetchAnchorName,
    resolveShortUrl: deps.resolveShortUrl ?? resolveShortUrl,
    mergeJobs: (() => {
      const mj = new MergeJobStore(deps.store.db);
      const n = mj.recoverOrphans(); // 启动:清理上次重启腰斩的合成 job
      if (n > 0) log(`[web_server] 清理了 ${n} 个被重启中断的合成任务(半截 mp4 已删)`);
      return mj;
    })(),
    events: deps.events,
  });

  return createServer((req, res) => {
    void (async (): Promise<void> => {
      const method = req.method ?? "GET";
      const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      const match = matchRoute(method, pathname);

      if (!match) {
        // API routes never fall through to static / SPA — keep their 404 JSON.
        if (pathname.startsWith("/api/")) {
          sendJson(res, 404, { error: `未知路由: ${method} ${pathname}` });
          return;
        }
        // Static asset serving + SPA fallback for the React app (GET/HEAD only).
        if (method === "GET" || method === "HEAD") {
          const asset = loadStaticAsset(pathname);
          if (asset) {
            sendAsset(res, asset.body, asset.contentType);
            return;
          }
          // Unknown non-asset client route → serve index.html (SPA fallback).
          sendHtml(res, 200, loadIndexHtml());
          return;
        }
        sendJson(res, 404, { error: `未知路由: ${method} ${pathname}` });
        return;
      }
      if (match.name === "index") {
        sendHtml(res, 200, loadIndexHtml());
        return;
      }
      try {
        const result = await dispatch(api, match, req);
        sendJson(res, result.status, result.body);
      } catch (e) {
        if (e instanceof SyntaxError) {
          sendJson(res, 400, { error: `请求体不是合法 JSON: ${e.message}` });
          return;
        }
        log(`[web_server] 处理 ${method} ${pathname} 出错: ${String(e)}`);
        sendJson(res, 500, { error: "服务器内部错误" });
      }
    })();
  });
}
