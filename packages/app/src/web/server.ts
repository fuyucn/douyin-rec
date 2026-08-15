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
import type { EventCenter } from "@drec/observability";

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
    | "getTimezone"
    | "setTimezone"
    | "listRecordings"
    | "startMerge"
    | "getMerge"
    | "getEvents"
    | "listPlatforms"
    | "hubStatus"
    | "listHubRules"
    | "createHubRule"
    | "updateHubRule"
    | "deleteHubRule"
    | "listHubJobs"
    | "getHubJobLog"
    | "retryHubNode"
    | "listWorkers"
    | "createWorker"
    | "updateWorker"
    | "deleteWorker"
    | "testWorker"
    | "workersStatus"
    | "index";
  /** Path param when the route has /:id. */
  id?: number;
  /** Path param for string-keyed routes (e.g. login session id). */
  sid?: string;
  /** Path param for roomSlug-keyed routes (hub rules). */
  slug?: string;
  /** Whether the handler consumes a JSON request body. */
  needsBody?: boolean;
}

interface RouteEntry {
  name: RouteMatch["name"];
  methods: readonly string[];
  pattern: RegExp;
  param?: "id" | "sid" | "slug";
  decode?: boolean;
  needsBody?: boolean;
}

/**
 * 路由表按声明顺序匹配。param 取第 1 个捕获组;decode=true 的 key 形路由
 * (hub job streamKey)客户端会 encodeURIComponent,匹配后统一解一次。
 * test/status 子路径放在 :id 通配之前,避免被当 worker id。
 */
const ROUTES: readonly RouteEntry[] = [
  { name: "index", methods: ["GET"], pattern: /^\/$|^\/index\.html$/ },
  { name: "listTasks", methods: ["GET"], pattern: /^\/api\/tasks$/ },
  { name: "createTask", methods: ["POST"], pattern: /^\/api\/tasks$/, needsBody: true },
  { name: "listPlatforms", methods: ["GET"], pattern: /^\/api\/platforms$/ },
  { name: "getCookie", methods: ["GET"], pattern: /^\/api\/cookie$/ },
  { name: "setCookie", methods: ["POST"], pattern: /^\/api\/cookie$/, needsBody: true },
  { name: "clearCookie", methods: ["DELETE"], pattern: /^\/api\/cookie$/ },
  { name: "startLogin", methods: ["POST"], pattern: /^\/api\/login\/qr$/ },
  { name: "pollLogin", methods: ["GET"], pattern: /^\/api\/login\/qr\/([A-Za-z0-9_-]+)$/, param: "sid" },
  { name: "testWebhook", methods: ["POST"], pattern: /^\/api\/webhook\/test$/, needsBody: true },
  { name: "getWebhook", methods: ["GET"], pattern: /^\/api\/webhook$/ },
  { name: "setWebhook", methods: ["POST"], pattern: /^\/api\/webhook$/, needsBody: true },
  { name: "getVersion", methods: ["GET"], pattern: /^\/api\/version$/ },
  { name: "getMesioPath", methods: ["GET"], pattern: /^\/api\/mesio-path$/ },
  { name: "setMesioPath", methods: ["POST"], pattern: /^\/api\/mesio-path$/, needsBody: true },
  { name: "getTimezone", methods: ["GET"], pattern: /^\/api\/timezone$/ },
  { name: "setTimezone", methods: ["POST"], pattern: /^\/api\/timezone$/, needsBody: true },
  { name: "getEvents", methods: ["GET"], pattern: /^\/api\/events$/ },
  { name: "hubStatus", methods: ["GET"], pattern: /^\/api\/hub\/status$/ },
  { name: "listHubJobs", methods: ["GET"], pattern: /^\/api\/hub\/jobs$/ },
  { name: "getHubJobLog", methods: ["GET"], pattern: /^\/api\/hub\/jobs\/([^/]+)\/log$/, param: "sid", decode: true },
  { name: "retryHubNode", methods: ["POST"], pattern: /^\/api\/hub\/jobs\/([^/]+)\/retry-node$/, param: "sid", decode: true, needsBody: true },
  { name: "testWorker", methods: ["POST"], pattern: /^\/api\/hub\/workers\/test$/, needsBody: true },
  { name: "workersStatus", methods: ["GET"], pattern: /^\/api\/hub\/workers\/status$/ },
  { name: "listWorkers", methods: ["GET"], pattern: /^\/api\/hub\/workers$/ },
  { name: "createWorker", methods: ["POST"], pattern: /^\/api\/hub\/workers$/, needsBody: true },
  { name: "updateWorker", methods: ["PATCH"], pattern: /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/, param: "slug", needsBody: true },
  { name: "deleteWorker", methods: ["DELETE"], pattern: /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/, param: "slug" },
  { name: "listHubRules", methods: ["GET"], pattern: /^\/api\/hub\/rules$/ },
  { name: "createHubRule", methods: ["POST"], pattern: /^\/api\/hub\/rules$/, needsBody: true },
  { name: "updateHubRule", methods: ["PATCH"], pattern: /^\/api\/hub\/rules\/([A-Za-z0-9_.-]+)$/, param: "slug", needsBody: true },
  { name: "deleteHubRule", methods: ["DELETE"], pattern: /^\/api\/hub\/rules\/([A-Za-z0-9_.-]+)$/, param: "slug" },
  { name: "getMerge", methods: ["GET"], pattern: /^\/api\/merges\/([A-Za-z0-9_-]+)$/, param: "sid" },
  { name: "startTask", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/start$/, param: "id" },
  { name: "stopTask", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/stop$/, param: "id" },
  { name: "getTaskLogs", methods: ["GET"], pattern: /^\/api\/tasks\/(\d+)\/logs$/, param: "id" },
  { name: "listRecordings", methods: ["GET"], pattern: /^\/api\/tasks\/(\d+)\/recordings$/, param: "id" },
  { name: "startMerge", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/merge$/, param: "id", needsBody: true },
  { name: "getTask", methods: ["GET"], pattern: /^\/api\/tasks\/(\d+)$/, param: "id" },
  { name: "updateTask", methods: ["PATCH"], pattern: /^\/api\/tasks\/(\d+)$/, param: "id", needsBody: true },
  { name: "deleteTask", methods: ["DELETE"], pattern: /^\/api\/tasks\/(\d+)$/, param: "id" },
];

