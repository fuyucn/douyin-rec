/**
 * api/client.ts — typed fetch wrappers for the douyin-rec REST API.
 *
 * Mirrors the EXACT contract served by src/app/web/api.ts + server.ts. No
 * behaviour is duplicated here; this is purely the client-side surface.
 */

// API 契约类型 —— 从 @drec/core 的纯类型契约单一源共享(vite/tsconfig alias @drec/contracts
// → packages/core/src/api-types.ts;纯 type,build 时擦除,不把后端运行时代码拉进浏览器包)。
// 后端 @drec/app 的 web/api 用同一份 → 改一处前后端同步,不再各写一份漂移。
import type {
  TaskDTO as Task,
  TaskDetailDTO as TaskDetail,
  TaskRuntime,
  CookieStatus,
  TaskPayload,
  HubPipelineConfig,
  HubRuleDTO,
  HubRulePayload,
  HubJobDTO,
  HubJobNodeStateDTO,
  HubJobCandidateDTO,
  HubJobEventDTO,
  HubJobsDTO,
  RecordingsDTO,
  MergeJobDTO,
  EventsDTO,
  AppEventDTO,
  NotifWebhookToggles,
  PlatformDTO,
  PlatformsDTO,
  WorkerDTO,
  WorkerTestResult,
  WorkerStatus,
} from "@drec/contracts";
export type { Task, TaskDetail, TaskRuntime, CookieStatus, TaskPayload, HubPipelineConfig, HubRuleDTO, HubRulePayload, HubJobDTO, HubJobNodeStateDTO, HubJobCandidateDTO, HubJobEventDTO, HubJobsDTO, RecordingsDTO, MergeJobDTO, EventsDTO, AppEventDTO, NotifWebhookToggles, PlatformDTO, PlatformsDTO, WorkerDTO, WorkerTestResult, WorkerStatus };

/** POST /api/login/qr → start a QR-login session. */
export interface QrStart {
  sessionId: string;
  qrPng: string;
}

/** GET /api/login/qr/:sid → poll. */
export interface QrPoll {
  state: string;
  cookie?: string;
}

/** Thrown on non-2xx responses; carries the server's error message + status. */
export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty / non-json body */
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    if (data && typeof data === "object" && "error" in data) {
      msg = String((data as { error: unknown }).error);
    }
    throw new ApiError(msg, res.status);
  }
  return data as T;
}

