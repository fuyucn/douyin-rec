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
import type { RoomPayload } from "@drec/core";
import { sseComment, sseFrame, type HubWatch } from "../hub-watch.js";
import { buildMaintenance } from "./api/maintenance.js";
import type { MaintenanceDeps } from "./api/maintenance.js";

/** T13 维护端点 handler(`buildMaintenance` 返回的两方法)。 */
type MaintenanceApi = ReturnType<typeof buildMaintenance>;

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
    | "refreshTaskAnchor"
    | "startTask"
    | "stopTask"
    | "drainTask"
    | "startLogin"
    | "pollLogin"
    | "listCookies"
    | "getCookie"
    | "setCookie"
    | "clearCookie"
    | "getBiliupStatus"
    | "getCookiePlatform"
    | "setCookiePlatform"
    | "clearCookiePlatform"
    | "getWebhook"
    | "setWebhook"
    | "testWebhook"
    | "getNotifSettings"
    | "setNotifSettings"
    | "getVersion"
    | "getMesioPath"
    | "setMesioPath"
    | "getDouyinApiMode"
    | "setDouyinApiMode"
    | "getTimezone"
    | "setTimezone"
    | "listRecordings"
    | "startMerge"
    | "getMerge"
    | "getEvents"
    | "listPlatforms"
    | "hubStatus"
    | "getHubResources"
    | "putHubResources"
    | "applyHubTasks"
    | "listRooms"
    | "getRoom"
    | "updateRoom"
    | "listHubRules"
    | "createHubRule"
    | "updateHubRule"
    | "deleteHubRule"
    | "reorderHubRules"
    | "listHubJobs"
    | "hubQueue"
    | "latestRuns"
    | "getHubJobLog"
    | "retryHubNode"
    | "stopHubJob"
    | "runHubJob"
    | "listWorkers"
    | "createWorker"
    | "updateWorker"
    | "deleteWorker"
    | "reorderWorkers"
    | "testWorker"
    | "workersStatus"
    | "previewOrphans"
    | "cleanupOrphans"
    | "hubStream"
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
  { name: "getBiliupStatus", methods: ["GET"], pattern: /^\/api\/biliup\/status$/ },
  { name: "listCookies", methods: ["GET"], pattern: /^\/api\/cookies$/ },
  { name: "getCookiePlatform", methods: ["GET"], pattern: /^\/api\/cookies\/([A-Za-z0-9_-]+)$/, param: "slug" },
  { name: "setCookiePlatform", methods: ["POST"], pattern: /^\/api\/cookies\/([A-Za-z0-9_-]+)$/, param: "slug", needsBody: true },
  { name: "clearCookiePlatform", methods: ["DELETE"], pattern: /^\/api\/cookies\/([A-Za-z0-9_-]+)$/, param: "slug" },
  { name: "startLogin", methods: ["POST"], pattern: /^\/api\/login\/qr$/, needsBody: true },
  { name: "pollLogin", methods: ["GET"], pattern: /^\/api\/login\/qr\/([A-Za-z0-9_-]+)$/, param: "sid" },
  { name: "testWebhook", methods: ["POST"], pattern: /^\/api\/webhook\/test$/, needsBody: true },
  { name: "getWebhook", methods: ["GET"], pattern: /^\/api\/webhook$/ },
  { name: "setWebhook", methods: ["POST"], pattern: /^\/api\/webhook$/, needsBody: true },
  { name: "getHubResources", methods: ["GET"], pattern: /^\/api\/hub\/resources$/ },
  { name: "putHubResources", methods: ["PUT"], pattern: /^\/api\/hub\/resources$/, needsBody: true },
  { name: "getNotifSettings", methods: ["GET"], pattern: /^\/api\/notif-settings$/ },
  { name: "setNotifSettings", methods: ["PUT"], pattern: /^\/api\/notif-settings$/, needsBody: true },
  { name: "getVersion", methods: ["GET"], pattern: /^\/api\/version$/ },
  { name: "getMesioPath", methods: ["GET"], pattern: /^\/api\/mesio-path$/ },
  { name: "setMesioPath", methods: ["POST"], pattern: /^\/api\/mesio-path$/, needsBody: true },
  { name: "getDouyinApiMode", methods: ["GET"], pattern: /^\/api\/douyin-api-mode$/ },
  { name: "setDouyinApiMode", methods: ["POST"], pattern: /^\/api\/douyin-api-mode$/, needsBody: true },
  { name: "getTimezone", methods: ["GET"], pattern: /^\/api\/timezone$/ },
  { name: "setTimezone", methods: ["POST"], pattern: /^\/api\/timezone$/, needsBody: true },
  { name: "getEvents", methods: ["GET"], pattern: /^\/api\/events$/ },
  { name: "previewOrphans", methods: ["GET"], pattern: /^\/api\/maintenance\/orphans$/ },
  { name: "cleanupOrphans", methods: ["POST"], pattern: /^\/api\/maintenance\/orphans$/, needsBody: true },
  { name: "hubStatus", methods: ["GET"], pattern: /^\/api\/hub\/status$/ },
  { name: "applyHubTasks", methods: ["POST"], pattern: /^\/api\/hub\/apply$/ },
  { name: "listRooms", methods: ["GET"], pattern: /^\/api\/rooms$/ },
  { name: "getRoom", methods: ["GET"], pattern: /^\/api\/rooms\/([^/]+)$/, param: "slug", decode: true },
  { name: "updateRoom", methods: ["PUT"], pattern: /^\/api\/rooms\/([^/]+)$/, param: "slug", decode: true, needsBody: true },
  { name: "listHubJobs", methods: ["GET"], pattern: /^\/api\/hub\/jobs$/ },
  { name: "hubQueue", methods: ["GET"], pattern: /^\/api\/hub\/queue$/ },
  // SSE(T4):常驻流,不进 dispatch(那会经 sendJson 序列化)。createServer 特判处理。
  { name: "hubStream", methods: ["GET"], pattern: /^\/api\/hub\/stream$/ },
  { name: "latestRuns", methods: ["GET"], pattern: /^\/api\/hub\/latest-runs$/ },
  { name: "runHubJob", methods: ["POST"], pattern: /^\/api\/hub\/jobs\/run$/, needsBody: true },
  { name: "getHubJobLog", methods: ["GET"], pattern: /^\/api\/hub\/jobs\/([^/]+)\/log$/, param: "sid", decode: true },
  { name: "retryHubNode", methods: ["POST"], pattern: /^\/api\/hub\/jobs\/([^/]+)\/retry-node$/, param: "sid", decode: true, needsBody: true },
  { name: "stopHubJob", methods: ["POST"], pattern: /^\/api\/hub\/jobs\/([^/]+)\/stop$/, param: "sid", decode: true },
  { name: "testWorker", methods: ["POST"], pattern: /^\/api\/hub\/workers\/test$/, needsBody: true },
  { name: "workersStatus", methods: ["GET"], pattern: /^\/api\/hub\/workers\/status$/ },
  { name: "listWorkers", methods: ["GET"], pattern: /^\/api\/hub\/workers$/ },
  { name: "createWorker", methods: ["POST"], pattern: /^\/api\/hub\/workers$/, needsBody: true },
  { name: "updateWorker", methods: ["PATCH"], pattern: /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/, param: "slug", needsBody: true },
  { name: "reorderWorkers", methods: ["POST"], pattern: /^\/api\/hub\/workers\/reorder$/, needsBody: true },
  { name: "deleteWorker", methods: ["DELETE"], pattern: /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/, param: "slug" },
  { name: "listHubRules", methods: ["GET"], pattern: /^\/api\/hub\/rules$/ },
  { name: "reorderHubRules", methods: ["POST"], pattern: /^\/api\/hub\/rules\/reorder$/, needsBody: true },
  { name: "createHubRule", methods: ["POST"], pattern: /^\/api\/hub\/rules$/, needsBody: true },
  { name: "updateHubRule", methods: ["PATCH"], pattern: /^\/api\/hub\/rules\/([A-Za-z0-9_.-]+)$/, param: "slug", needsBody: true },
  { name: "deleteHubRule", methods: ["DELETE"], pattern: /^\/api\/hub\/rules\/([A-Za-z0-9_.-]+)$/, param: "slug" },
  { name: "getMerge", methods: ["GET"], pattern: /^\/api\/merges\/([A-Za-z0-9_-]+)$/, param: "sid" },
  { name: "refreshTaskAnchor", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/refresh-anchor$/, param: "id" },
  { name: "startTask", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/start$/, param: "id" },
  { name: "stopTask", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/stop$/, param: "id" },
  { name: "drainTask", methods: ["POST"], pattern: /^\/api\/tasks\/(\d+)\/drain$/, param: "id" },
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
      let raw = m[1];
      if (route.decode) {
        // 非法 percent 编码(如 "%")不能让 URIError 冒泡出去 —— 调用方在 try 之外调 matchRoute,
        // 冒泡会变成 unhandled rejection 并**终止进程**(远端 DoS)。这里当作不匹配,server 侧回 400。
        try { raw = decodeURIComponent(m[1]); } catch { return null; }
      }
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
  /**
   * master **实际解析到的** hub 配置来源(T15)。
   *
   * 为什么不能只靠 hubConfigPath:用户可以用 `--hub-config <别的文件>` 或把配置存在 settings 表里,
   * 此时 rootHubConfig() 指向的文件**根本没被使用**。UI 若盲目写它,表现为「改了不生效」——
   * 这正是 T15 要消灭的那类假成功。省略 = 不提供(资源端点返回 400,不假装能改)。
   */
  hubConfigSource?: () => { json: string | undefined; path?: string; source: "arg-file" | "settings" | "root-file" | "inline" };
  /** biliup cookies.json 路径;省略回落应用默认路径。 */
  biliupCookiesPath?: string;
  /** 连接测试(CLI 注入,能 import orchestrator)。省略 → 端点返回「hub 未启用」。 */
  testWorker?: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<import("@drec/core").WorkerTestResult>;
  /** 批量存活探针(CLI 注入)。省略 → status 端点返回 []。 */
  probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  /** worker 录制状态快照(CLI 注入;不在请求路径上同步 SSH)。 */
  recordingWorkers?: (platform: string, roomSlug: string) => import("@drec/core").RecordingWorkerStatusDTO[];
  /** 节点侧 master 下发快照目录(见 ApiDeps.managedStateDir);serve 不论是否 hub 模式都注入。 */
  managedStateDir?: string;
  /** 立即触发一次 hub 任务同步(规则/worker 变更后调用,不用等周期 tick)。force=跳过节点骤减安全阀。 */
  requestSyncTasks?: (opts?: { force?: boolean }) => void;
  /** master 本机抑制名单(源任务切到远端录制→本机不实跑);透传给 web API。 */
  localSuppressedIds?: () => ReadonlySet<number>;
  /** 手动重跑单个 workflow 节点(CLI 注入)。省略 → 端点返回「hub 未启用」。 */
  retryNode?: (streamKey: string, node: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number }>;
  /** 停一场后处理(CLI 注入)。省略 → 端点返回「hub 未启用」。 */
  stopJob?: (streamKey: string) => Promise<{ ok: boolean; error?: string; code?: number }>;
  /** 立刻跑一场已有录像的后处理(CLI 注入)。省略 → 端点返回「hub 未启用」。 */
  runNow?: (opts: { streamKey: string; winnerWorker?: string; wait?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string }>;
  /** master 资源池快照(CLI 注入)。省略/hub 未就绪 → 队列页无排队位次/占用(全 0)。 */
  poolSnapshot?: () => import("@drec/core").HubPoolSnapshotDTO | undefined;
  /**
   * hub 台账变更监视(T4):`GET /api/hub/stream` 的 SSE 通道。
   * **注入 WebServerDeps 而非 ApiDeps** —— SSE 不是 ApiResult,不能进 dispatch/sendJson。
   * 省略 → 该路由回 503(功能显式不可用,而非静默 404/空流)。
   */
  hubWatch?: HubWatch;
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
export function isLoopbackAddr(addr: string | undefined): boolean {
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
  maintenance: MaintenanceApi,
): Promise<ApiResult> {
  switch (match.name) {
    case "previewOrphans":
      return maintenance.previewOrphans();
    case "cleanupOrphans": {
      const body = (await readJson(req)) as { confirm?: boolean };
      return maintenance.cleanupOrphans(body ?? {});
    }
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
    case "refreshTaskAnchor":
      return api.refreshTaskAnchor(match.id!);
    case "startTask":
      return api.startTask(match.id!);
    case "stopTask":
      return api.stopTask(match.id!, { internal: isLoopbackAddr(req.socket.remoteAddress) });
    case "drainTask":
      return api.drainTask(match.id!);
    case "startLogin": {
      const body = (await readJson(req)) as { platform?: string };
      return api.startLogin(body ?? {});
    }
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
    case "getBiliupStatus":
      return api.getBiliupStatus();
    case "listCookies":
      return api.listCookies();
    case "getCookiePlatform":
      return api.getCookie(match.slug!);
    case "setCookiePlatform": {
      const body = (await readJson(req)) as { cookie?: string };
      return api.setCookie(body ?? {}, match.slug!);
    }
    case "clearCookiePlatform":
      return api.clearCookie(match.slug!);
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
    case "getNotifSettings":
      return api.getNotifSettings();
    case "setNotifSettings": {
      const body = (await readJson(req)) as Parameters<Api["setNotifSettings"]>[0];
      return api.setNotifSettings(body ?? {});
    }
    case "getVersion":
      return api.getVersion();
    case "getMesioPath":
      return api.getMesioPath();
    case "setMesioPath": {
      const body = (await readJson(req)) as { mesioPath?: string };
      return api.setMesioPath(body ?? {});
    }
    case "getDouyinApiMode":
      return api.getDouyinApiMode();
    case "setDouyinApiMode": {
      const body = (await readJson(req)) as { mode?: string };
      return api.setDouyinApiMode(body ?? {});
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
    case "getHubResources":
      return api.getHubResources();
    case "putHubResources": {
      const body = (await readJson(req)) as Record<string, unknown>;
      return api.putHubResources(body ?? {});
    }
    case "listRooms":
      return api.listRooms();
    case "getRoom":
      return api.getRoom(match.slug!);
    case "updateRoom": {
      const body = (await readJson(req)) as RoomPayload;
      return api.updateRoom(match.slug!, body ?? {});
    }
    case "applyHubTasks": {
      // force 走 query(POST 无 body):`?force=1`。语义与 retry-node 的 force 保持一致。
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const force = q.get("force") === "1" || q.get("force") === "true";
      return api.applyHubTasks({ force });
    }
    case "listHubRules":
      return api.listHubRules();
    case "createHubRule": {
      const body = (await readJson(req)) as Parameters<Api["createHubRule"]>[0];
      return api.createHubRule(body ?? {});
    }
    case "reorderHubRules": {
      const body = (await readJson(req)) as Parameters<Api["reorderHubRules"]>[0];
      return api.reorderHubRules(body ?? {});
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
      // states 可重复或逗号分隔(原始串交 api 层做白名单校验)。
      const states = [...q.getAll("states"), ...(q.get("states") ?? "").split(",")]
        .map((st) => st.trim()).filter(Boolean);
      return api.listHubJobs({ room, limit, offset, states: states.length > 0 ? states : undefined });
    }
    case "getHubJobLog":
      return api.getHubJobLog(match.sid!);
    case "latestRuns":
      return api.latestRuns();
    case "hubQueue": {
      // phase/states/platform 可重复或逗号分隔;q 为子串。原始串交给 api 层做白名单校验。
      const q = new URL(req.url ?? "/", "http://localhost").searchParams;
      const multi = (key: string): string[] | undefined => {
        const all = [...q.getAll(key), ...(q.get(key) ?? "").split(",")].map((s) => s.trim()).filter(Boolean);
        return all.length > 0 ? all : undefined;
      };
      const search = q.get("q")?.trim() || undefined;
      const sortParam = q.get("sort");
      return api.hubQueue({
        phase: multi("phase"), states: multi("states"), platform: multi("platform"), q: search,
        sort: sortParam === "oldest" ? "oldest" : "newest",
      });
    }
    case "retryHubNode": {
      const body = (await readJson(req)) as { node?: string; force?: boolean };
      return api.retryHubNode(match.sid!, body ?? {});
    }
    case "stopHubJob":
      return api.stopHubJob(match.sid!);
    case "runHubJob": {
      const body = (await readJson(req)) as Parameters<Api["runHubJob"]>[0];
      return api.runHubJob(body ?? {});
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
    case "reorderWorkers": {
      const body = (await readJson(req)) as Parameters<Api["reorderWorkers"]>[0];
      return api.reorderWorkers(body ?? {});
    }
    case "deleteWorker":
      return api.deleteWorker(match.slug!);
    case "testWorker": {
      const body = (await readJson(req)) as Parameters<Api["testWorker"]>[0];
      return api.testWorker(body ?? {});
    }
    case "workersStatus":
      return api.workersStatus();
    case "hubStream":
      // handled by caller (SSE, not json) —— 到这里说明没注入 hubWatch。
      return { status: 503, body: { error: "hub 变更流不可用(未注入 hubWatch)" } };
    case "index":
      // handled by caller (html, not json)
      return { status: 200, body: null };
  }
}

/** SSE 心跳间隔(ms):15s。短到能及时发现代理掐连接,长到不产生可观测噪音。 */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * 接管一条 `GET /api/hub/stream` 连接:写 SSE 头 → 订阅 hubWatch → 周期心跳 → 关闭即退订。
 *
 * **退订必须挂在 `res.on("close")`**:EventSource 断开会触发 close;不退订就是监听器泄漏
 * (每个重连的浏览器标签泄漏一个回调,进程常驻内存无上限增长)。
 * `req.on("close")` 不够 —— 它在**请求体读完**时就触发(GET 无体,几乎立即),会导致订阅立刻被撤。
 */
function startHubStream(watch: HubWatch, res: ServerResponse, log: (m: string) => void): void {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    // nginx 反代下 X-Accel-Buffering:no 才能即时 flush,否则会被攒在代理缓冲里。
    "x-accel-buffering": "no",
  });
  // 首帧:让前端 EventSource 立刻 onopen,不必等第一次真实变更才知道连上了。
  res.write(sseFrame("open", { at: Date.now() }));
  const unsubscribe = watch.subscribe(() => {
    try {
      res.write(sseFrame("changed", { at: Date.now() }));
    } catch (e) {
      // 写失败(客户端已断但 close 尚未到达)只记录,不抛:抛出会变成 unhandled。
      log(`[web_server] SSE 写 changed 失败: ${String(e)}`);
    }
  });
  const hb = setInterval(() => {
    try {
      res.write(sseComment("hb"));
    } catch { /* 同上:断开竞态,交由 close 清理 */ }
  }, SSE_HEARTBEAT_MS);
  hb.unref?.();
  let closed = false;
  res.on("close", () => {
    if (closed) return;
    closed = true;
    clearInterval(hb);
    unsubscribe();
  });
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
    hubConfigSource: deps.hubConfigSource,
    biliupCookiesPath: deps.biliupCookiesPath,
    testWorker: deps.testWorker,
    probeAllWorkers: deps.probeAllWorkers,
    recordingWorkers: deps.recordingWorkers,
    managedStateDir: deps.managedStateDir,
    requestSyncTasks: deps.requestSyncTasks,
    localSuppressedIds: deps.localSuppressedIds,
    retryNode: deps.retryNode,
    stopJob: deps.stopJob,
    runNow: deps.runNow,
    poolSnapshot: deps.poolSnapshot,
    mergeJobs: (() => {
      const mj = new MergeJobStore(deps.store.db);
      const n = mj.recoverOrphans(); // 启动:清理上次重启腰斩的合成 job
      if (n > 0) log(`[web_server] 清理了 ${n} 个被重启中断的合成任务(半截 mp4 已删)`);
      return mj;
    })(),
    events: deps.events,
  });
  // T13 维护清理端点:自带活动路径推导(正在录制 / 非终态 hub job),无需 CLI 注入回调。
  const maintenanceDeps: MaintenanceDeps = {
    store: deps.store,
    manager: deps.manager,
    syncDbPath: deps.syncDbPath,
  };
  const maintenance = buildMaintenance(maintenanceDeps);

  return createServer((req, res) => {
    void (async (): Promise<void> => {
      const method = req.method ?? "GET";
      let url: URL;
      try {
        url = new URL(req.url ?? "/", "http://localhost");
        decodeURIComponent(url.pathname); // 非法 percent 编码 → 400,别让 URIError 崩掉进程
      } catch {
        sendJson(res, 400, { error: "URL 编码非法" });
        return;
      }
      const pathname = url.pathname;
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
      // SSE(T4):**必须**在 dispatch/sendJson 之前特判 —— dispatch 返回 ApiResult 会被 JSON 序列化。
      if (match.name === "hubStream") {
        if (!deps.hubWatch) {
          sendJson(res, 503, { error: "hub 变更流不可用(未注入 hubWatch)" });
          return;
        }
        startHubStream(deps.hubWatch, res, log);
        return;
      }
      try {
        const result = await dispatch(api, match, req, maintenance);
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
