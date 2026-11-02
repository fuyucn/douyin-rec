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
  BiliupAuthStatus,
  TaskPayload,
  HubPipelineConfig,
  HubRuleDTO,
  HubRulePayload,
  HubJobDTO,
  HubJobNodeStateDTO,
  HubJobCandidateDTO,
  HubJobEventDTO,
  HubJobsDTO,
  HubQueueDTO,
  RollingDeliveryDTO,
  QueueItemDTO,
  NodeUploadStatusDTO,
  HubPoolSnapshotDTO,
  HubBlockedBroadcastDTO,
  QueuePhase,
  HubJobStepDTO,
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
  NodeTasksDTO,
  NodeTaskLogsDTO,
  RoomDTO,
  RoomPayload,
  HubResources,
} from "@drec/contracts";
export type { Task, TaskDetail, TaskRuntime, CookieStatus, BiliupAuthStatus, TaskPayload, HubPipelineConfig, HubRuleDTO, HubRulePayload, HubJobDTO, HubJobNodeStateDTO, HubJobCandidateDTO, HubJobEventDTO, HubJobsDTO, HubQueueDTO, RollingDeliveryDTO, QueueItemDTO, NodeUploadStatusDTO, HubPoolSnapshotDTO, HubBlockedBroadcastDTO, QueuePhase, HubJobStepDTO, RecordingsDTO, MergeJobDTO, EventsDTO, AppEventDTO, NotifWebhookToggles, PlatformDTO, PlatformsDTO, WorkerDTO, WorkerTestResult, WorkerStatus, NodeTasksDTO, NodeTaskLogsDTO, RoomDTO, RoomPayload, HubResources };

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
  /** True when the server says the refusal can be overridden with `force` (hub rerun 409). */
  forceable: boolean;
  constructor(message: string, status: number, forceable = false) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.forceable = forceable;
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
    throw new ApiError(msg, res.status, (data as { forceable?: unknown } | null)?.forceable === true);
  }
  return data as T;
}

