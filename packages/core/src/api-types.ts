// API 契约 DTO —— 纯类型,前后端单一来源(无运行时依赖,前端 build 时擦除,不拉后端代码)。
// 后端 @drec/app 的 web/api 用它定请求/响应;前端 packages/web 经 alias import 同一份。
import type { OutputFormat } from "./output-format.js";
import type { NotifyEvent, NotifKey, NotifWebhookToggles } from "./notify.js";
export type { NotifyEvent, NotifKey, NotifWebhookToggles };

/** hub 规则 `pipeline.upload.mode` 的取值。`rolling` = 合成并上传 + 录制端边录边传(issue #40)。 */
export type UploadMode = "stage" | "upload" | "rolling";

/**
 * 多节点 hub 后处理配置(按房间)。**独立于录制任务**——录制任务只管录,hub 规则管后处理。
 * hub 是全局管理器,对每个 enabled 的 HubRule(按 roomSlug)执行这份 pipeline。
 */
/**
 * 资源闸门(T15)。真理源 = hub 配置的 `resources` 段(app 的 hub-config-store 负责读写)。
 *
 * **声明放 core**:core 是唯一被 app(L4) 与 orchestrator(L4.5) 都能依赖的层,
 * 放这里才能让「读配置的 app」与「用配置的 orchestrator」共用同一份类型 ——
 * 各写一份必然漂移(字段名/默认值/下限各说各话)。
 */
export interface HubResources {
  /** 烧录/CPU 密集步骤并行度。≥1。默认 1。 */
  maxCpuParallel?: number;
  /** 拉取/上传等网络步骤并行度。≥0(0 = 禁网络并发)。默认 1。 */
  maxNetParallel?: number;
  /** 烧录前要求的最小可用内存 MB。≥0。默认 2048。 */
  minBurnFreeMemMB?: number;
  /** 等内存门的时间上限 ms。≥0。默认 600_000。 */
  memWaitTimeoutMs?: number;
  /** 上传滑动窗口内允许次数。≥1。默认 5。 */
  uploadRateLimit?: number;
  /** 上传滑动窗口长度 ms。≥1。默认 600_000。 */
  uploadRateWindowMs?: number;
  /** 命中 601 后冷却 ms。0 = 显式关(存储不可用时仍有 fail-closed 兜底)。默认 1_800_000。 */
  uploadCooldownMs?: number;
  /** 同时处理的后处理场次上限(T7 派发器消费)。≥1。默认 2。 */
  maxConcurrentPipelines?: number;
}

export interface HubPipelineConfig {
  /**
   * 产出哪些(默认全 true)。
   * - `mergeSegments`(默认 true):整场所有会话/分段合并成**一片** plain 再烧录/上传。
   *   置 false = **不合并**,按录制分段(--segment 时长切出的每个 .ts)逐个产出并上传,
   *   每段 = 一个独立分 P(段间不拼接);开烧录时逐段烧各自那段弹幕。
   * - `burnDanmu` / `burnLivechat`:是否产出对应烧录版(合并模式下 = 整场烧,分段模式下 = 逐段烧)。
   */
  steps?: {
    mergeSegments?: boolean;
    burnDanmu?: boolean;
    burnLivechat?: boolean;
    /**
     * **(实验,缺省 false)** 节点侧上传:该房间**不烧录**时,winner 节点本地 remux →
     * 节点 biliup 直接上传,master 只收 BV 号 → 省掉整场录像 rsync 回传(pull 步)。
     * 需要烧录(burnDanmu/burnLivechat)时本开关**无效**,回落现状(录像回传 master 集中处理)
     * —— burn 是全量重编码,需 11 核 + 中文字体,弱节点(2 vCPU)烧不动(实测 0.38x 实时)。
     * 节点缺 biliup / B站 cookie / 磁盘时也回落现状,并在 job.log 记明原因(不静默失败)。
     */
    nodeSideUpload?: boolean;
    /**
     * **(缺省 false)** `.ts` 直传:节点侧上传时,ffmpeg 引擎产出的 `.ts` 若**单段独占一个分 P**
     * (无需拼接/烧录),不再 remux 成 mp4,直接把源 `.ts`(硬链接)作为上传物。
     * 省掉一份 mp4 与一遍写盘,同一内容在节点上只占一份。mesio 的 `.flv`(时基须钉 90000)与
     * 需要拼接的组仍走 remux。硬链接失败(跨设备)时回落 remux,绝不复制出第二份。
     */
    tsDirect?: boolean;
  };
  /**
   * 分段上传(mergeSegments=false)调优:
   * - `uploadBatchSize`:每批 append 的文件数上限(缺省 1)。B 站按「提交次数」限流(601),
   *   且 biliup 多文件 upload/append 是每文件一次提交——设 1 使每次只提交一个文件,
   *   失败可安全重试;配合全局上传队列的限速。
   * - `minSegmentSec`:跳过短于该秒数的分段(缺省 2)。mesio `--fix` 在流不连续时会切出
   *   0.2s 级、分辨率不同的初始化残片(无有效内容)→ 过滤,避免污染分 P。
   */
  uploadBatchSize?: number;
  minSegmentSec?: number;
  /**
   * **(内部)分段上传的分 P 目标时长(秒)** = 录制任务创建时的分段时长(`segmentSec`)。
   * CLI 从源任务读取后注入,**不在 hub 规则里单独配置** —— 录制时设的分段时长即为上传时的分 P 时长。
   * >0 时,累计接近该值(最多超 20%)的连续段合并成一个 mp4 再上传;<=0 = 逐段上传。
   */
  segmentGroupSec?: number;
  /** 断流重连合并窗(ms):结束距现在不足该窗的场先不处理,等可能的重连并成一簇。缺省 10 分钟。 */
  reconnectWindowMs?: number;
  /** 清理开关(都默认 false)。**永不删 .xml/.ass**(弹幕源硬约束),清理只处理 .ts/.mp4。 */
  cleanup?: { stageSourceAfterMerge?: boolean; sourceAfterDone?: boolean; stageAfterDone?: boolean };
  /**
   * 上传:`mode` = stage(只合成不传)/ upload(传 B站)/ rolling(upload + 录制端边录边传,issue #40);缺省 stage。
   * `private` 仅 mode=upload 时有意义:true(默认)= 仅自己可见,false = 公开。tag/tid/desc 为该稿 metadata。
   * 三者相互独立,**都空着就是现在(历史)的行为**:
   *   1. `titleTemplate`  —— **文件名规则**(stage 产物 stem)。空 = `{name}_{date}`。
   *   2. `submissionTitleTemplate` —— **B 站稿件标题**(整稿的总标题)。空 = 回落 1。
   *   3. `partTitleTemplate` —— **分 P 的视频标题**(P1/P2/P3 各自)。空 = 回落 1(即用文件名当分P名)。
   * 2 与 3 走宽松渲染(B 站标题允许空格/标点/emoji);1 必须是合法文件名。
   * 3 额外可用 `{part}`(序号)/`{parts}`(总数);**类型后缀自动追加**(plain 无 / `_danmu` / `_livechat`),
   *   模板里不需要写类型。
   */
  upload?: {
    mode?: UploadMode; private?: boolean; tag?: string; tid?: number; desc?: string;
    titleTemplate?: string;
    submissionTitleTemplate?: string;
    partTitleTemplate?: string;
  };
}

