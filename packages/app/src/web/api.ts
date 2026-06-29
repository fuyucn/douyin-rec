/**
 * app/web/api.ts — HTTP-FREE request handlers for the web UI.
 *
 * Each handler takes already-parsed input (ids, JSON bodies) and returns a
 * plain { status, body } pair. There is NO coupling to node:http here: no req,
 * no res, no streams. That makes every handler unit-testable with a real
 * in-memory TaskStore + a mock manager (see test/app/web-api.test.ts). The
 * thin http layer (server.ts) is the only place that knows about sockets.
 *
 * Dependencies are injected via makeApi({ store, manager }). The manager is
 * referenced through the narrow ManagerLike interface (only the methods the web
 * needs) so it can be mocked without dragging in the Spawner/subprocess world.
 */
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { groupSessions, mergeSessions } from "@drec/post-process";
import { resolveMesioBin } from "@drec/record-engine";
import { APP_VERSION } from "../version.js";
import type { RecordingSessionDTO, TaskPipelineConfig } from "@drec/core";
import { listPlatforms } from "@drec/core";
import type { EventCenter } from "../events.js";
import { resolveOutputDir } from "../paths.js";
import type { Task, TaskStore } from "../store.js";
import { resolveTaskCookies } from "../store.js";
import type { TaskRuntime } from "../task-manager.js";
import { inWindow, nowMinutesLocal } from "../scheduler.js";
import type { MergeJobStore } from "../merge-jobs.js";

/** Uniform handler result. status = HTTP status, body = JSON-serialisable. */
export interface ApiResult {
  status: number;
  body: unknown;
}

/** The slice of TaskManager the web layer depends on. Keeps tests mockable. */
export interface ManagerLike {
  runningIds(): number[];
  isRunning(id: number): boolean;
  start(id: number): boolean;
  stop(id: number): Promise<void>;
  /** Window-end / disable drain: stop looking for new streams, let current finish. */
  stopGraceful(id: number): Promise<void>;
  /** Live runtime (running + startedAt + elapsedMs) for the 详情 page. */
  getRuntime(id: number): TaskRuntime;
  /** 抓取到的主播名（未知为 null），供 list/detail 显示。 */
  getAnchorName(id: number): string | null;
  /** 是否真正在录视频（区分「录制中」vs running 但「等待开播中」）。 */
  isRecording(id: number): boolean;
  /** Per-task captured log lines (oldest → newest) for the 日志 console. */
  getLogs(id: number): string[];
}

/**
 * The slice of QrLoginManager the web layer depends on. Mirrors
 * login-manager.ts's start/poll so the http handlers stay mockable and never
 * import Playwright. Optional in ApiDeps — when absent (e.g. bundle without
 * playwright) the login endpoints return a clear 501.
 */
export interface LoginManagerLike {
  start(): Promise<{ sessionId: string; qrPng: string }>;
  poll(sessionId: string): Promise<{ state: string; cookie?: string }>;
}

export interface ApiDeps {
  store: TaskStore;
  manager: ManagerLike;
  /** Optional QR-login manager; omit to disable the /api/login endpoints. */
  login?: LoginManagerLike;
  /**
   * 解析房间主播名（getInfo().owner）。在创建/改房间号时**后台**调用，结果写回
   * store.setAnchorName → UI 立即显示主播名（无需开始录制）。省略=不抓（测试用）。
   */
  resolveAnchor?: (room: string, cookies: string | null) => Promise<string | null>;
  /**
   * 解析抖音短链(v.douyin.com/XXX) → web_rid。创建/改房间号后台调用,把任务 room 入库即转换成
   * `https://live.douyin.com/<web_rid>`(短链会过期,web_rid 稳定 + 显示干净)。省略=不转换。
   */
  resolveShortUrl?: (url: string) => Promise<string | null>;
  /** 会话合成的后台任务存储;省略=合成端点返回 501。 */
  mergeJobs?: MergeJobStore;
  /**
   * 站内事件中枢:合成完成/失败等事件 emit 到这里(本地流 + 按任务解析 webhook)。
   * 省略=不记录事件、不发通知,合成照常。
   */
  events?: EventCenter;
}

