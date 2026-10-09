/**
 * web/api/types.ts — web 层的公共类型契约(T-22 第 1 步从 api.ts 拆出)。
 *
 * 含:handler 返回的 ApiResult、注入依赖 ApiDeps、窄接口 ManagerLike/LoginManagerLike、
 * 视图 DTO(TaskView/TaskDetailView)、请求体(CreateTaskInput/UpdateTaskInput)、
 * CookieStatus、以及对外 API 面 `Api`。
 */
import type { TaskRuntime } from "../../task-manager.js";
import type { MergeJobStore } from "../../merge-jobs.js";
import type { Task, TaskStore } from "../../store.js";
import type { EventCenter, NotifWebhookToggles } from "@drec/observability";
import type {
  RecordingWorkerStatusDTO, HubRulePayload, HubPoolSnapshotDTO, WorkerTestResult,
} from "@drec/core";

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
  start(platform?: string): Promise<{ sessionId: string; qrPng: string }>;
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
  /** hub 任务配置目录(<root>/config/hub);省略=回落 rootHubDir()。 */
  hubDir?: string;
  /** 本节点是否启用了 hub(master);slave/未开 = false。前端据此显示/隐藏 Hub 页。 */
  hubEnabled?: boolean;
  /** hub 台账 sqlite(<db>-sync.db)路径;省略=hub 任务端点返回空列表(slave 属正常)。 */
  syncDbPath?: string;
  /** hub.config.json 路径;省略回落 rootHubConfig()。 */
  hubConfigPath?: string;
  /** biliup cookies.json 路径;省略回落 DEFAULT_COOKIES(测试注入用)。 */
  biliupCookiesPath?: string;
  /** 连接测试(CLI 注入,能 import orchestrator)。省略 → 端点返回「hub 未启用」。 */
  testWorker?: (cfg: { kind: string; host?: string; dataRoot?: string; id?: string; apiUrl?: string }) => Promise<WorkerTestResult>;
  /** 批量存活探针(CLI 注入)。省略(hub 未开)→ status 端点返回 []。 */
  probeAllWorkers?: () => Promise<Array<{ id: string; ok: boolean; error?: string }>>;
  /** 录制节点状态缓存读取;避免每次列任务都同步 SSH。 */
  recordingWorkers?: (platform: string, roomSlug: string) => RecordingWorkerStatusDTO[];
  /** 立即触发一次 hub 任务同步(hub 规则/worker 变更后由 web API 调用;省略=只等周期 tick)。 */
  requestSyncTasks?: () => void;
  /**
   * master 本机抑制名单:返回「由 hub 规则切到远端节点录制,本机不应实跑」的源任务 id。
   * `startTask` 据此决定只置 enabled(意图)还是真的起子进程 —— 否则手动启动会绕过
   * daemon 的抑制,造成本机与远端同场重复录制。省略=不抑制(单机/slave 行为不变)。
   */
  localSuppressedIds?: () => ReadonlySet<number>;
  /** 手动重跑单个 workflow 节点(CLI 注入,能 import orchestrator)。省略 → 端点返回「hub 未启用」。 */
  retryNode?: (streamKey: string, node: string, opts?: { force?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number }>;
  /** 停一场后处理(CLI 注入)。省略 → 端点返回「hub 未启用」。 */
  stopJob?: (streamKey: string) => Promise<{ ok: boolean; error?: string; code?: number }>;
  /** 立刻跑一场已有录像的后处理(CLI 注入)。省略 → 端点返回「hub 未启用」。 */
  runNow?: (opts: { streamKey: string; winnerWorker?: string; wait?: boolean }) => Promise<{ ok: boolean; error?: string; code?: number; streamKey?: string }>;
  /** master 资源池快照(CLI 注入,读同一 ResourcePool 实例)。省略/未就绪 → 队列页无排队位次(全 0)。 */
  poolSnapshot?: () => HubPoolSnapshotDTO | undefined;
}

/** A task enriched with its live running state for client display. */
export interface TaskView extends Task {
  running: boolean;
  /** 抓取到的主播名（运行时解析，未设 name 时 UI 用它显示），未知为 null。 */
  anchorName: string | null;
  /** true=真正在录视频；false 且 running=true → 进程在跑但「等待开播中」。 */
  recording: boolean;
  recordingWorkers?: RecordingWorkerStatusDTO[];
  /** hub 规则摘要(仅 master、房间有规则时);列表用它显示 hub 关联并跳转。 */
  hubRule?: {
    key: string;
    enabled: boolean;
    steps: string[];
    uploadMode: "stage" | "upload";
    lastRun: { state: string; bv: string | null } | null;
  };
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
  /** Per-task: pass its platform cookie to the recorder? Default true. */
  useCookie?: boolean | number;
  outDir?: string | null;
  /** "HH:MM-HH:MM"; parsed into scheduleStart/scheduleEnd. */
  schedule?: string | null;
  scheduleStart?: string | null;
  scheduleEnd?: string | null;
  /** 任务专属 Discord webhook;空/省略 = 回落全局。 */
  webhook?: string | null;
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
}