export const api = {
  // ── Tasks ──────────────────────────────────────────────────────────────
  listTasks: (): Promise<Task[]> => request("GET", "/api/tasks"),
  getPlatforms: (): Promise<PlatformsDTO> => request("GET", "/api/platforms"),
  getTask: (id: number): Promise<TaskDetail> => request("GET", `/api/tasks/${id}`),
  getTaskLogs: (id: number): Promise<{ lines: string[] }> => request("GET", `/api/tasks/${id}/logs`),
  createTask: (input: TaskPayload): Promise<Task> => request("POST", "/api/tasks", input),
  updateTask: (id: number, input: Partial<TaskPayload>): Promise<Task> =>
    request("PATCH", `/api/tasks/${id}`, input),
  deleteTask: (id: number): Promise<{ ok: boolean; id: number }> => request("DELETE", `/api/tasks/${id}`),
  startTask: (id: number): Promise<Task> => request("POST", `/api/tasks/${id}/start`),
  stopTask: (id: number): Promise<Task> => request("POST", `/api/tasks/${id}/stop`),

  // ── 会话合成 ───────────────────────────────────────────────────────────────
  listRecordings: (id: number): Promise<RecordingsDTO> => request("GET", `/api/tasks/${id}/recordings`),
  startMerge: (id: number, sessions: string[]): Promise<MergeJobDTO> =>
    request("POST", `/api/tasks/${id}/merge`, { sessions }),
  getMerge: (jobId: string): Promise<MergeJobDTO> => request("GET", `/api/merges/${jobId}`),

  // ── 站内事件流(轮询)──────────────────────────────────────────────────────
  getEvents: (since: number): Promise<EventsDTO> => request("GET", `/api/events?since=${since}`),

  // ── 多节点 hub 规则(key = {platform}.{roomSlug})──────────────────────────────
  getHubStatus: (): Promise<{ enabled: boolean }> => request("GET", "/api/hub/status"),
  listHubRules: (): Promise<HubRuleDTO[]> => request("GET", "/api/hub/rules"),
  createHubRule: (input: HubRulePayload): Promise<HubRuleDTO> => request("POST", "/api/hub/rules", input),
  updateHubRule: (key: string, input: HubRulePayload): Promise<HubRuleDTO> =>
    request("PATCH", `/api/hub/rules/${encodeURIComponent(key)}`, input),
  deleteHubRule: (key: string): Promise<{ ok: boolean; key: string }> =>
    request("DELETE", `/api/hub/rules/${encodeURIComponent(key)}`),

  // ── hub 任务(运行态:step/进度/ETA/日志)──────────────────────────────────────
  // room 给定=只列该房间的历次 run(独立历史页);省略=全房间最近 N(规则行取最近一条)。
  listHubJobs: (opts: { room?: string; limit?: number; offset?: number } = {}): Promise<HubJobsDTO> => {
    const q = new URLSearchParams();
    if (opts.room) q.set("room", opts.room);
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.offset != null) q.set("offset", String(opts.offset));
    const qs = q.toString();
    return request("GET", `/api/hub/jobs${qs ? "?" + qs : ""}`);
  },
  getHubJobLog: (streamKey: string): Promise<{ streamKey: string; log: string }> =>
    request("GET", `/api/hub/jobs/${encodeURIComponent(streamKey)}/log`),
  /** 手动重跑单个 workflow 节点(force=true 表示已确认,放行上传类节点)。 */
  retryHubNode: (streamKey: string, node: string, opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string }> =>
    request("POST", `/api/hub/jobs/${encodeURIComponent(streamKey)}/retry-node`, { node, force: opts?.force }),
  /** 停一场后处理(rsync/ffmpeg/biliup),不动录制。 */
  stopHubJob: (streamKey: string): Promise<{ ok: boolean; error?: string }> =>
    request("POST", `/api/hub/jobs/${encodeURIComponent(streamKey)}/stop`),
  /** 立刻跑一场已有录像的后处理。默认异步 202。 */
  runHubJob: (input: { streamKey: string; winnerWorker?: string; wait?: boolean }): Promise<{ ok: boolean; error?: string; streamKey?: string }> =>
    request("POST", "/api/hub/jobs/run", input),

  // ── 多节点 worker(录制节点)管理 ─────────────────────────────────────────────
  listWorkers: (): Promise<WorkerDTO[]> => request("GET", "/api/hub/workers"),
  createWorker: (input: Partial<WorkerDTO>): Promise<WorkerDTO> => request("POST", "/api/hub/workers", input),
  updateWorker: (id: string, input: Partial<WorkerDTO>): Promise<WorkerDTO> =>
    request("PATCH", `/api/hub/workers/${encodeURIComponent(id)}`, input),
  deleteWorker: (id: string): Promise<{ ok: boolean; id: string }> =>
    request("DELETE", `/api/hub/workers/${encodeURIComponent(id)}`),
  testWorker: (cfg: Partial<WorkerDTO>): Promise<WorkerTestResult> => request("POST", "/api/hub/workers/test", cfg),
  /** 批量存活状态(卡片轮询):每 worker {id,ok,error?};hub 未开 → []。 */
  getWorkersStatus: (): Promise<WorkerStatus[]> => request("GET", "/api/hub/workers/status"),

  // ── Global cookie ────────────────────────────────────────────────────────
  getCookie: (): Promise<CookieStatus> => request("GET", "/api/cookie"),
  setCookie: (cookie: string): Promise<CookieStatus> => request("POST", "/api/cookie", { cookie }),
  clearCookie: (): Promise<CookieStatus> => request("DELETE", "/api/cookie"),

  // ── 全局 Discord webhook ────────────────────────────────────────────────────
  getWebhook: (): Promise<{ webhook: string }> => request("GET", "/api/webhook"),
  setWebhook: (webhook: string): Promise<{ webhook: string }> => request("POST", "/api/webhook", { webhook }),
  testWebhook: (content: string): Promise<{ ok: boolean; code: number }> =>
    request("POST", "/api/webhook/test", { content }),

  // ── 每类提醒的 webhook(Discord)开关 ────────────────────────────────────────
  getNotifSettings: (): Promise<NotifWebhookToggles> => request("GET", "/api/notif-settings"),
  setNotifSettings: (toggles: NotifWebhookToggles): Promise<NotifWebhookToggles> =>
    request("PUT", "/api/notif-settings", toggles),

  // ── 版本号(About)──────────────────────────────────────────────────────────
  getVersion: (): Promise<{ version: string }> => request("GET", "/api/version"),

  // ── mesio 二进制路径 ─────────────────────────────────────────────────────────
  // mesioPath = 用户覆盖值(空=用默认);default = 留空时实际会用的路径(供占位符提示)。
  getMesioPath: (): Promise<{ mesioPath: string; default: string }> => request("GET", "/api/mesio-path"),
  setMesioPath: (mesioPath: string): Promise<{ mesioPath: string; default: string }> =>
    request("POST", "/api/mesio-path", { mesioPath }),

  // ── 时区(config 驱动,覆盖 host/容器 TZ)─────────────────────────────────────
  // timezone = 用户配置值(空=用默认);default = 未配置时的默认值;effective = 当前进程实际生效值。
  getTimezone: (): Promise<{ timezone: string; default: string; effective: string }> =>
    request("GET", "/api/timezone"),
  setTimezone: (timezone: string): Promise<{ timezone: string; default: string; effective: string }> =>
    request("POST", "/api/timezone", { timezone }),

  // ── QR login ──────────────────────────────────────────────────────────────
  startLogin: (): Promise<QrStart> => request("POST", "/api/login/qr"),
  pollLogin: (sid: string): Promise<QrPoll> => request("GET", `/api/login/qr/${sid}`),
};