/**
 * 把名字净化成单个安全路径段——**与 @drec/record-engine 的 sanitizePathSegment
 * 同一规则**(录制子目录就是这么命名的;此处需还原同一目录名来定位录制文件)。
 */
function sanitizeSeg(name: string): string {
  return name
    .replace(/[/\\:*?"<>|]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}


/** A task enriched with its live running state for client display. */
export interface TaskView extends Task {
  running: boolean;
  /** 抓取到的主播名（运行时解析，未设 name 时 UI 用它显示），未知为 null。 */
  anchorName: string | null;
  /** true=真正在录视频；false 且 running=true → 进程在跑但「等待开播中」。 */
  recording: boolean;
}

/** A single-task view enriched with full live runtime (详情 page). */
export interface TaskDetailView extends TaskView {
  runtime: TaskRuntime;
}

/** Fields the create-task endpoint accepts from the client. */
export interface CreateTaskInput {
  room?: string;
  name?: string | null;
  quality?: string;
  engine?: string;
  danmu?: number | boolean;
  segmentSec?: number;
  cookies?: string | null;
  /** Per-task: pass the global cookie to the recorder? Default true. */
  useCookie?: boolean | number;
  outDir?: string | null;
  /** "HH:MM-HH:MM"; parsed into scheduleStart/scheduleEnd. */
  schedule?: string | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  /** 任务专属 Discord webhook;空/省略 = 回落全局。 */
  webhook?: string | null;
  /** 多节点 hub pipeline 配置(per-task);省略 = 不 hub。 */
  pipeline?: TaskPipelineConfig | null;
}

/**
 * Fields the update-task endpoint accepts. Every field is OPTIONAL: only the
 * keys actually present in the request body are applied (partial update).
 */
export interface UpdateTaskInput {
  room?: string;
  name?: string | null;
  quality?: string;
  engine?: string;
  danmu?: number | boolean;
  segmentSec?: number;
  cookies?: string | null;
  useCookie?: boolean | number;
  outDir?: string | null;
  /** "HH:MM-HH:MM"; parsed into scheduleStart/scheduleEnd. */
  schedule?: string | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  /** 任务专属 Discord webhook;空/省略 = 回落全局。 */
  webhook?: string | null;
  /** 多节点 hub pipeline 配置(per-task);省略 = 不改。 */
  pipeline?: TaskPipelineConfig | null;
}

function err(status: number, message: string): ApiResult {
  return { status, body: { error: message } };
}

/** Settings key for the GLOBAL Douyin account cookie (shared by all tasks). */
export const DEFAULT_COOKIES_KEY = "defaultCookies";

/** A cookie string has a usable login session if it carries sessionid[_ss]. */
function hasSessionCookie(cookie: string): boolean {
  return /(?:^|;\s*)sessionid(?:_ss)?=/.test(cookie);
}

/**
 * 抖音登录态过期时间（epoch ms）从 `sid_guard` 字段解析。
 * sid_guard = `<token>|<登录时间戳秒>|<有效期秒>|<过期GMT串>`（`|` 可能被 URL 编码为 %7C）。
 * 取 (登录时间戳 + 有效期) ；解析不出返回 null。
 */
export function parseCookieExpiry(cookie: string): number | null {
  const m = cookie.match(/(?:^|;\s*)sid_guard=([^;]+)/);
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split(/\||%7C/i);
  if (parts.length < 3) return null;
  const loginTs = Number(parts[1]);
  const maxAge = Number(parts[2]);
  if (!Number.isFinite(loginTs) || !Number.isFinite(maxAge) || loginTs <= 0) return null;
  return (loginTs + maxAge) * 1000;
}

/** Public status of the global cookie (never leaks the raw value). */
export interface CookieStatus {
  set: boolean;
  hasSession: boolean;
  length: number;
  /** 登录态过期时间（epoch ms），解析自 sid_guard；解析不出为 null。 */
  expiresAt: number | null;
}

/** Derive the privacy-safe status from a stored (possibly empty/null) value. */
function cookieStatus(value: string | null): CookieStatus {
  const v = (value ?? "").trim();
  return {
    set: v.length > 0,
    hasSession: v.length > 0 && hasSessionCookie(v),
    length: v.length,
    expiresAt: v.length > 0 ? parseCookieExpiry(v) : null,
  };
}

/** "HH:MM-HH:MM" → [start, end]; null on empty; throws on malformed. */
function parseSchedule(s: string): [string, string] {
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`schedule 格式应为 HH:MM-HH:MM，收到: ${s}`);
  return [m[1], m[2]];
}

/** Normalise a danmu value (number|boolean) to 0/1; defaults to 1. */
function toDanmu(v: number | boolean | undefined): number {
  if (v === undefined) return 1;
  if (typeof v === "boolean") return v ? 1 : 0;
  return v ? 1 : 0;
}

// engine 的校验与归一化已下沉到 store.addTask/updateTask(唯一真理 = platform.engines),
// api 直接透传原值即可,不再在此写死平台清单。弹幕只剩 danmu 开关(来源由平台 connectDanmu 决定)。

/** 归一化 webhook:trim 后空串 → null(=回落全局),否则原值。 */
function normWebhook(v: string | null | undefined): string | null {
  const s = (v ?? "").trim();
  return s.length > 0 ? s : null;
}

/** Coerce a useCookie value (number|boolean) to boolean; defaults to true. */
function toUseCookie(v: number | boolean | undefined): boolean {
  if (v === undefined) return true;
  return Boolean(v);
}

export interface Api {
  listTasks(): ApiResult;
  createTask(input: CreateTaskInput): ApiResult;
  updateTask(id: number, input: UpdateTaskInput): ApiResult;
  getTask(id: number): ApiResult;
  /** GET /api/tasks/:id/logs — captured recorder log lines. 404 if missing. */
  getTaskLogs(id: number): ApiResult;
  deleteTask(id: number): Promise<ApiResult>;
  startTask(id: number): ApiResult;
  stopTask(id: number): Promise<ApiResult>;
  /** POST /api/login/qr — start a QR-login → { sessionId, qrPng }. */
  startLogin(): Promise<ApiResult>;
  /** GET /api/login/qr/:sid — poll → { state, cookie? }. */
  pollLogin(sessionId: string): Promise<ApiResult>;
  /** GET /api/cookie — global cookie status (never the raw value). */
  getCookie(): ApiResult;
  /** POST /api/cookie { cookie } — set the global cookie (manual paste). */
  setCookie(input: { cookie?: string }): ApiResult;
  /** DELETE /api/cookie — clear the global cookie. */
  clearCookie(): ApiResult;
  /** GET /api/webhook — global Discord webhook (settings.discordWebhook). */
  getWebhook(): ApiResult;
  /** POST /api/webhook { webhook } — set/clear the global Discord webhook. */
  setWebhook(input: { webhook?: string }): ApiResult;
  /** POST /api/webhook/test { content } — 把 content 发到已保存的全局 webhook(走真实 Discord POST 路径)。 */
  testWebhook(input: { content?: string }): Promise<ApiResult>;
  /** GET /api/version — 应用版本号(0.0.0-{commit 后6位};About 页显示)。 */
  getVersion(): ApiResult;
  /** GET /api/mesio-path — mesio 二进制路径设置(settings.mesioPath)+ 留空时的实际默认(供 UI 占位符)。 */
  getMesioPath(): ApiResult;
  /** POST /api/mesio-path { mesioPath } — set/clear mesio 路径(空串=清除→回落 bin/mesio 默认)。 */
  setMesioPath(input: { mesioPath?: string }): ApiResult;
  /** GET /api/tasks/:id/recordings — list recorded sessions for the merge selector. */
  listRecordings(id: number): ApiResult;
  /** POST /api/tasks/:id/merge { sessions } — start a background merge job → 202 { job }. */
  startMerge(id: number, input: { sessions?: string[] }): ApiResult;
  /** GET /api/merges/:jobId — poll a merge job. */
  getMerge(jobId: string): ApiResult;
  /** GET /api/events?since=N — incremental station events feed (for web/tui toasts). */
  getEvents(since: number): ApiResult;
  /** GET /api/platforms — 已注册平台的配置(画质/录制器/弹幕/默认 + urlPattern),供前端按 URL 判平台、动态填表单。 */
  listPlatforms(): ApiResult;
}

/** Build the handler set bound to the injected store + manager. */
export function makeApi(deps: ApiDeps): Api {
  const { store, manager, login } = deps;

  // 后台抓主播名写回 store（创建/改房间号时）。fire-and-forget：不阻塞响应，
  // UI 下次轮询列表即可看到。失败静默（保留房间号显示）。
  const resolveAnchorBg = (taskId: number, room: string): void => {
    void (async () => {
      let r = room;
      // 短链入库即转换:v.douyin.com/XXX → https://live.douyin.com/<web_rid>(写回 DB)。
      if (deps.resolveShortUrl && /v\.douyin\.com\//.test(r)) {
        const webRid = await deps.resolveShortUrl(r).catch(() => null);
        if (webRid) {
          r = `https://live.douyin.com/${webRid}`;
          store.updateTask(taskId, { room: r });
        }
      }
      // 抓主播名(用转换后的 room)。
      if (deps.resolveAnchor) {
        const t = store.getTask(taskId);
        const cookies = t ? resolveTaskCookies(t, store.getDefaultCookies()) : null;
        const name = await deps.resolveAnchor(r, cookies).catch(() => null);
        if (name) store.setAnchorName(taskId, name);
      }
    })().catch(() => {});
  };

  // 显示用主播名：运行时(录制中 `[主播]` 日志解析) 优先，否则持久化的(创建时抓的)。
  const view = (t: Task): TaskView => ({
    ...t,
    running: manager.isRunning(t.id),
    anchorName: manager.getAnchorName(t.id) ?? t.anchorName,
    recording: manager.isRecording(t.id),
  });
  const detailView = (t: Task): TaskDetailView => ({
    ...view(t),
    runtime: manager.getRuntime(t.id),
  });

  // 任务录制目录 = {outDir}/{子目录}/,子目录与 buildSavePathRule 一致:
  // 有 name 用 sanitize(name),否则用主播名(biliLive owner)。无法确定子目录 → null。
  const recordingsDir = (t: Task): string | null => {
    const outDir = resolveOutputDir(t.outDir);
    const anchor = manager.getAnchorName(t.id) ?? t.anchorName ?? "";
    const sub = (t.name ? sanitizeSeg(t.name) : "") || (anchor ? sanitizeSeg(anchor) : "");
    return sub ? join(outDir, sub) : null;
  };

  return {
    listTasks(): ApiResult {
      return { status: 200, body: store.listTasks().map(view) };
    },

    listPlatforms(): ApiResult {
      // 平台配置投影(可序列化)。registerPlatform 顺序 = 第一个为默认(douyin),前端无命中时回落它。
      const platforms = listPlatforms().map((p) => ({
        id: p.id,
        urlPattern: p.urlPattern ?? null,
        qualities: p.qualities,
        engines: p.engines,
        defaultQuality: p.defaultQuality,
        defaultEngine: p.defaultEngine,
        // 平台是否有弹幕能力(connectDanmu 非空);前端据此显示/禁用弹幕开关。
        hasDanmu: typeof p.connectDanmu === "function",
      }));
      return { status: 200, body: { platforms } };
    },

    createTask(input: CreateTaskInput): ApiResult {
      const room = (input.room ?? "").trim();
      if (!room) return err(400, "room 必填");

      let scheduleStart = input.scheduleStart ?? null;
      let scheduleEnd = input.scheduleEnd ?? null;
      if (input.schedule && input.schedule.trim()) {
        try {
          [scheduleStart, scheduleEnd] = parseSchedule(input.schedule);
        } catch (e) {
          return err(400, (e as Error).message);
        }
      }

      const task = store.addTask({
        room,
        name: input.name ?? null,
        quality: input.quality ?? "origin",
        engine: input.engine, // store 按 platform.engines 校验/回落
        danmu: toDanmu(input.danmu),
        segmentSec: input.segmentSec ?? 1800,
        cookies: input.cookies ?? null,
        useCookie: toUseCookie(input.useCookie),
        outDir: input.outDir ?? null,
        scheduleStart,
        scheduleEnd,
        webhook: normWebhook(input.webhook),
        pipeline: input.pipeline ?? null,
      });
      // 创建即抓主播名（不等开始录制）；后台写回，UI 轮询即显示。
      resolveAnchorBg(task.id, task.room);
      return { status: 201, body: view(task) };
    },

    updateTask(id: number, input: UpdateTaskInput): ApiResult {
      if (!store.getTask(id)) return err(404, `未找到任务 id=${id}`);

      // Build a patch with ONLY the keys the client actually sent, so omitted
      // fields stay untouched (store.updateTask keys off `in patch`).
      const patch: Parameters<TaskStore["updateTask"]>[1] = {};

      if ("room" in input) {
        const room = (input.room ?? "").trim();
        if (!room) return err(400, "room 不能为空");
        patch.room = room;
      }
      if ("name" in input) patch.name = input.name ?? null;
      if ("quality" in input) patch.quality = input.quality;
      if ("engine" in input) patch.engine = input.engine; // store 按 platform 校验
      if ("danmu" in input) patch.danmu = toDanmu(input.danmu);
      if ("useCookie" in input) patch.useCookie = toUseCookie(input.useCookie);
      if ("segmentSec" in input) patch.segmentSec = input.segmentSec;
      if ("cookies" in input) patch.cookies = input.cookies ?? null;
      if ("outDir" in input) patch.outDir = input.outDir ?? null;
      if ("webhook" in input) patch.webhook = normWebhook(input.webhook);
      if ("pipeline" in input) patch.pipeline = input.pipeline ?? null;

      // schedule "HH:MM-HH:MM" wins over explicit scheduleStart/End if present.
      if (input.schedule !== undefined) {
        if (input.schedule && input.schedule.trim()) {
          try {
            const [s, e] = parseSchedule(input.schedule);
            patch.scheduleStart = s;
            patch.scheduleEnd = e;
          } catch (e) {
            return err(400, (e as Error).message);
          }
        } else {
          // empty schedule string → clear both
          patch.scheduleStart = null;
          patch.scheduleEnd = null;
        }
      } else {
        if ("scheduleStart" in input) patch.scheduleStart = input.scheduleStart ?? null;
        if ("scheduleEnd" in input) patch.scheduleEnd = input.scheduleEnd ?? null;
      }

      const updated = store.updateTask(id, patch);
      if (!updated) return err(404, `未找到任务 id=${id}`);
      // 改了房间号 → 主播可能变了，清旧名并重新抓。
      if ("room" in patch && patch.room) {
        store.setAnchorName(id, null);
        resolveAnchorBg(id, patch.room);
      }
      return { status: 200, body: view(updated) };
    },

    getTask(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      return { status: 200, body: detailView(t) };
    },

    getTaskLogs(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      return { status: 200, body: { lines: manager.getLogs(id) } };
    },

    /** 删除前必须先停止：已启用或正在运行的任务拒绝删除（避免误删活动录制）。 */
    async deleteTask(id: number): Promise<ApiResult> {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      if (t.enabled || manager.isRunning(id)) {
        return err(409, `任务 id=${id} 仍启用或运行中，请先停止再删除`);
      }
      store.removeTask(id);
      return { status: 200, body: { ok: true, id } };
    },

    /**
     * 「启动」= 置 enabled=true（用户意图）。daemon 会按 schedule 接管；为即时反馈，
     * 若当前已在窗口内（或无窗口）且未运行，这里直接拉起，不等下一个 tick。
     */
    startTask(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      store.setEnabled(id, true);
      const eligible = inWindow(nowMinutesLocal(new Date()), t.scheduleStart, t.scheduleEnd);
      if (eligible && !manager.isRunning(id)) manager.start(id);
      return { status: 200, body: view(store.getTask(id)!) };
    },

    /**
     * 「停止」= 置 enabled=false（daemon 不再拉起）+ 立即硬停（SIGTERM→SIGKILL）。
     * 用户主动停就是要立刻停。优雅排空（不腰斩）只用于自动场景：窗口结束由 daemon 触发。
     */
    async stopTask(id: number): Promise<ApiResult> {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      store.setEnabled(id, false);
      if (manager.isRunning(id)) await manager.stop(id);
      return { status: 200, body: view(store.getTask(id)!) };
    },

    async startLogin(): Promise<ApiResult> {
      if (!login) {
        return err(501, "扫码登录不可用：未安装 playwright（请用手动 cookie）");
      }
      try {
        const { sessionId, qrPng } = await login.start();
        return { status: 200, body: { sessionId, qrPng } };
      } catch (e) {
        return err(500, `启动扫码登录失败: ${(e as Error).message}`);
      }
    },

    async pollLogin(sessionId: string): Promise<ApiResult> {
      if (!login) {
        return err(501, "扫码登录不可用：未安装 playwright（请用手动 cookie）");
      }
      const r = await login.poll(sessionId);
      if (r.state === "unknown") return err(404, `未找到登录会话: ${sessionId}`);
      // The manager already persisted the cookie to settings.defaultCookies on
      // confirmed; we do NOT surface the raw cookie here (privacy). The UI just
      // refreshes GET /api/cookie to see the new status.
      return { status: 200, body: { state: r.state } };
    },

    getCookie(): ApiResult {
      return { status: 200, body: cookieStatus(store.getSetting(DEFAULT_COOKIES_KEY)) };
    },

    setCookie(input: { cookie?: string }): ApiResult {
      const cookie = (input.cookie ?? "").trim();
      if (!cookie) return err(400, "cookie 不能为空");
      store.setSetting(DEFAULT_COOKIES_KEY, cookie);
      return { status: 200, body: cookieStatus(cookie) };
    },

    clearCookie(): ApiResult {
      // Empty string is treated as unset by cookieStatus / the run-time fallback.
      store.setSetting(DEFAULT_COOKIES_KEY, "");
      return { status: 200, body: cookieStatus("") };
    },

    getWebhook(): ApiResult {
      return { status: 200, body: { webhook: store.getSetting("discordWebhook") ?? "" } };
    },

    setWebhook(input: { webhook?: string }): ApiResult {
      // 全局 Discord webhook(任务未自带时回落)。空串=清除。注:CLI --discord-webhook / env
      // DISCORD_WEBHOOK 若设置会优先于此(见 cli-task globalHook)。
      store.setSetting("discordWebhook", (input.webhook ?? "").trim());
      return { status: 200, body: { webhook: store.getSetting("discordWebhook") ?? "" } };
    },

    getVersion(): ApiResult {
      return { status: 200, body: { version: APP_VERSION } };
    },

    getMesioPath(): ApiResult {
      // mesioPath = 用户显式覆盖(空=用默认)。default = 留空时引擎实际会用的路径(本机解析:
      // 继承的 MESIO_PATH env > <cwd>/bin/mesio > 裸 mesio),供 UI 占位符提示。
      return {
        status: 200,
        body: { mesioPath: store.getSetting("mesioPath") ?? "", default: resolveMesioBin() },
      };
    },

    setMesioPath(input: { mesioPath?: string }): ApiResult {
      // 空串=清除 → spawn 时不注入 MESIO_PATH → 引擎回落 bin/mesio 默认。改设置下次起录即生效(无需重启)。
      store.setSetting("mesioPath", (input.mesioPath ?? "").trim());
      return {
        status: 200,
        body: { mesioPath: store.getSetting("mesioPath") ?? "", default: resolveMesioBin() },
      };
    },

    async testWebhook(input: { content?: string }): Promise<ApiResult> {
      // 测试已保存的全局 webhook:用与 DiscordNotifier 相同的 { content } 负载直接 POST。
      const hook = (store.getSetting("discordWebhook") ?? "").trim();
      if (!hook) return err(400, "尚未保存全局 webhook");
      const content = (input.content ?? "").trim() || "douyin-rec test";
      try {
        const r = await fetch(hook, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ content }),
          signal: AbortSignal.timeout(5000),
        });
        if (!r.ok) return err(502, `Discord 返回 HTTP ${r.status}`);
        return { status: 200, body: { ok: true, code: r.status } };
      } catch (e) {
        return err(502, `发送失败:${(e as Error).message}`);
      }
    },

    listRecordings(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      const dir = recordingsDir(t);
      if (!dir || !existsSync(dir)) return { status: 200, body: { dir, sessions: [] } };
      const files = readdirSync(dir).map((f) => join(dir, f));
      const groups = groupSessions(files);
      const sessions: RecordingSessionDTO[] = Object.entries(groups)
        .filter(([, g]) => g.ts.length > 0) // 只列有视频的会话
        .map(([base, g]) => ({
          base,
          segments: g.ts.length,
          hasXml: g.xml !== null || g.segmentXmls.length > 0,
        }))
        .sort((a, b) => a.base.localeCompare(b.base)); // base 内嵌时间戳 → 字典序=时间序
      return { status: 200, body: { dir, sessions } };
    },

    startMerge(id: number, input: { sessions?: string[] }): ApiResult {
      if (!deps.mergeJobs) return err(501, "合成功能未启用");
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      const dir = recordingsDir(t);
      if (!dir || !existsSync(dir)) return err(404, "该任务暂无录制目录");
      const bases = input.sessions ?? [];
      if (bases.length === 0) return err(400, "请至少选择一个会话");

      const files = readdirSync(dir).map((f) => join(dir, f));
      const groups = groupSessions(files);
      for (const b of bases) if (!groups[b]) return err(400, `未知会话: ${b}`);
      // 入参顺序 = 时间序;每会话取分段 ts + 会话级 xml(无则不合并弹幕)。
      const inputs = bases.map((b) => ({
        tsFiles: groups[b].ts,
        xmlPath: groups[b].xml ?? undefined,
      }));
      const outBase = `${bases[0]}_merged`;
      const outMp4 = join(dir, `${outBase}.mp4`);
      const outXml = join(dir, `${outBase}.xml`);
      const allXml = bases.every((b) => groups[b].xml);

      const job = deps.mergeJobs.create(id, bases, outMp4, allXml ? outXml : undefined);
      void (async (): Promise<void> => {
        try {
          const r = await mergeSessions(inputs, outMp4, allXml ? outXml : undefined);
          deps.mergeJobs!.finish(job.id, { mp4: r.mp4, xml: r.xml });
          // 站内事件 + webhook(EventCenter 按任务解析 webhook)。
          deps.events?.emit(id, { kind: "mergeDone", file: r.mp4 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          deps.mergeJobs!.fail(job.id, msg);
          deps.events?.emit(id, { kind: "error", stage: "merge", message: msg });
        }
      })();
      return { status: 202, body: job };
    },

    getMerge(jobId: string): ApiResult {
      if (!deps.mergeJobs) return err(501, "合成功能未启用");
      const v = deps.mergeJobs.view(jobId);
      if (!v) return err(404, `未找到合成任务: ${jobId}`);
      return { status: 200, body: v };
    },

    getEvents(since: number): ApiResult {
      const cursor = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
      return { status: 200, body: deps.events ? deps.events.since(cursor) : { events: [], cursor: 0 } };
    },
  };
}