/**
 * PURE router. Maps (method, pathname) → RouteMatch or null (404). Exported for
 * unit testing of param extraction without spinning up a server.
 */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  // normalise trailing slash (but keep root "/")
  const p = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;

  for (const route of ROUTES) {
    const m = route.pattern.exec(p);
    if (!m || !route.methods.includes(method)) continue;
    const match: RouteMatch = { name: route.name };
    if (route.needsBody) match.needsBody = true;
    if (route.param && m[1] !== undefined) {
      const raw = route.decode ? decodeURIComponent(m[1]) : m[1];
      if (route.param === "id") match.id = Number(raw);
      else if (route.param === "sid") match.sid = raw;
      else match.slug = raw;
    }
    return match;
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
  /** hub 任务配置目录(<root>/config/hub);省略=回落 rootHubDir()。测试注入 temp 目录。 */
  hubDir?: string;
  /** 本节点是否启用 hub(master);slave=false。前端据此显示/隐藏 Hub 页。 */
  hubEnabled?: boolean;
  /** hub 台账 sqlite(<db>-sync.db)路径;省略=hub 任务端点返回空列表。 */
  syncDbPath?: string;
  /** hub.config.json 路径;省略回落 rootHubConfig()。 */
  hubConfigPath?: string;
  /** 连接测试(CLI 注入,能 import orchestrator)。省略 → 端点返回「hub 未启用」。 */
  testWorker?: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<import("@drec/core").WorkerTestResult>;
  /** 批量存活探针(CLI 注入)。省略 → status 端点返回 []。 */
  probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  /** 立即触发一次 hub 任务同步(规则/worker 变更后调用,不用等周期 tick)。 */
  requestSyncTasks?: () => void;
  /** 手动重跑单个 workflow 节点(CLI 注入)。省略 → 端点返回「hub 未启用」。 */
  retryNode?: (streamKey: string, node: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number }>;
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

/** 本机回环调用判定:内部自动化(_apply-tasks)停受管任务的唯一可信通道。 */
function isLoopback(addr: string | undefined): boolean {
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
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
      return api.stopTask(match.id!, { internal: isLoopback(req.socket.remoteAddress) });
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
    case "getTimezone":
      return api.getTimezone();
    case "setTimezone": {
      const body = (await readJson(req)) as { timezone?: string };
      return api.setTimezone(body ?? {});
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
    case "hubStatus":
      return api.hubStatus();
    case "listHubRules":
      return api.listHubRules();
    case "createHubRule": {
      const body = (await readJson(req)) as Parameters<Api["createHubRule"]>[0];
      return api.createHubRule(body ?? {});
    }
    case "updateHubRule": {
      const body = (await readJson(req)) as Parameters<Api["updateHubRule"]>[1];
      return api.updateHubRule(match.slug!, body ?? {});
    }
    case "deleteHubRule":
      return api.deleteHubRule(match.slug!);
    case "listHubJobs": {
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const room = q.get("room") ?? undefined;
      const limit = q.get("limit") ? Number(q.get("limit")) : undefined;
      const offset = q.get("offset") ? Number(q.get("offset")) : undefined;
      return api.listHubJobs({ room, limit, offset });
    }
    case "getHubJobLog":
      return api.getHubJobLog(match.sid!);
    case "retryHubNode": {
      const body = (await readJson(req)) as { node?: string; force?: boolean };
      return api.retryHubNode(match.sid!, body ?? {});
    }
    case "listWorkers":
      return api.listWorkers();
    case "createWorker": {
      const body = (await readJson(req)) as Parameters<Api["createWorker"]>[0];
      return api.createWorker(body ?? {});
    }
    case "updateWorker": {
      const body = (await readJson(req)) as Parameters<Api["updateWorker"]>[1];
      return api.updateWorker(match.slug!, body ?? {});
    }
    case "deleteWorker":
      return api.deleteWorker(match.slug!);
    case "testWorker": {
      const body = (await readJson(req)) as Parameters<Api["testWorker"]>[0];
      return api.testWorker(body ?? {});
    }
    case "workersStatus":
      return api.workersStatus();
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
    hubDir: deps.hubDir,
    hubEnabled: deps.hubEnabled,
    syncDbPath: deps.syncDbPath,
    hubConfigPath: deps.hubConfigPath,
    testWorker: deps.testWorker,
    probeAllWorkers: deps.probeAllWorkers,
    requestSyncTasks: deps.requestSyncTasks,
    retryNode: deps.retryNode,
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