/** hub 规则里「录制下发」的配置:绑定 master 本地 task,自动同步到选中的 worker 节点。 */
export interface HubRecordingConfig {
  /** master 本地任务的 id(身份跨节点仍是 (platform, roomSlug));null/缺省 = 不下发。 */
  sourceTaskId?: number | null;
}

/**
 * **统一房间视图**(T9):一次读写「录制(task)+ 处理(hub 规则)」两半。
 *
 * 为什么要它:同一个房间的配置今天分散在 `GET /api/tasks` 和 `GET /api/hub/rules` 两个域,
 * 前端改一个房间要**连写两个接口** —— 中间任何一步失败就留下「画质改了但处理没改」的
 * 半成功状态,且用户看不出是哪半边生效了。本 DTO 让一个房间成为**一个可读写单元**。
 *
 * ⚠️ 物理存储**不变**:两半仍分别落在 tasks 表与 `config/hub/{key}.json`(不迁数据、不动 schema),
 * 本 DTO 只是读写的**聚合视图**。旧的 `/api/tasks` 与 `/api/hub/rules` 端点全部保留可用。
 */
export interface RoomRecordingDTO {
  /** master 本地任务 id;null = 尚未绑定录制任务(只配了处理)。 */
  taskId: number | null;
  room: string;
  name: string | null;
  anchorName: string | null;
  quality: string;
  engine: string;
  danmu: number;
  segmentSec: number;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  enabled: boolean;
  useCookie: boolean;
  /** cookies 是敏感值:**永远不外发**,仅 PUT 时可写。DTO 里恒为 null。 */
  cookies: null;
  outDir: string | null;
  webhook: string | null;
  /** **旧**边录边传开关(T-33):已迁到 hub 规则 `pipeline.upload.mode="rolling"`(issue #40);仅作旧值只读/迁移来源。 */
  rollingUpload: boolean;
  /** 边录边传**实际生效值**(master 按规则 + 旧开关算出的只读派生字段;见 core `resolveRollingPolicy`)。 */
  rollingEffective: boolean;
  /** 输出格式(issue #137,缺省 original);投稿形态下后处理产物恒 mp4(见 core `effectiveStageFormat`)。 */
  outputFormat: OutputFormat;
}

export interface RoomDTO {
  /** `{platform}.{roomSlug}`,与 hub 规则 key 同形(跨平台不撞)。 */
  key: string;
  platform: string;
  roomSlug: string;
  room: string;
  /** 录制半边。 */
  recording: RoomRecordingDTO | null;
  /** 处理半边(与 HubRuleDTO 同字段;没有规则时 = null,而不是一个空对象)。 */
  processing: Omit<HubRuleDTO, "key" | "platform" | "roomSlug" | "room"> | null;
}

/**
 * PUT /api/rooms/:key 的入参。**两半都是可选的** —— 只传 `recording` 就只改录制,
 * 只传 `processing` 就只改处理(前端可以分步保存)。
 *
 * 写入顺序与原子性见 web/api/rooms.ts:**先写 task,再写规则;第二步失败回滚第一步**,
 * 绝不留下半成功。
 */
export interface RoomPayload {
  recording?: Partial<Omit<RoomRecordingDTO, "taskId" | "cookies">> & { cookies?: string | null };
  processing?: Partial<Pick<HubRuleDTO, "enabled" | "pipeline" | "workers" | "requires">>;
}

/** 一条 hub 规则(GET /api/hub/rules)。按平台限定,持久化为 <root>/config/hub/{platform}.{roomSlug}.json。 */
export interface HubRuleDTO {
  /** `{platform}.{roomSlug}` —— 全局唯一 id(文件名 stem + API 路由参数;跨平台不撞)。 */
  key: string;
  /** 房间 ID(web_rid);单平台内唯一。 */
  roomSlug: string;
  /** 显示用房间地址(新规则取自关联 source task;遗留文件自带 room 字段)。 */
  room: string;
  platform: string;
  /** 规则启用?false = 暂停该房间的 hub 处理。 */
  enabled: boolean;
  /** 流水线配置(steps / upload / cleanup);upload 是 pipeline 的一个阶段。 */
  pipeline: HubPipelineConfig;
  /** 边录边传判定结果 + 原因(core `resolveRollingPolicy`,issue #48:烧录开着 → needs-burn)。 */
  rollingPolicy?: { effective: boolean; reason: string };
  /** 选中参与该房间 hub 处理的 worker id;缺省/空 = 全部 worker(向后兼容)。 */
  workers?: string[];
  /**
   * 该房间需要的 worker 能力(能力门控);非空时只派给 `capabilities ⊇ requires` 的 worker,
   * 与 `workers` 取交集。缺省/空 = 无要求。例:`["danmu:douyin"]`。
   */
  requires?: string[];
  /** 录制下发配置(sourceTaskId 非空 → hub 把该 task 同步到 workers 勾选的节点)。 */
  recording?: HubRecordingConfig;
  /** 关联的 master 录制任务显示投影(由后端按 recording.sourceTaskId 解析;无则 null)。 */
  sourceTask?: {
    id: number;
    room: string;
    name: string | null;
    anchorName: string | null;
    enabled: boolean;
  } | null;
  /** 主播名(若有同 roomSlug 的录制任务/录像可关联显示);未知 null。 */
  anchorName?: string | null;
  /** 用户自定义的任务名称(task.name;主播名称);与 anchorName 独立,用于「名称 · 主播名」双行显示。未配置则 null。 */
  taskName?: string | null;
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
  /**
   * select / pull / node_upload / merge / burn_danmu / burn_livechat / upload_plain /
   * append_danmu / append_livechat / clean_*。
   * `node_upload` = 节点侧上传(节点本地 remux + 上传,无回传),与常规 pull 区分开。
   */
  step: string;
  /** start | done。 */
  phase: string;
  at: number;
  /** 该步真实信息(done 事件才有;旧库无 → 缺省)。 */
  detail?: string;
}

