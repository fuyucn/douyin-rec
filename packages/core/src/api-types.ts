// API 契约 DTO —— 纯类型,前后端单一来源(无运行时依赖,前端 build 时擦除,不拉后端代码)。
// 后端 @drec/app 的 web/api 用它定请求/响应;前端 packages/web 经 alias import 同一份。
import type { NotifyEvent } from "./notify.js";
export type { NotifyEvent };

/**
 * 多节点 hub 后处理配置(按房间)。**独立于录制任务**——录制任务只管录,hub 规则管后处理。
 * hub 是全局管理器,对每个 enabled 的 HubRule(按 roomSlug)执行这份 pipeline。
 */
export interface HubPipelineConfig {
  /** 产出哪些(merge plain 是基础总做)。默认全 true。 */
  steps?: { burnDanmu?: boolean; burnLivechat?: boolean };
  /** 清理开关(都默认 false;includeXmlAss 决定删除是否含 .xml/.ass)。 */
  cleanup?: { stageSourceAfterMerge?: boolean; sourceAfterDone?: boolean; stageAfterDone?: boolean; includeXmlAss?: boolean };
  /** 上传:mode 缺省 stage-only(不传);auto-private 才上传 B站。tag/tid/desc 为该稿 metadata。 */
  upload?: { mode?: "stage-only" | "auto-private"; tag?: string; tid?: number; desc?: string };
}

/** 一条 hub 规则(GET /api/hub/rules)。按 roomSlug(web_rid)唯一。 */
export interface HubRuleDTO {
  /** 房间唯一 ID(web_rid),= 主键。 */
  roomSlug: string;
  /** 用户输入的房间地址(显示用)。 */
  room: string;
  platform: string;
  /** 规则启用?false = 暂停该房间的 hub 处理。 */
  enabled: boolean;
  config: HubPipelineConfig;
  /** 主播名(若有同 roomSlug 的录制任务/录像可关联显示);未知 null。 */
  anchorName?: string | null;
}

/** POST /api/hub/rules + PATCH /api/hub/rules/:roomSlug 的请求体。 */
export interface HubRulePayload {
  /** 房间地址或房间号(归一化解析出 roomSlug);create 必填。 */
  room?: string;
  enabled?: boolean;
  config?: HubPipelineConfig;
}

/** POST /api/tasks + PATCH /api/tasks/:id 的请求体(部分字段;录制专属,hub 配置见 HubRule)。 */
export interface TaskPayload {
  room: string;
  name?: string | null;
  quality?: string;
  /** 下载引擎 id(ffmpeg / mesio,按平台,省略=平台默认;非法值后端回落)。 */
  engine?: string;
  /** 弹幕开关(0/1 或 bool);来源由命中平台的 connectDanmu 提供,无 provider 字段。 */
  danmu?: number | boolean;
  segmentSec?: number;
  useCookie?: boolean;
  /** "HH:MM-HH:MM" | null。 */
  schedule?: string | null;
  /** 任务专属 Discord webhook(开播/录完/合并完成/错误);空/省略 = 回落全局。 */
  webhook?: string | null;
}

/** GET /api/platforms 的单个平台配置投影(前端按 urlPattern 判平台 + 动态填表单选项)。 */
export interface PlatformDTO {
  id: string;
  /** matchUrl 的正则源(客户端 new RegExp 判平台);null = 该平台未提供(只能靠后端默认回落)。 */
  urlPattern: string | null;
  qualities: readonly string[];
  /** 可用下载引擎 id(ffmpeg / mesio)。 */
  engines: readonly string[];
  defaultQuality: string;
  defaultEngine: string;
  /** 本平台是否有弹幕能力(connectDanmu 非空);前端据此显示/禁用弹幕开关。 */
  hasDanmu: boolean;
}

/** GET /api/platforms 响应。platforms[0] = 默认平台(URL 无命中时回落)。 */
export interface PlatformsDTO {
  platforms: PlatformDTO[];
}

/** GET /api/tasks[] 的任务响应(含 live 运行态;不含敏感 cookies)。 */
export interface TaskDTO {
  id: number;
  room: string;
  name: string | null;
  quality: string;
  /** 下载引擎 id(ffmpeg / mesio)。 */
  engine: string;
  /** 1=抓弹幕 0=关。 */
  danmu: number;
  segmentSec: number;
  useCookie: boolean;
  outDir: string | null;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  status: string;
  enabled: boolean;
  createdAt: string;
  /** 进程是否在跑(可能「等待开播中」)。 */
  running: boolean;
  anchorName: string | null;
  /** 是否真正在录视频(区分 running 但等待开播)。 */
  recording: boolean;
  /** 任务专属 Discord webhook;null = 回落全局。 */
  webhook: string | null;
}

/** 详情页 live runtime(GET /api/tasks/:id)。 */
export interface TaskRuntime {
  running: boolean;
  startedAt: number | null;
  elapsedMs: number | null;
  anchorName: string | null;
}

/** GET /api/tasks/:id → 任务 + runtime。 */
export interface TaskDetailDTO extends TaskDTO {
  runtime: TaskRuntime;
}

/** GET /api/cookie 的全局 cookie 状态。 */
export interface CookieStatus {
  set: boolean;
  hasSession: boolean;
  length: number;
  expiresAt: number | null;
}

/** GET /api/tasks/:id/recordings 的单个会话项(合成选择器用)。 */
export interface RecordingSessionDTO {
  /** 会话 base(内嵌时间戳 → 字典序=时间序)。 */
  base: string;
  /** 分段 .ts 数。 */
  segments: number;
  /** 是否有会话级弹幕 .xml。 */
  hasXml: boolean;
}

/** GET /api/tasks/:id/recordings 响应。 */
export interface RecordingsDTO {
  dir: string | null;
  sessions: RecordingSessionDTO[];
}

/** 合成后台任务(POST /api/tasks/:id/merge → 202;GET /api/merges/:jobId 轮询)。 */
export interface MergeJobDTO {
  id: string;
  taskId: number;
  state: "running" | "done" | "error";
  /** 选中会话 base(时间序)。 */
  sessions: string[];
  mp4?: string;
  xml?: string;
  error?: string;
}

/** 站内事件(GET /api/events 的单项)。 */
export interface AppEventDTO {
  /** 单调递增序号(轮询游标)。 */
  id: number;
  /** epoch ms。 */
  at: number;
  /** 归属任务;全局为 null。 */
  taskId: number | null;
  /** 原始通知事件(kind + 字段)。 */
  event: NotifyEvent;
}

/** GET /api/events?since=N 响应:增量事件 + 新游标。 */
export interface EventsDTO {
  events: AppEventDTO[];
  cursor: number;
}
