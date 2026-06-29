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
  RecordingsDTO,
  MergeJobDTO,
  EventsDTO,
  AppEventDTO,
  PlatformDTO,
  PlatformsDTO,
} from "@drec/contracts";
export type { Task, TaskDetail, TaskRuntime, CookieStatus, TaskPayload, HubPipelineConfig, HubRuleDTO, HubRulePayload, RecordingsDTO, MergeJobDTO, EventsDTO, AppEventDTO, PlatformDTO, PlatformsDTO };

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

  // ── 多节点 hub 规则(按 roomSlug)──────────────────────────────────────────────
  listHubRules: (): Promise<HubRuleDTO[]> => request("GET", "/api/hub/rules"),
  createHubRule: (input: HubRulePayload): Promise<HubRuleDTO> => request("POST", "/api/hub/rules", input),
  updateHubRule: (roomSlug: string, input: HubRulePayload): Promise<HubRuleDTO> =>
    request("PATCH", `/api/hub/rules/${roomSlug}`, input),
  deleteHubRule: (roomSlug: string): Promise<{ ok: boolean; roomSlug: string }> =>
    request("DELETE", `/api/hub/rules/${roomSlug}`),

  // ── Global cookie ────────────────────────────────────────────────────────
  getCookie: (): Promise<CookieStatus> => request("GET", "/api/cookie"),
  setCookie: (cookie: string): Promise<CookieStatus> => request("POST", "/api/cookie", { cookie }),
  clearCookie: (): Promise<CookieStatus> => request("DELETE", "/api/cookie"),

  // ── 全局 Discord webhook ────────────────────────────────────────────────────
  getWebhook: (): Promise<{ webhook: string }> => request("GET", "/api/webhook"),
  setWebhook: (webhook: string): Promise<{ webhook: string }> => request("POST", "/api/webhook", { webhook }),
  testWebhook: (content: string): Promise<{ ok: boolean; code: number }> =>
    request("POST", "/api/webhook/test", { content }),

  // ── 版本号(About)──────────────────────────────────────────────────────────
  getVersion: (): Promise<{ version: string }> => request("GET", "/api/version"),

  // ── mesio 二进制路径 ─────────────────────────────────────────────────────────
  // mesioPath = 用户覆盖值(空=用默认);default = 留空时实际会用的路径(供占位符提示)。
  getMesioPath: (): Promise<{ mesioPath: string; default: string }> => request("GET", "/api/mesio-path"),
  setMesioPath: (mesioPath: string): Promise<{ mesioPath: string; default: string }> =>
    request("POST", "/api/mesio-path", { mesioPath }),

  // ── QR login ──────────────────────────────────────────────────────────────
  startLogin: (): Promise<QrStart> => request("POST", "/api/login/qr"),
  pollLogin: (sid: string): Promise<QrPoll> => request("GET", `/api/login/qr/${sid}`),
};