/** 单个 workflow 节点的安全阀状态(UI 单节点重跑入口的数据源)。 */
export interface HubJobNodeStateDTO {
  /** merge / burn_danmu / burn_livechat / upload_plain / append_danmu / append_livechat / clean_* / node_upload。 */
  node: string;
  /** pending / running / done / failed / blocked / skipped。 */
  state: string;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

/** 某场某节点的选优候选(流程图 select 步的 fan-in 节点)。worker=节点 id(前端映射友好名)。 */
export interface HubJobCandidateDTO {
  /** 录制节点(worker)id。 */
  worker: string;
  /** 覆盖度 0..1(=1−gap/span);前端显示 %。 */
  coverage: number;
  /** 该节点录到的视频总时长(秒)。 */
  durationSec: number;
  /** 该节点本场弹幕条目数(弹幕+礼物+入场)。0 = 无弹幕/仅表头空 xml;null/缺省 = 未统计(旧库)。 */
  danmuCount?: number | null;
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
  /** 单节点状态(workflow 安全阀;空=旧 run,前端回落 steps 推导)。 */
  nodeStates: HubJobNodeStateDTO[];
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
export interface WorkerDTO { id: string; name: string; kind: string; host?: string; dataRoot?: string; apiUrl?: string; capabilities?: string[] }

/** worker 连接测试结果(POST /api/hub/workers/test)——轻量 ping:可达 + dataRoot 存在。 */
export interface WorkerTestResult {
  ok: boolean;
  error?: string;
  /**
   * 被探测节点的稳定身份 id(`_node-id` → `<dataRoot>/config/node.json`)。旧 bundle / 不可达 → 缺省。
   * UI「添加节点」用它作为 worker id(而非自分配 `worker-N`)→ 同机器永远同一 id。
   */
  nodeId?: string;
  /** 节点主机名(仅显示提示)。 */
  hostname?: string;
}
/** GET /api/hub/workers/status 的单个 worker 健康结果(批量 ping)。 */
/**
 * 节点应用回执(T16):`_node-status` 的输出。
 *
 * 为什么需要:master 只能看到「我下发了什么」,看不到「节点应用了没有、用的哪个版本的应用」。
 * 三种故障落在盲区里 —— ① master 发了第 7 版期望,节点只应用到第 5 版(中间某轮失败);
 * ② 节点 bundle 是旧版(部署漏了一台),新语义在它上面不生效;
 * ③ 同步一直失败,只有一行 warn 日志,UI 毫无痕迹。
 */
export interface NodeStatus {
  /** 该节点**当前运行**的 bundle 版本。 */
  appVersion: string;
  /** 已应用的期望版本号;null = 从未成功同步过。 */
  appliedVersion: number | null;
  /** 该次应用的时间(epoch ms);null = 从未成功同步过。 */
  appliedAt: number | null;
  /** 应用那版期望时节点跑的 bundle 版本(与 appVersion 不同 → 之后升级过)。 */
  appVersionAtApply: string | null;
  /** 节点任务总数 / 其中 hub 受管数。 */
  taskCount: number;
  managedCount: number;
  /** 处理任务表活动快照(plans/036 T3;旧 bundle 无此字段 → 旧 master 忽略 / 新 master 视为未知)。 */
  procActive?: ProcActiveDTO;
}

export interface WorkerStatus {
  id: string;
  ok: boolean;
  error?: string;
  /**
   * 节点应用回执(T16,可选;旧 bundle / 探测失败 → 省略)。
   * `appliedVersion` 与 `expectedVersion` 不一致 → 期望没应用到;
   * `appVersion` 与 master 版本不一致 → 节点 bundle 版本漂移(部署漏了一台)。
   */
  appVersion?: string;
  appliedVersion?: number | null;
  appliedAt?: number | null;
  /** master 侧本轮下发的期望版本(单调递增)。 */
  expectedVersion?: number;
  /** 同步失败原因(有则说明「下发到了但应用失败」)。 */
  syncError?: string;
  /** 节点数据根所在卷剩余空间(GB,F2;旧 bundle / 探测失败 → 省略)。 */
  diskFreeGB?: number;
  /** master 的磁盘水位(GB,与磁盘看门狗同源);0 = 已关闭。 */
  diskMinGB?: number;
}

/** GET /api/hub/jobs 响应(total = 满足过滤的 run 总数,分页用)。 */
export interface HubJobsDTO {
  jobs: HubJobDTO[];
  total: number;
}

/**
 * master 资源池的实时占用快照(GET /api/hub/queue 内嵌)。
 * 目的:区分「执行中」与「排队等锁」——`state=merging` 的 job 可能实际还阻塞在 cpu/upload 闸门。
 * 数据来自 orchestrator 的 ResourcePool(进程内共享),由 CLI 注入;slave/未开 hub → 全 0。
 */
export interface HubPoolSnapshotDTO {
  cpu: { active: number; queued: number; max: number };
  net: { active: number; queued: number; max: number };
  upload: {
    /** 正在执行的提交数(0/1,上传链串行)。 */
    active: number;
    /** 已进入上传链、等待执行的提交数。 */
    queued: number;
    /** 601 冷却截止(epoch ms;0=无冷却)。 */
    cooldownUntil: number;
    /** 当前窗口内已提交次数。 */
    windowUsed: number;
    /** 窗口提交上限(0=不限速)。 */
    windowLimit: number;
    /** 最早一次提交滑出窗口的时刻(epoch ms;0=窗口空)。 */
    windowResetAt: number;
  };
  /** 正在等锁的场(streamKey + 资源 + 该资源队列内的位次,1-based)。 */
  waiting: Array<{ streamKey: string; resource: "cpu" | "net" | "upload"; position: number; since: number }>;
}

/**
 * 队列页一行的相位。**进行中与已完成同表**(像日志一样一条时间轴连续排列):
 * - `running` / `queued` / `waiting_settle` / `waiting_manual`:进行中(未完成)
 * - `done`:已完成(`state=done`,成功收口)
 * - `failed`:失败终态(与 done 同表,红色区分)
 * 注意:UI 的「拉取中」是**前端派生**显示相(`state=syncing` 且不占资源闸门),不属于后端相位 ——
 * 要筛它请用 `states=syncing`。
 */
export type QueuePhase =
  | "queued" | "running" | "waiting_settle" | "waiting_manual" | "done" | "failed"
  /**
   * `needs_manual` 细分三态(避免「正常收口」和「真故障」同色 → 告警疲劳):
   * - `waiting_upload`:stage 模式正常收口(`error === STAGE_READY`),**非故障**,中性色;
   * - `stopped`:用户主动停止,灰;
   * - `waiting_manual`:其他 needs_manual(重试耗尽 / 进程重启中断 / 上传失败…),红。
   */
  | "waiting_upload" | "stopped";
/**
 * 相位常量数组(API 侧校验 query 的白名单;前端筛选器也用它渲染选项)。
 */
export const QUEUE_PHASES = [
  "running", "queued", "waiting_settle", "waiting_manual", "done", "failed",
  "waiting_upload", "stopped",
] as const;

/**
 * 处理队列里的一场直播(GET /api/hub/queue → active[])。
 * 一屏回答:做了什么(doneSteps)/ 正在做什么(state + phase + 时长 + ETA)/ 下面做什么(nextSteps)。
 */
export interface QueueItemDTO {
  streamKey: string;
  platform: string;
  roomSlug: string;
  anchorName: string | null;
  /** 当前 pipeline 状态(= 当前粗粒度 step)。 */
  state: string;
  phase: QueuePhase;
  /** 当前节点使用的资源(排队判定/展示用);非资源节点/未知 → null。 */
  resource: "cpu" | "net" | "upload" | null;
  /** phase=queued 时该资源队列内的位次(1-based);否则 null。 */
  queuePosition: number | null;
  /** 当前节点名(merge / burn_danmu / upload_plain / node_upload …);未知 → null。 */
  currentNode: string | null;
  /** 已完成子步骤(升序;做了什么)。 */
  doneSteps: HubJobStepDTO[];
  /** 后续待跑节点(按 DAG 顺序;下面做什么)。 */
  nextSteps: string[];
  /** 当前步已运行秒数(终态 = null)。 */
  currentStepSec: number | null;
  /** 当前步预计剩余秒数(粗估;无依据 = null)。 */
  etaSec: number | null;
  winnerWorker: string | null;
  fails: number;
  updatedAt: number;
  /**
   * 失败/待人工的原因(台账 `sync_jobs.error`)。null/空 = 无错误。
   * **语义区分靠它**:
   *  - `error === STAGE_READY` + `state=needs_manual` → **stage 模式正常收口**(存档待人工上传,非故障);
   *  - `error === "用户停止"` → 用户主动停止;
   *  - 其他非空 → 真故障(重试耗尽 / 进程重启中断 / 上传失败…)。
   */
  error: string | null;
  /** 完成态(`phase=done`)才有:B 站 BV 号 —— 已上传的稿可直接点开。 */
  bv: string | null;
  /** 完成态才有:winner 视频时长秒(展示用)。 */
  videoDurationSec: number | null;
  /** **收尾时刻**(epoch ms)= 终态事件的时刻;非终态 = null。日志按时间轴排时用它。 */
  finishedAt: number | null;
  /**
   * **入队时刻**(epoch ms)= 该场 job 首个事件(`pending`)的时刻,台账里有就一定有。
   * 队列页的默认排序键:真实 FIFO —— 谁先进队列谁排前面,与 phase/updatedAt 无关。
   * null = 旧库缺事件表(极老 run),此时回落 updatedAt。
   */
  enqueuedAt: number | null;
}

/**
 * GET /api/hub/queue 响应。
 *
 * **rows 是唯一列表**:进行中与已完成同表(像日志一条时间轴),`rows` 已按 sort 方向排好。
 * 前端渲染一张表即可,不必分区块 —— 完成的行带 `phase=done`/`failed` + bv。
 *
 * `recent` 保留为**兼容字段**(RoomDetail 等旧调用方仍用),内容 = 最近完成的完整 HubJobDTO。
 */
/**
 * 边录边传的实时交付进度(controller 视图,F1)。由各节点的状态轮询带回,**不经过台账**:
 * 边录边传由录制节点自己建稿 / 追加 / 删源,master 要等收播后的对账才建 job,期间队列页原本一片空白。
 * 只读展示,不参与任何上传 / 删源判定。
 */
export interface RollingDeliveryDTO {
  workerId: string;
  workerName: string;
  platform: string;
  roomSlug: string;
  /** 主播名(master 侧按房间补;未知 = null)。 */
  anchorName: string | null;
  sessionBase: string;
  /** 已建稿的 BV;尚未建稿 = null。 */
  bv: string | null;
  /** 已确认上传的分 P 数。 */
  confirmed: number;
  /** 本会话已封口 / 登记的分段总数(含已确认并删源的)。 */
  total: number;
  /** 结果未知、需人工核对的分段数。 */
  ambiguous: number;
  /** 正在传的分段(无 = null)。 */
  uploading: { index: number; kind: "create" | "append" } | null;
  /** 该房间此刻是否仍在录制(false = 已收播但仍有未决项)。 */
  recording: boolean;
  /** 本条状态的核对时刻(epoch ms)。 */
  checkedAt: number;
  /** 未确认分段仍占用的磁盘字节(F2;旧节点 bundle 缺省 = 未知)。 */
  lockedBytes?: number;
}

export interface HubQueueDTO {
  /** 边录边传的实时进度(F1;旧 master / 无节点上报时缺省)。 */
  delivering?: RollingDeliveryDTO[];
  /**
   * 进行中(非终态 ∪ **真事故的** needs_manual)。
   * 与 `rows` 的差别:`rows` 还含 stage 模式正常收口(`phase=waiting_upload`,非故障)与终态行。
   */
  active: QueueItemDTO[];
  /** 统一列表:进行中 + 已完成,按 sort(newest 缺省=最新在前)排好,前端渲染一张表。 */
  rows: QueueItemDTO[];
  /** 最近完成的完整视图(兼容旧调用方;与 rows 里 phase=done/failed 的部分同源)。 */
  recent: HubJobDTO[];
  pool: HubPoolSnapshotDTO;
}

/** POST /api/hub/rules + PATCH /api/hub/rules/:roomSlug 的请求体。 */
export interface HubRulePayload {
  /** 遗留兼容:旧创建接口传 room。新创建不再需要,房间由 recording.sourceTaskId 派生。 */
  room?: string;
  enabled?: boolean;
  pipeline?: HubPipelineConfig;
  /** 选中的 worker id;present 时后端校验必须为非空 string[]。缺省 = 全部 worker。 */
  workers?: string[];
  /** 房间需要的 worker 能力(能力门控);present 时与 workers 取交集。缺省 = 无要求。 */
  requires?: string[];
  /** 录制下发配置(sourceTaskId → hub 自动同步到选中节点)。 */
  recording?: HubRecordingConfig;
}

/** 单个 node 上的任务投影(`_tasks` 隐藏子命令输出,永不含 cookies)。 */
export interface NodeTaskDTO {
  id: number;
  platform: string;
  roomSlug: string;
  room: string;
  name: string | null;
  quality: string;
  engine: string;
  danmu: number;
  segmentSec: number;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  status: string;
  useCookie: boolean;
  enabled: boolean;
  outDir: string | null;
  webhook: string | null;
  managedBy: string | null;
  anchorName: string | null;
  /** **旧**边录边传开关(见 plans/031 / T-33;已迁到 hub 规则,issue #40)。 */
  rollingUpload: boolean;
  /** 边录边传实际生效值(派生,只读)。 */
  rollingEffective: boolean;
  /** 输出格式(issue #137);旧节点包不返回 → 视为 original。 */
  outputFormat?: OutputFormat;
}

/**
 * GET /api/hub/workers/:id/tasks 的响应(F3):该节点上的任务清单(node 的隐私安全投影,无凭证)。
 * 供 controller 的「节点日志」对话框列出可查的任务。
 */
export interface NodeTasksDTO {
  workerId: string;
  tasks: NodeTaskDTO[];
  /** 拿不到清单的原因(节点不可达 / 该节点类型不支持)。有值时 tasks 为空。 */
  error?: string;
}

/** GET /api/hub/workers/:id/tasks/:taskId/logs 的响应(F3,只读)。 */
export interface NodeTaskLogsDTO {
  workerId: string;
  taskId: number;
  lines: string[];
  /**
   * 拿不到日志的原因(节点不可达 / 旧 bundle 无该命令 / 节点 serve 未起 / 节点上无此任务)。
   * 有值时 `lines` 为空 —— UI 原样展示,不当成「无日志」。
   */
  error?: string;
}

/** master → node 的期望任务(applyTasks;含 cookies,只走可信 ssh/本地通道)。 */
export interface RemoteTaskSpec {
  platform: string;
  roomSlug: string;
  room: string;
  name: string | null;
  quality: string;
  engine: string;
  danmu: number;
  segmentSec: number;
  scheduleStart: string | null;
  scheduleEnd: string | null;
  enabled: boolean;
  useCookie: boolean;
  cookies: string | null;
  outDir: string | null;
  webhook: string | null;
  anchorName: string | null;
  /**
   * 归属标记(issue #73):master 按 core `isWorkerAssigned` 判定「该房间是否派给本节点」。
   * false = 已停用保留(取消勾选/规则停用/能力不满足),节点列表默认隐藏(在录除外);
   * 缺省(旧 master)= 视为归属,全显示(旧行为)。旧节点包忽略此字段。
   */
  assigned?: boolean;
  /**
   * 边录边传开关(旧字段,见 plans/031 / T-33)。**远端节点:恒等于 `rollingEffective`**(兼容尚不认识
   * 新字段的旧节点包 —— 它们只读这个字段,行为同改前);本机(local)任务:原样透传源任务的旧开关(用户旧值)。
   */
  rollingUpload: boolean;
  /**
   * 边录边传**实际生效值**(master 用 core `resolveRollingPolicy` 一次算出,issue #40);录制端只读它。
   * 可选:旧 master 不下发 → 节点回落 `rollingUpload`(旧行为)。
   */
  rollingEffective?: boolean;
  /**
   * 输出格式(issue #137)。可选:旧 master 不下发 → 节点按 `original`;旧节点包不认识该字段则忽略
   * (继续原样输出)。非白名单值节点一律按 `original`(不抛、不拒绝整批)。
   */
  outputFormat?: OutputFormat;
  /**
   * **可选提示**:master 明确要求「这个房间可以删了」(规则文件已消失 / sourceTaskId 解绑)。
   *
   * 默认**忽略**(DREC_EXPLICIT_DELETE 默认关):删除判定仍以「节点 store 受管任务 − 期望 keys」
   * 为准(T3),这样 master 一次配置读失败不会立刻清空节点。只有在节点上设
   * `DREC_EXPLICIT_DELETE=1` 时才采信本字段 —— 用于「规则已删,不必等两阶段」的显式场景。
   */
  deleted?: boolean;
}

/**
 * 节点侧上传(experimental,见 plans/027):master → 节点 的隐藏子命令 `_node-pipeline` 入参。
 * 节点本地 remux(可选逐段)→ biliup 上传 → 回传 BV。**不含视频回传**(这正是省掉 rsync 的关键)。
 */
export interface NodePipelineSpec {
  streamKey: string;
  /** winner 节点上该场的源文件(绝对路径,节点本地):.ts/.flv 段 + 可选 .xml。 */
  tsFiles: string[];
  xmlPath?: string;
  /**
   * 本场**直播标题**(master 从 `{base}.session.json` 读到的最早会话标题)。
   *
   * 为什么要下发:节点侧同样需要渲染 `{title}`(`submissionTitleTemplate` 常用),
   * 而节点上**没有** inventory / session.json(那些在 master 的 recordings 里),
   * 只靠文件名推不出来 → 不发就会出现 `"114275050882_2026-10-11_ 直播回放"` 这种空标题。
   */
  liveTitle?: string;
  /**
   * 本场**开播时刻**(epoch ms,取最早会话;master 的 inventory 权威值)。
   * 节点侧没有精确 startMs,兜底用文件 mtime 会让 `{HH}-{mm}-{ss}` 渲染成**上传时刻**。
   */
  startMs?: number;
  /**
   * 本场各会话 base(按会话序)。节点侧据此渲染与 master 同源的 `{name}/{date}`;
   * 缺省 = 从文件名推第一个段所属会话。
   */
  sessionBase?: string;
  /** 分 P 目标时长(秒);>0 = 按累计时长聚组(与 master 侧 segmentGroupSec 同义)。 */
  segmentGroupSec?: number;
  /** 分段模式(不合并,逐段产出):与 master 侧 steps.mergeSegments=false 同义。 */
  mergeSegments: boolean;
  /** `.ts` 直传:见 HubPipelineConfig.steps.tsDirect。缺省 false。 */
  tsDirect?: boolean;
  /** 上传模式:upload = 建稿上传;stage = 只合成不上传(留节点)。 */
  uploadMode: "stage" | "upload";
  /** 节点上产物落地目录(节点本地,通常 = 该节点 dataRoot/stage)。 */
  stageDir: string;
  uploadMeta: {
    tag: string; tid: number; desc?: string;
    titleTemplate?: string;
    submissionTitleTemplate?: string;
    partTitleTemplate?: string;
  };
  uploadPrivate: boolean;
  timeZone?: string;
  minSegmentSec?: number;
  /** master 下发的 B站 cookie(可选兜底);节点本地已有 cookies.json 时优先用本地的。 */
  cookies?: string;
  /** 完成后是否清理节点源文件(与 master 侧 cleanup.sourceAfterDone 同义)。 */
  cleanSourceAfterDone?: boolean;
  /**
   * master 侧 `cleanup.stageAfterDone` —— 决定节点源 `.xml` 的**去留**。
   *
   * `.xml` 不可再生,规则是**「两处永不同时删光」**(见 pipeline.ts `xmlKeepRule`):
   *   - stageAfterDone=true(清空 stage)→ 节点源 xml 是**最后一份** → **必须保留**;
   *   - stageAfterDone=false(stage 保留副本)→ 节点源 xml 可随源一起删。
   * 节点侧**不传 stagePulledSources**(录像从不回传 master)⇒ stage 侧永远没有副本,
   * 所以节点分支**只有** `stageAfterDone=false` 才允许删 xml。漏了这条会把唯一一份弹幕删掉。
   */
  cleanStageAfterDone?: boolean;
}

/** 节点侧上传结果(`_node-pipeline` 的 JSON 输出)。 */
export interface NodePipelineResult {
  ok: boolean;
  /** 建稿成功后的 BV 号(ok 且 uploadMode=upload 时非空)。 */
  bv?: string;
  /** 产物路径(节点本地;stage 模式或调试用)。 */
  products?: string[];
  /** 失败原因(ok=false)。 */
  error?: string;
}

/**
 * 节点侧上传的**落盘结果文件**(`<root>/stage/<sanitizeStreamKey>/.drec-node-result.json`)。
 *
 * 为什么需要它(master 侧「假失败」的根因修复):`_node-pipeline` 是一条**长命令**
 * (整场 remux + 上传,实测 >30min)。ssh 连接在命令跑完前**断开**(tailscale stall /
 * ServerAlive 判死)时,master 只看到 `ssh rc=255`,而节点上的上传**其实已经建稿成功**
 * (实测:BV 已建、private、4 分 P)—— master 误判 failed → reconciler 翻 `needs_manual`
 * → 源不删、人工待办堆积。**回读这个文件**才能把「真失败」与「回传断了但已成功」分开。
 *
 * 与 `NodePipelineResult` 的区别:那个是命令 stdout 的**即时回包**(断了就没有);
 * 这个是节点**落盘**的权威结果,不依赖 ssh 是否还活着。
 */
export interface NodePipelineResultFile {
  /**
   * 阶段。**单调**:started → uploading → done/failed(一旦推进不回退)。
   *   - `started` —— 节点执行体**刚接管、进入 remux 之前**就落盘(issue #2「尽早落盘」)。
   *     此刻**尚未调用 biliup**,故无 建稿 风险。master 据此区分「真的没开始建稿」与
   *     「已进入上传窗口(可能已建稿)」:
   *       · 读到 `started` 且 master **已确认终止节点执行体**(abort 非降级)→ 判「确认没成」;
   *       · 读到 `started` 但 **无法确保终止**(旧 bundle / 不可达,降级)→ 执行体可能仍在跑、
   *         稍后会写 `uploading` 并建稿 → 保守判「结果不确定」转人工,**绝不自动重传**。
   *   - `uploading` —— 已进入 biliup 上传循环前落盘(可能已建稿)→ **结果不确定**,绝不自动重传;
   *   - `done` / `failed` —— 收尾终态(done 带 bv 即成功;failed 带 bv 即「已建稿、绝不重传」)。
   */
  phase: "started" | "uploading" | "done" | "failed";
  /** phase=done 时是否成功(与 NodePipelineResult.ok 同义)。 */
  ok: boolean;
  /** 建稿成功后的 BV 号(ok 时非空)。 */
  bv?: string;
  /** 产物路径(节点本地)。 */
  products?: string[];
  /**
   * 已**确认**落到稿件里的分 P 数(建稿成功 = 1,每次 append 成功后 +1)。issue #25 ②:BV 与进度在
   * 建稿 / 追加成功的**当下**就落盘,执行体被 ssh 超时 / SIGKILL 杀掉时 master 仍能回读到 BV 与进度,
   * 不再出现「B站已有稿件而台账没有任何 BV」。旧 bundle 不写 → 缺省 = 未知。
   */
  confirmedParts?: number;
  /** 正要追加的分 P 序号(1 起):**追加前**先写意图;`intentPart > confirmedParts` 表示该次追加结果未知。 */
  intentPart?: number;
  /** 失败原因(ok=false)。 */
  error?: string;
  /** 结果写入时刻(epoch ms;master 用它判断结果是否属于本次执行)。 */
  atMs: number;
}

/**
 * 节点侧落盘结果文件**合法的 phase 白名单**(唯一真理)。
 *
 * ⚠️ issue #2:phase 判定曾在**两处各写一份**(app 的 `readNodeResult` 与 ssh transport 的
 * `nodeResult`),新增 phase 时漏改一处就会被「当 null 吞掉」→ 回读失效。现统一走
 * {@link normalizeNodeResultFile},两处共用同一实现,新 phase 只需加到本数组。
 */
export const NODE_RESULT_PHASES: readonly NodePipelineResultFile["phase"][] = ["started", "uploading", "done", "failed"];

/**
 * 把**任意来源**的节点结果对象(JSON.parse 出的 partial / null / 非对象)归一为可信的
 * {@link NodePipelineResultFile},或 `null`(phase 非法 / 不是对象 → 绝不当成权威结果)。
 *
 * 单一真理:字段裁剪口径(bv/products/error 类型守卫、atMs 缺省 0)在此**唯一实现**;
 * app 侧读盘与 master 侧 ssh 回读都调用它,杜绝两处判定漂移。
 */
export function normalizeNodeResultFile(parsed: unknown): NodePipelineResultFile | null {
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Partial<NodePipelineResultFile>;
  if (!NODE_RESULT_PHASES.includes(p.phase as NodePipelineResultFile["phase"])) return null;
  return {
    phase: p.phase as NodePipelineResultFile["phase"],
    ok: p.ok === true,
    bv: typeof p.bv === "string" ? p.bv : undefined,
    products: Array.isArray(p.products) ? p.products : undefined,
    confirmedParts: Number.isInteger(p.confirmedParts) && (p.confirmedParts as number) >= 0 ? p.confirmedParts : undefined,
    intentPart: Number.isInteger(p.intentPart) && (p.intentPart as number) >= 1 ? p.intentPart : undefined,
    error: typeof p.error === "string" ? p.error : undefined,
    atMs: typeof p.atMs === "number" ? p.atMs : 0,
  };
}

/** 节点侧上传能力探测(`_node-capabilities` 的 JSON 输出)。 */
export interface NodeCapabilities {
  /** 节点上 biliup 可用? */
  biliup: boolean;
  /** 节点上有可用 B站 cookie? */
  cookies: boolean;
  /** 节点 dataRoot 所在卷剩余 GB。 */
  diskFreeGB: number;
  /** 节点上是否有中文字体(烧录用;节点侧分支不烧,仅诊断展示)。 */
  cjkFonts?: boolean;
  /** 节点已注册的处理器 kind 列表(plans/036);缺字段 = 旧节点,派发方按「不支持」处理。 */
  processors?: string[];
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
  /**
   * **已弃用**(issue #40):边录边传开关改在 hub 规则 `pipeline.upload.mode="rolling"`。
   * 仍接受旧客户端写入(迁移来源:旧开关 true 且规则未配置 ≡ rolling),Web 表单不再提交。
   */
  rollingUpload?: boolean;
  /** 输出格式(issue #137);服务端本就接受该字段,此前只是没写进 DTO 类型。 */
  outputFormat?: OutputFormat;
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

/**
 * 抖音取流/弹幕用的 API 模式(全局设置 `settings.douyinApiMode`)。
 *
 * ⚠️ **值域的唯一真理源就是本文件的 `DOUYIN_API_MODES`。** 消费方(设置 API、UI 下拉、
 * `douyin-live` 的 env 读取)一律走 `normalizeDouyinApiMode`,**不得各自再写一份白名单** ——
 * 否则新增模式时会出现「这里加了、那里没加」的静默不一致。
 *
 * - `balance`(**默认**):自动挑 api type(按 priority + 加权随机),失败端点自动禁用/自愈。
 *   实测三环境(家宽/VPS1/VPS2)均能拿到 liveId + 流,VPS 上会自动摘掉被风控的 `webHTML`。
 * - `web`:固定走 `webcast/room/web/enter`(带 a_bogus 签名)。最稳、不依赖房间 HTML 页;
 *   但在开播切换瞬间可能返回**陈旧 liveId**(历史踩坑)。
 * - `webHTML`:固定走房间 HTML 页(render_data)。liveId 最准(始终当前场),但**出口 IP 被
 *   argus 风控时返回验证码中间页** → 整场拿不到 liveId(且取流恒 streams=0,只能用于弹幕)。
 * - `mobile`:固定走 `webcast.amemv.com reflow/info`。需 sec_uid(自己拿不到,靠其他端点缓存)。
 * - `random`:每次调用随机挑一个(等权)。调试用,不建议长期。
 */
export const DOUYIN_API_MODES = ["balance", "web", "webHTML", "mobile", "random"] as const;
export type DouyinApiMode = (typeof DOUYIN_API_MODES)[number];
/** 默认 API 模式(未设置时)。 */
export const DEFAULT_DOUYIN_API_MODE: DouyinApiMode = "balance";
/** 校验:任意输入 → 合法 DouyinApiMode(非法/空 → 默认值)。 */
export function normalizeDouyinApiMode(v: unknown): DouyinApiMode {
  const s = String(v ?? "").trim();
  return (DOUYIN_API_MODES as readonly string[]).includes(s) ? (s as DouyinApiMode) : DEFAULT_DOUYIN_API_MODE;
}

/**
 * 任务「输出格式」被锁的原因(唯一定义;后端 `nodeOutputFormatLock` 产出,TaskDTO / app web DTO / 前端共用)。
 * `no-survivors` = 规则使收尾后节点与 stage 都不留任何源视频(格式无处可用;plans/036 T9b 起由后端产出)。
 * `hub-rule` = enabled 规则仅按房间键命中、但本任务不是规则的源任务(收尾转格式只认源任务的格式,本任务所选格式不生效)。
 * T9b 起:本任务就是规则源任务时封口仍不转换、但改由收尾后转换,不再锁。
 */
export type OutputFormatLock = "hub-managed" | "hub-rule" | "rolling" | "no-survivors";

/** GET /api/tasks[] 的任务响应(含 live 运行态;不含敏感 cookies)。 */
export interface TaskDTO {
  id: number;
  /** 平台 id(douyin / bilibili / kuaishou / ...)。由创建/改 room 时按 urlPattern 重判。 */
  platform: string;
  room: string;
  name: string | null;
  /** hub 受管标记:null=手动,'hub'=由 master hub 下发管理(禁止编辑/删除)。 */
  managedBy: string | null;
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
  /**
   * 硬停收尾中(已发停止信号、进程尚未退出;rolling 任务在传末段,最长约 10 分钟)。
   * UI 用它显示「停止中」并禁用「启动」,避免超时返回后被误当成没停。
   */
  stopping?: boolean;
  /** Hub 源任务在被选中 worker 上的录制状态;普通任务为空数组。 */
  recordingWorkers?: RecordingWorkerStatusDTO[];
  /** issue #73:master 判定的归属标记。false=受管但未派给本节点(停用保留);省略=视为归属。 */
  assigned?: boolean;
  /**
   * 该任务绑定的 hub 规则摘要(仅 master、且该房间有规则时才有)。
   * 让任务列表能显示「这个任务的后处理配了什么 / 上次结果」,并从列表跳到 hub 房间页。
   * 省略 = 未绑定 / 非 master。
   */
  hubRule?: {
    /** hub 规则 key(`{platform}.{roomSlug}`),用于跳 `/hub/{key}`。 */
    key: string;
    /** 规则是否启用。 */
    enabled: boolean;
    /** 产出哪些步骤(plain 恒有;danmu/livechat 按配置)。 */
    steps: string[];
    /** 上传模式:stage(仅合成)/ upload(传 B 站;rolling 也计 upload —— 只是上传时机提前)。 */
    uploadMode: "stage" | "upload";
    /** 最近一次 run 的状态 + BV(无 run = null)。 */
    lastRun: { state: string; bv: string | null } | null;
  };
  /** 任务专属 Discord webhook;null = 回落全局。 */
  webhook: string | null;
  /** **旧**边录边传开关(T-33):已迁到 hub 规则 `pipeline.upload.mode="rolling"`(issue #40),仅作旧值只读。 */
  rollingUpload: boolean;
  /** 边录边传实际生效值(派生,只读)。 */
  rollingEffective: boolean;
  /** 输出格式(issue #137,缺省 original)。 */
  outputFormat: OutputFormat;
  /**
   * 输出格式被锁的原因(后端 `nodeOutputFormatLock` 判定,与实际是否替换同源);省略 = 不锁。
   * 前端只据此锁定下拉并显示原因,不再自己判 hub 状态;旧后端无此字段 → 按「不锁」降级。
   */
  outputFormatLock?: OutputFormatLock;
  /** 在跑录制进程 spawn 时实际带的边录边传值(issue #89);进程没在跑则省略。 */
  rollingApplied?: boolean;
  /** 在跑进程的启动参数与 `rollingEffective` 不一致 → 待(空闲后)重启生效(issue #89);无漂移/没在跑则省略。 */
  rollingPending?: boolean;
}

/** 详情页 live runtime(GET /api/tasks/:id)。 */
export interface TaskRuntime {
  running: boolean;
  startedAt: number | null;
  elapsedMs: number | null;
  anchorName: string | null;
}

/** Hub 任务在每个目标录制节点上的实时状态。 */
export interface RecordingWorkerStatusDTO {
  workerId: string;
  workerName: string;
  state: "recording" | "not_recording" | "unavailable";
  /**
   * 本条状态**实际核对时刻**(epoch ms);缺省/null = 未知(尚未探测成功过)。
   *
   * 为什么必须透出(T17):远端录制状态是**SSH 探测**出来的缓存,不是实时的。
   * 不带这个时间戳,前端只能把缓存当实时显示 —— 用户看到「未在录」却不知道这是 3 秒前
   * 还是 3 分钟前的结论(节点探测失败时缓存会一直是旧值)。有了它才能显示「N 秒前核对」。
   */
  checkedAt: number | null;
}

/** GET /api/tasks/:id → 任务 + runtime。 */
export interface TaskDetailDTO extends TaskDTO {
  runtime: TaskRuntime;
}

/** GET /api/cookie(s/:platform) 的平台 cookie 状态。 */
export interface CookieStatus {
  platform: string;
  set: boolean;
  hasSession: boolean;
  length: number;
  expiresAt: number | null;
  /** 录制平台 Cookie 的来源；biliup 上传登录态不在本接口中。 */
  source: "settings" | "none";
}

/** biliup 上传账号状态（独立于录制平台 Cookie）。 */
export interface BiliupAuthStatus {
  set: boolean;
  hasSession: boolean;
  length: number;
  source: "biliup" | "none";
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

// hub 台账契约的状态/步骤名(web 端只通过 @drec/contracts 拿类型;运行时常量在 hub-ledger-contract)
export type { HubJobState, HubStepName } from "./hub-ledger-contract.js";

/**
 * 节点处理任务表活动快照(plans/036 §2.3):`GET /api/proc/active` 与 `_node-status.procActive` 同结构。
 * 键 = processor kind。部署 guard 第二期据 `running.biliup > 0` 判断(T15)。
 */
export interface ProcActiveDTO {
  /** 本进程的 ProcRunner 是否在运行(`_node-status` 由独立 CLI 进程读表,恒为 false)。 */
  host: boolean;
  running: Record<string, number>;
  pending: Record<string, number>;
  /** 该 kind 是否有存活的租约持有者。 */
  leaseAlive: Record<string, boolean>;
}