export const api = {
  // ── Tasks ──────────────────────────────────────────────────────────────
  listTasks: (): Promise<Task[]> => request("GET", "/api/tasks"),
  getPlatforms: (): Promise<PlatformsDTO> => request("GET", "/api/platforms"),
  getTask: (id: number): Promise<TaskDetail> => request("GET", `/api/tasks/${id}`),
  getTaskLogs: (id: number): Promise<{ lines: string[] }> => request("GET", `/api/tasks/${id}/logs`),
  getTaskLive: (id: number): Promise<{ entries: Array<{ workerId: string; workerName: string; current?: import("@drec/contracts").LiveUploadSnapshot; previous?: import("@drec/contracts").LiveUploadSnapshot; history?: import("@drec/contracts").LiveUploadSnapshot[] }> }> =>
    request("GET", `/api/tasks/${id}/live`),
  createTask: (input: TaskPayload): Promise<Task> => request("POST", "/api/tasks", input),
  updateTask: (id: number, input: Partial<TaskPayload>): Promise<Task> =>
    request("PATCH", `/api/tasks/${id}`, input),
  deleteTask: (id: number): Promise<{ ok: boolean; id: number }> => request("DELETE", `/api/tasks/${id}`),
  startTask: (id: number): Promise<Task> => request("POST", `/api/tasks/${id}/start`),
  stopTask: (id: number): Promise<Task> => request("POST", `/api/tasks/${id}/stop`),
  /** 优雅排空:当前这场录到自然收播再停,不截断(与 stopTask 的硬停相对)。 */
  drainTask: (id: number): Promise<Task> => request("POST", `/api/tasks/${id}/drain`),

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
  // ── 资源闸门(T15):改完**立即生效**,无需重启 master ──────────────────────────
  getHubResources: (): Promise<{ resources: HubResources; source: string; path: string | null; defaults: HubResources }> =>
    request("GET", "/api/hub/resources"),
  putHubResources: (patch: Partial<HubResources>): Promise<{ resources: HubResources; source: string }> =>
    request("PUT", "/api/hub/resources", patch),

  // ── 统一房间(T9):一次读写「录制 + 处理」两半 ────────────────────────────────
  listRooms: (): Promise<RoomDTO[]> => request("GET", "/api/rooms"),
  getRoom: (key: string): Promise<RoomDTO> => request("GET", `/api/rooms/${encodeURIComponent(key)}`),
  /** 一次改两半(各自可选);后端第二步失败会回滚第一步,不会留半成功。 */
  updateRoom: (key: string, input: RoomPayload): Promise<RoomDTO> =>
    request("PUT", `/api/rooms/${encodeURIComponent(key)}`, input),

  /** 拖拽排序持久化:keys = 完整送序。 */
  reorderHubRules: (keys: string[]): Promise<HubRuleDTO[]> => request("POST", "/api/hub/rules/reorder", { keys }),

  // ── hub 任务(运行态:step/进度/ETA/日志)──────────────────────────────────────
  // room 给定=只列该房间的历次 run(独立历史页);省略=全房间最近 N(规则行取最近一条)。
  /** 场次日志清理预览(只统计,不删)。 */
  previewJobLogs: (days: number): Promise<{ dryRun: true; olderThanDays: number; count: number; bytes: number }> =>
    request("GET", `/api/maintenance/job-logs?olderThanDays=${days}`),
  /** 场次日志清理执行(必须 confirm;failed 为删除失败的文件名)。 */
  cleanupJobLogs: (days: number): Promise<{ olderThanDays: number; deleted: number; bytes: number; failed: Array<{ file: string; error: string }> }> =>
    request("POST", "/api/maintenance/job-logs", { olderThanDays: days, confirm: true }),
  listHubJobs: (opts: { room?: string; limit?: number; offset?: number; states?: string[] } = {}): Promise<HubJobsDTO> => {
    const q = new URLSearchParams();
    if (opts.room) q.set("room", opts.room);
    if (opts.limit != null) q.set("limit", String(opts.limit));
    if (opts.offset != null) q.set("offset", String(opts.offset));
    if (opts.states?.length) q.set("states", opts.states.join(","));
    const qs = q.toString();
    return request("GET", `/api/hub/jobs${qs ? "?" + qs : ""}`);
  },
  /**
   * 处理队列视图:进行中(做了什么/正在做什么/下面做什么)+ 最近完成 + 资源池占用。
   * 排序:sort=newest(缺省,入队时间倒序=最新在前)| oldest(升序=FIFO 谁等最久谁在前)。
   */
  /** 每个房间最新一条 run(房间列表徽标用;不受分页影响)。 */
  getLatestRuns: (): Promise<{ rooms: Array<{ roomKey: string; streamKey: string; state: string; bv: string | null; updatedAt: number; manualPhase?: string | null }> }> =>
    request("GET", "/api/hub/latest-runs"),
  getHubQueue: (
    opts: { phase?: string[]; states?: string[]; platform?: string[]; q?: string; sort?: "newest" | "oldest" } = {},
  ): Promise<HubQueueDTO> => {
    const q = new URLSearchParams();
    if (opts.phase?.length) q.set("phase", opts.phase.join(","));
    if (opts.states?.length) q.set("states", opts.states.join(","));
    if (opts.platform?.length) q.set("platform", opts.platform.join(","));
    if (opts.q) q.set("q", opts.q);
    if (opts.sort) q.set("sort", opts.sort);
    const qs = q.toString();
    return request("GET", `/api/hub/queue${qs ? "?" + qs : ""}`);
  },
  getHubJobLog: (streamKey: string): Promise<{ streamKey: string; log: string }> =>
    request("GET", `/api/hub/jobs/${encodeURIComponent(streamKey)}/log`),
  /** 手动重跑单个 workflow 节点(force=true 表示已确认,放行上传类节点)。 */
  retryHubNode: (streamKey: string, node: string, opts?: { force?: boolean }): Promise<{ ok: boolean; error?: string }> =>
    request("POST", `/api/hub/jobs/${encodeURIComponent(streamKey)}/retry-node`, { node, force: opts?.force }),
  /** 停一场后处理(rsync/ffmpeg/biliup),不动录制。 */
  stopHubJob: (streamKey: string): Promise<{ ok: boolean; error?: string }> =>
    request("POST", `/api/hub/jobs/${encodeURIComponent(streamKey)}/stop`),
  /** Mark a needs_manual run as reviewed (note required), or clear the mark with undo (issue #312). */
  ackHubJob: (streamKey: string, input: { note?: string; undo?: boolean }): Promise<{ ok: boolean; error?: string }> =>
    request("POST", `/api/hub/jobs/${encodeURIComponent(streamKey)}/ack`, input),
  /** 立刻跑一场已有录像的后处理。默认异步 202。 */
  runHubJob: (input: { streamKey: string; winnerWorker?: string; wait?: boolean; force?: boolean }): Promise<{ ok: boolean; error?: string; streamKey?: string }> =>
    request("POST", "/api/hub/jobs/run", input),

  // ── 多节点 worker(录制节点)管理 ─────────────────────────────────────────────
  listWorkers: (): Promise<WorkerDTO[]> => request("GET", "/api/hub/workers"),
  createWorker: (input: Partial<WorkerDTO>): Promise<WorkerDTO> => request("POST", "/api/hub/workers", input),
  updateWorker: (id: string, input: Partial<WorkerDTO>): Promise<WorkerDTO> =>
    request("PATCH", `/api/hub/workers/${encodeURIComponent(id)}`, input),
  deleteWorker: (id: string): Promise<{ ok: boolean; id: string }> =>
    request("DELETE", `/api/hub/workers/${encodeURIComponent(id)}`),
  /** 拖拽排序持久化:ids = 完整送序。 */
  reorderWorkers: (ids: string[]): Promise<WorkerDTO[]> => request("POST", "/api/hub/workers/reorder", { ids }),
  testWorker: (cfg: Partial<WorkerDTO>): Promise<WorkerTestResult> => request("POST", "/api/hub/workers/test", cfg),
  /** 批量存活状态(卡片轮询):每 worker {id,ok,error?};hub 未开 → []。 */
  getWorkersStatus: (): Promise<WorkerStatus[]> => request("GET", "/api/hub/workers/status"),
  /** F3:master 读某节点的任务清单(只读,无凭证)。 */
  getNodeTasks: (workerId: string): Promise<NodeTasksDTO> => request("GET", `/api/hub/workers/${encodeURIComponent(workerId)}/tasks`),
  /** F3:master 代查某节点某任务的日志尾巴(只读)。 */
  getNodeTaskLogs: (workerId: string, taskId: number, lines = 200): Promise<NodeTaskLogsDTO> =>
    request("GET", `/api/hub/workers/${encodeURIComponent(workerId)}/tasks/${taskId}/logs?lines=${lines}`),

  // ── Per-platform cookies ─────────────────────────────────────────────────
  getCookies: (): Promise<{ platforms: CookieStatus[] }> => request("GET", "/api/cookies"),
  getCookie: (platform = "douyin"): Promise<CookieStatus> => request("GET", `/api/cookies/${platform}`),
  setCookie: (cookie: string, platform = "douyin"): Promise<CookieStatus> =>
    request("POST", `/api/cookies/${platform}`, { cookie }),
  clearCookie: (platform = "douyin"): Promise<CookieStatus> => request("DELETE", `/api/cookies/${platform}`),
  getBiliupStatus: (): Promise<BiliupAuthStatus> => request("GET", "/api/biliup/status"),

  // ── 全局 Discord webhook ────────────────────────────────────────────────────
  /** webhook 原文不回显(凭证);webhook 字段恒为空,只看 hasWebhook。 */
  getWebhook: (): Promise<{ webhook: string; hasWebhook: boolean }> => request("GET", "/api/webhook"),
  setWebhook: (webhook: string): Promise<{ webhook: string; hasWebhook: boolean }> =>
    request("POST", "/api/webhook", { webhook }),
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

  // ── 抖音 API 模式(取流 + 弹幕 liveId 用哪个端点)───────────────────────────
  // mode = 用户配置值(空=未设);default = 未配置时的默认值;effective = 实际生效值(归一后);options = 可选值。
  getDouyinApiMode: (): Promise<{ mode: string; default: string; effective: string; options: string[] }> =>
    request("GET", "/api/douyin-api-mode"),
  setDouyinApiMode: (mode: string): Promise<{ mode: string; default: string; effective: string; options: string[] }> =>
    request("POST", "/api/douyin-api-mode", { mode }),

  // ── 时区(config 驱动,覆盖 host/容器 TZ)─────────────────────────────────────
  // timezone = 用户配置值(空=用默认);default = 未配置时的默认值;effective = 当前进程实际生效值。
  getTimezone: (): Promise<{ timezone: string; default: string; effective: string }> =>
    request("GET", "/api/timezone"),
  setTimezone: (timezone: string): Promise<{ timezone: string; default: string; effective: string }> =>
    request("POST", "/api/timezone", { timezone }),

  // ── QR login ──────────────────────────────────────────────────────────────
  startLogin: (platform = "douyin"): Promise<QrStart> => request("POST", "/api/login/qr", { platform }),
  pollLogin: (sid: string): Promise<QrPoll> => request("GET", `/api/login/qr/${sid}`),
};