/** Public status of one platform cookie (never leaks the raw value). */
export interface CookieStatus {
  platform: string;
  set: boolean;
  hasSession: boolean;
  length: number;
  /** 登录态过期时间（epoch ms），解析自 sid_guard；解析不出为 null。 */
  expiresAt: number | null;
  source: "settings" | "none";
}

export interface Api {
  listTasks(): ApiResult;
  createTask(input: CreateTaskInput): ApiResult;
  updateTask(id: number, input: UpdateTaskInput): ApiResult;
  getTask(id: number): ApiResult;
  /** GET /api/tasks/:id/logs — captured recorder log lines. 404 if missing. */
  getTaskLogs(id: number): ApiResult;
  deleteTask(id: number): Promise<ApiResult>;
  /** POST /api/tasks/:id/refresh-anchor — 触发后台重新抓取主播名(匿名,fire-and-forget)。供 _apply-tasks 在 VPS 侧调用。 */
  refreshTaskAnchor(id: number): ApiResult;
  startTask(id: number): ApiResult;
  stopTask(id: number, opts?: { internal?: boolean }): Promise<ApiResult>;
  /** POST /api/login/qr { platform? } — start a QR-login → { sessionId, qrPng }. */
  startLogin(input?: { platform?: string }): Promise<ApiResult>;
  /** GET /api/login/qr/:sid — poll → { state, cookie? }. */
  pollLogin(sessionId: string): Promise<ApiResult>;
  /** GET /api/cookies — status for every registered platform. */
  listCookies(): ApiResult;
  /** GET /api/cookie[s/:platform] — platform cookie status (never the raw value). */
  getCookie(platform?: string): ApiResult;
  /** POST /api/cookie[s/:platform] { cookie } — set a platform cookie (manual paste). */
  setCookie(input: { cookie?: string }, platform?: string): ApiResult;
  /** DELETE /api/cookie[s/:platform] — clear a platform cookie. */
  clearCookie(platform?: string): ApiResult;
  /** GET /api/biliup/status — biliup 上传登录态(独立于录制 Cookie)。 */
  getBiliupStatus(): ApiResult;
  /** GET /api/webhook — 全局 Discord webhook 是否已配置(**不回显原文**,webhook URL 是凭证)。 */
  getWebhook(): ApiResult;
  /** POST /api/webhook { webhook } — set/clear the global Discord webhook(空串=清除)。 */
  setWebhook(input: { webhook?: string }): ApiResult;
  /** POST /api/webhook/test { content } — 把 content 发到已保存的全局 webhook(走真实 Discord POST 路径)。 */
  testWebhook(input: { content?: string }): Promise<ApiResult>;
  /** GET /api/notif-settings — 每类提醒的 webhook 开关(缺省全关)。 */
  getNotifSettings(): ApiResult;
  /** PUT /api/notif-settings { live?, recordEnd?, merge?, hub?, error? } — 保存每类提醒的 webhook 开关。 */
  setNotifSettings(input: Partial<NotifWebhookToggles>): ApiResult;
  /** GET /api/version — 应用版本号(0.0.0-{commit 后6位};About 页显示)。 */
  getVersion(): ApiResult;
  /** GET /api/mesio-path — mesio 二进制路径设置(settings.mesioPath)+ 留空时的实际默认(供 UI 占位符)。 */
  getMesioPath(): ApiResult;
  /** POST /api/mesio-path { mesioPath } — set/clear mesio 路径(空串=清除→回落 bin/mesio 默认)。 */
  setMesioPath(input: { mesioPath?: string }): ApiResult;
  /** GET /api/douyin-api-mode — 抖音 API 模式设置(settings.douyinApiMode)+ 默认 + 可选值。 */
  getDouyinApiMode(): ApiResult;
  /** POST /api/douyin-api-mode { mode } — 设抖音 API 模式(balance/web/webHTML/mobile/random);
   *  非法值回落默认 balance。改设置下次 spawn 生效(经 env 注入录制子进程)。 */
  setDouyinApiMode(input: { mode?: string }): ApiResult;
  /** GET /api/timezone — 当前生效时区(settings.timezone,留空=默认)+ 默认值。 */
  getTimezone(): ApiResult;
  /** POST /api/timezone { timezone } — 设时区(config 驱动,覆盖 host 环境变量,立即生效不用重启);
   *  空串=清除(回落默认);非法 IANA 时区名 → 400。 */
  setTimezone(input: { timezone?: string }): ApiResult;
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
  /** GET /api/hub/status — 本节点是否 master(启用了 hub)。前端据此显示/隐藏 Hub 页。 */
  hubStatus(): ApiResult;
  /** GET /api/hub/rules — 所有多节点 hub 后处理规则(按 {platform}.{roomSlug})。 */
  listHubRules(): ApiResult;
  /** POST /api/hub/rules { room, enabled?, pipeline? } — 新建/覆盖一条 hub 规则。 */
  createHubRule(input: HubRulePayload): ApiResult;
  /** PATCH /api/hub/rules/:key { enabled?, pipeline? } — 部分更新一条规则(key={platform}.{roomSlug})。 */
  updateHubRule(key: string, input: HubRulePayload): ApiResult;
  /** DELETE /api/hub/rules/:key — 删除一条规则。 */
  deleteHubRule(key: string): ApiResult;
  /** POST /api/hub/rules/reorder { keys } — 按给定顺序整体重排规则列表(拖拽排序持久化)。 */
  reorderHubRules(input: { keys?: string[] }): ApiResult;
  /** GET /api/hub/jobs[?room=&limit=&offset=&states=] — hub run 列表(状态/时间线/ETA/hasLog + total 分页)。 */
  listHubJobs(opts?: { room?: string; limit?: number; offset?: number; states?: string[] }): ApiResult;
  /** GET /api/hub/latest-runs — 每个房间最新一条 run 摘要(Hub 房间列表徽标用,不受分页影响)。 */
  latestRuns(): ApiResult;
  /**
   * GET /api/hub/queue[?phase=&platform=&q=] — 处理队列视图:进行中(做了什么/正在做什么/下面做什么)
   * + 最近完成 + 资源池占用。phase/platform 可重复传(逗号分隔亦可);q = 主播名/房间号/streamKey 子串。
   * 排序固定为真实 FIFO(入队时刻升序);筛选在服务端做,前端拿到即所见。
   */
  hubQueue(opts?: { phase?: string[]; states?: string[]; platform?: string[]; q?: string; sort?: "newest" | "oldest" }): ApiResult;
  /** GET /api/hub/jobs/:key/log — 该场 job.log 尾部(key=streamKey,URL-encoded)。 */
  getHubJobLog(streamKey: string): ApiResult;
  /** POST /api/hub/jobs/:key/retry-node { node, force? } — 手动重跑单个 workflow 节点。 */
  retryHubNode(streamKey: string, input: { node?: string; force?: boolean }): Promise<ApiResult>;
  /** POST /api/hub/jobs/:key/stop — 停一场后处理,不动录制。 */
  stopHubJob(streamKey: string): Promise<ApiResult>;
  /** POST /api/hub/jobs/run { streamKey, winnerWorker?, wait? } — 立刻跑一场已有录像的后处理。 */
  runHubJob(input: { streamKey?: string; winnerWorker?: string; wait?: boolean }): Promise<ApiResult>;
  /** GET /api/hub/workers — 列出录制 worker(hub 未启用 → 400)。 */
  listWorkers(): ApiResult;
  /** POST /api/hub/workers — 新建 worker。 */
  createWorker(input: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[]; id?: string }): ApiResult;
  /** PATCH /api/hub/workers/:id — 部分更新。 */
  updateWorker(id: string, input: { name?: string; kind?: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[] }): ApiResult;
  /** DELETE /api/hub/workers/:id — 删除(local 保护)。 */
  deleteWorker(id: string): ApiResult;
  /** POST /api/hub/workers/reorder { ids } — 按给定顺序整体重排 worker 列表(拖拽排序持久化)。 */
  reorderWorkers(input: { ids?: string[] }): ApiResult;
  /** POST /api/hub/workers/test — 连接测试(hub 未启用 / 未注入 testWorker → 400;测试异常也回 200 结构化 error)。 */
  testWorker(input: { kind?: string; host?: string; dataRoot?: string; apiUrl?: string }): Promise<ApiResult>;
  /** GET /api/hub/workers/status — 并行 ping 所有已配置 worker(未注入 probeAllWorkers → [])。 */
  workersStatus(): Promise<ApiResult>;
}
