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
  /**
   * 上传:`mode` = stage(只合成不传)/ upload(传 B站);缺省 stage。
   * `private` 仅 mode=upload 时有意义:true(默认)= 仅自己可见,false = 公开。tag/tid/desc 为该稿 metadata。
   */
  upload?: { mode?: "stage" | "upload"; private?: boolean; tag?: string; tid?: number; desc?: string };
}

/** 一条 hub 规则(GET /api/hub/rules)。按平台限定,持久化为 <root>/config/hub/{platform}.{roomSlug}.json。 */
export interface HubRuleDTO {
  /** `{platform}.{roomSlug}` —— 全局唯一 id(文件名 stem + API 路由参数;跨平台不撞)。 */
  key: string;
  /** 房间 ID(web_rid);单平台内唯一。 */
  roomSlug: string;
  /** 用户输入的房间地址(显示用,文件内 room 字段)。 */
  room: string;
  platform: string;
  /** 规则启用?false = 暂停该房间的 hub 处理。 */
  enabled: boolean;
  /** 流水线配置(steps / upload / cleanup);upload 是 pipeline 的一个阶段。 */
  pipeline: HubPipelineConfig;
  /** 选中参与该房间 hub 处理的 worker id;缺省/空 = 全部 worker(向后兼容)。 */
  workers?: string[];
  /** 主播名(若有同 roomSlug 的录制任务/录像可关联显示);未知 null。 */
  anchorName?: string | null;
}

/** hub 任务的一次状态转换事件(时间线;GET /api/hub/jobs 内嵌)。 */
export interface HubJobEventDTO {
  /** pending / settling / syncing / merging / uploading / done / failed / needs_manual。 */
  state: string;
  /** 事件时刻(epoch ms)。 */
  at: number;
}

/** 细粒度子步骤事件(start/done),驱动 fork/join 流程图。 */
export interface HubJobStepDTO {
  /** select / pull / merge / burn_danmu / burn_livechat / upload_plain / append_danmu / append_livechat。 */
  step: string;
  /** start | done。 */
  phase: string;
  at: number;
}

/** 某场某节点的选优候选(流程图 select 步的 fan-in 节点)。worker=节点 id(前端映射友好名)。 */
export interface HubJobCandidateDTO {
  /** 录制节点(worker)id。 */
  worker: string;
  /** 覆盖度 0..1(=1−gap/span);前端显示 %。 */
  coverage: number;
  /** 该节点录到的视频总时长(秒)。 */
  durationSec: number;
  /** 是否完整录全(单会话无断流缺口)。 */
  complete: boolean;
  /** 是否本场胜出节点。 */
  isWinner: boolean;
}

/** 一个 hub 任务的运行视图(GET /api/hub/jobs)。展示当前 pipeline step / 进度 / 运行时间 / ETA。 */
export interface HubJobDTO {
  /** `{platform}:{roomSlug}:{date}`。 */
  streamKey: string;
  /** 当前状态(= 当前 pipeline step;终态 done/failed/needs_manual)。 */
  state: string;
  winnerWorker: string | null;
  /** 各录制节点的选优候选(空=旧 run / 未选优;前端 select 步据此画 fan-in)。 */
  candidates: HubJobCandidateDTO[];
  bv: string | null;
  error: string | null;
  /** 自动重试已失败次数。 */
  fails: number;
  updatedAt: number;
  /** job 创建(首个事件)时刻;无 = null。 */
  startedAt: number | null;
  /** 状态转换时间线(升序)——每步起点 = 事件时刻,步骤耗时 = 相邻差。 */
  events: HubJobEventDTO[];
  /** 细粒度子步骤 start/done 事件(升序);空=旧 run,前端回落粗粒度。 */
  steps: HubJobStepDTO[];
  /** 当前步已运行秒数(终态 = null)。 */
  currentStepSec: number | null;
  /** 当前步预计剩余秒数(粗估,按历史同步骤速率;终态/无依据 = null)。 */
  etaSec: number | null;
  /** winner 视频时长秒(ETA 换算基准;无 = null)。 */
  videoDurationSec: number | null;
  /** 该场是否有 job.log(有才给「查看日志」入口)。 */
  hasLog: boolean;
}

/** 一个录制 worker(节点)的展示投影。id 内部稳定主键(UI 不展示);name 友好名。 */
export interface WorkerDTO { id: string; name: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string }

/** worker 连接测试结果(POST /api/hub/workers/test)——轻量 ping:可达 + dataRoot 存在。 */
export interface WorkerTestResult { ok: boolean; error?: string; }
/** GET /api/hub/workers/status 的单个 worker 健康结果(批量 ping)。 */
export interface WorkerStatus { id: string; ok: boolean; error?: string; }

/** GET /api/hub/jobs 响应(total = 满足过滤的 run 总数,分页用)。 */
export interface HubJobsDTO {
  jobs: HubJobDTO[];
  total: number;
}

/** POST /api/hub/rules + PATCH /api/hub/rules/:roomSlug 的请求体。 */
export interface HubRulePayload {
  /** 房间地址或房间号(归一化解析出 roomSlug);create 必填。 */
  room?: string;
  enabled?: boolean;
  pipeline?: HubPipelineConfig;
  /** 选中的 worker id;present 时后端校验必须为非空 string[]。缺省 = 全部 worker。 */
  workers?: string[];
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
