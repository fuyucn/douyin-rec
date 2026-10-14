import { isWorkerTargeted } from "@drec/core";
import type { ApplyTasksResult, NodeCapabilities, NodePipelineResult, NodePipelineResultFile, NodePipelineSpec, NodeStatus, NodeTaskDTO, RemoteTaskSpec, WorkerConfig } from "@drec/core";

// 契约在 core(app 的 worker-store 用同一形状);这里 re-export 保持既有调用点不变。
export type { ApplyTasksResult, WorkerConfig } from "@drec/core";

export interface NodeRecording {
  roomSlug: string;
  platform: string;          // douyin / bilibili(来自 meta.json;缺省 fallback douyin)。按 (platform,roomSlug) 聚类。
  sessionBase: string;       // 如 一勺小苏打_2026-06-27_07-54-33
  tsFiles: string[];         // 绝对/相对该节点路径
  xmlPath?: string;
  /**
   * 该场弹幕 xml 里的条目数(弹幕+礼物+入场)。**仅表头的空 xml**(WS 被风控/未连上)记 0。
   * 选优用:烧录取 winner 自己的 xml,故「视频覆盖更高但没弹幕」的节点不该赢过有弹幕的
   * (否则上传弹幕为空,哪怕同组另一节点弹幕完好)。缺省(旧录像/未统计)= undefined,按 0 处理。
   */
  danmuCount?: number;
  durationSec: number;       // 实录总时长(各段之和)
  /**
   * 本场所有 .ts 分段的字节数之和(issue #25 ①:节点侧上传超时按字节估算,此前 master 拿不到场次大小)。
   * 缺省 undefined = 旧 bundle 的清单 / 统计失败 → 调用方回落固定下限。
   */
  totalBytes?: number;
  startMs: number;           // 首段开录 epoch ms
  endMs: number;             // 末段收录 epoch ms
  totalGapSec: number;       // 断流缺口总秒数(来自 gaps sidecar)
  /** 本场直播标题(来自 `{base}.session.json`);无则 undefined。 */
  title?: string;
  /**
   * 边录边传(T-33)结果 sidecar(`{base}.rolling.json`,录制端写):该会话由录制节点**自己**
   * 建稿/append 的分 P 与 BV。存在 = master **不得重复建稿**(否则重复投稿)。
   * 缺省 undefined = 未启用边录边传 / 老录像。
   */
  rolling?: NodeRollingProgress;
}

/**
 * 边录边传进度(`{base}.rolling.json` 的主控可见投影)。`uploading` 是 WAL 意图标记:
 * 开始建稿/追加前先落盘,进程被杀后残留 = 「建稿/追加到一半、结果未知」。
 * 旧节点 bundle 的清单没有该字段 → 一律按缺省(undefined)处理,不得当成「无意图已完成」之外的任何事。
 */
export interface NodeRollingProgress {
  bv?: string;
  confirmed?: number[];
  ambiguous?: number[];
  uploading?: { index: number; kind: "create" | "append" };
}
export interface NodeInventory { workerId: string; recordings: NodeRecording[]; }

/** `_tasks` 远端输出:该节点全部任务的隐私安全投影(无 cookies)。 */
export interface NodeTasks { workerId: string; tasks: NodeTaskDTO[]; }

/** 节点上一个边录边传会话的实时进度(`_recording-status` 的 rolling 字段,F1)。 */
export interface NodeRollingSession {
  platform: string;
  roomSlug: string;
  sessionBase: string;
  bv?: string;
  confirmed: number;
  total: number;
  ambiguous: number;
  uploading?: { index: number; kind: "create" | "append" };
  /** 该房间此刻是否仍在录制。 */
  recording: boolean;
  /** 未确认分段在磁盘上仍占用的字节数(只统计仍存在的文件);旧 bundle 无该字段。 */
  lockedBytes?: number;
}

/** `_recording-status` 的完整结果:在录房间 + 边录边传进度(旧 bundle 无 rolling → [])。 */
export interface NodeRecordingStatus {
  rooms: ActiveRecordingRoom[];
  rolling: NodeRollingSession[];
}

export interface ActiveRecordingRoom {
  platform: string;
  roomSlug: string;
}

/**
 * 哪些 worker 需要为控制台状态去查询「当前正在录制的房间」。
 * 只有被「绑定了 sourceTaskId 的 hub 规则」选中的 worker 才需要探测;未被任何规则选中的
 * worker 没有房间要展示,省掉每轮 SSH。规则未写 workers(旧配置)时视为选中全部。
 */
export function recordingStatusWorkerIds(
  rules: readonly { workers?: string[]; recording?: { sourceTaskId?: number | null } | null }[],
  allWorkerIds: readonly string[],
): Set<string> {
  const out = new Set<string>();
  for (const rule of rules) {
    if (!rule.recording?.sourceTaskId) continue;
    // 勾选判定与归属同源(core isWorkerTargeted)。这里**故意不**叠加 enabled/能力:
    // 规则被停用/能力不满足时,已勾选的节点仍可能在收尾录制,状态必须继续可见。
    for (const id of allWorkerIds) if (isWorkerTargeted(rule, id)) out.add(id);
    if (rule.workers?.length) for (const id of rule.workers) out.add(id);
  }
  return out;
}

export interface Transport {
  readonly id: string;
  listInventory(): Promise<NodeInventory>;
  isDone(roomSlug: string): Promise<boolean>;
  pull(remotePaths: string[], localDir: string): Promise<void>;
  /**
   * 该节点上这些路径是否都还存在(选优前剔除「文件已被清理/归档」的候选,防选中后 pull 失败卡住)。
   * 可选:无此能力的 transport 视为「信任存在」(pull 失败仍由 reconciler 标 failed 兜底)。
   */
  exists?(paths: string[]): Promise<boolean>;
  /** 删除该节点上的这些文件(cleanup 配置用;删失败应吞掉不抛)。无此能力则跳过清理。 */
  cleanup?(paths: string[]): Promise<void>;
  /**
   * 读该节点的**稳定身份**(隐藏 `_node-id` 子命令 → `<dataRoot>/config/node.json` 的 nodeId)。
   * master 首次添加节点时用它作为 worker id(而非自分配 `worker-N`)→ 同机器永远同一 id,
   * 换 master/重启/迁移都不丢身份。无此能力(旧 bundle)→ 返回 null,调用方回落旧行为。
   */
  nodeId?(): Promise<{ nodeId: string; hostname?: string } | null>;
  /**
   * 轻量存活探针:可达 + dataRoot 存在 → resolve;不可达 / dataRoot 不存在 → reject(带 message)。
   * 不扫 recordings(区别于 listInventory)。可选:无此能力的 transport 视为「不支持探针」。
   */
  ping?(): Promise<void>;
  /** 当前有媒体下载子进程的房间,供 master 控制台显示远端录制状态。 */
  activeRecordingRooms?(): Promise<ActiveRecordingRoom[]>;
  /** 在录房间 + 边录边传进度(F1;可选,缺省时调用方回落 activeRecordingRooms 且无进度)。 */
  recordingStatus?(): Promise<NodeRecordingStatus>;
  /** 读取该节点的任务清单(隐藏 `_tasks` 子命令;可选:无此能力 = 不支持任务同步)。 */
  listTasks?(): Promise<NodeTasks>;
  /**
   * 把 master 期望任务下发到该节点(隐藏 `_apply-tasks` 子命令;可选:无此能力 = 不支持任务同步)。
   *
   * `force=true` = 显式确认缩容/清空,让节点侧跳过 T-2 期望骤减安全阀。**不能省**:
   * 守卫会把「master 读不到规则」(desired 突然为空)与「用户真的要把房间从 A 节点改派到 B 节点」
   * 两种情况看成同一件事;force 是后者的唯一合法出口。
   */
  applyTasks?(input: { desired: RemoteTaskSpec[]; force?: boolean }): Promise<ApplyTasksResult>;
  /**
   * 节点应用回执(T16):这台节点应用了哪一版期望、跑的是哪个 bundle。
   * **可选**:旧 bundle 没有 `_node-status` → 返回 null(UI 显示 unknown,不报错)。
   */
  nodeStatus?(): Promise<NodeStatus | null>;
  /**
   * 该节点录制数据根所在卷的剩余空间(GB)。可选:无此能力则不参与磁盘看门狗。
   * reconciler 每轮对账时查一次 → 低于阈值由 **master 自己**告警(不依赖 worker 侧 webhook 配置)。
   */
  diskFreeGB?(): Promise<number>;
  /**
   * 读该节点上**某个任务**最近的录制日志尾巴(隐藏 `_task-logs` 子命令,F3)。
   *
   * 为什么:节点网页在 fleet 模式下日常不看,排查却要登到节点上。master 代查即可,
   * 不用给节点开公网入口。旧 bundle 无该命令 → 抛 unknown command,调用方按「不支持」处理。
   */
  taskLogs?(taskId: number, lines: number): Promise<{ lines: string[]; error?: string }>;
  /**
   * 节点侧上传能力探测(experimental,见 plans/027)。无此能力(旧 bundle)= 不支持 → flag on 的房间回落现状。
   * 查:biliup 可用 + B站 cookie 存在 + 磁盘剩余。
   */
  nodeCapabilities?(): Promise<NodeCapabilities>;
  /**
   * 在该节点本地执行「remux → biliup 上传」并把 BV 回传(experimental,见 plans/027)。
   * 录像**不回传 master** —— 这正是省掉 rsync 的关键。无此能力 = 不支持 → 回落现状。
   */
  nodePipeline?(spec: NodePipelineSpec, opts?: { timeoutMs?: number }): Promise<NodePipelineResult>;
  /**
   * 回读节点侧**落盘结果文件**(experimental,见 plans/027)。
   *
   * 为什么需要:`nodePipeline` 是长命令,ssh 可能在命令跑完前断开(实测 rc=255),此时
   * **不知道节点上的上传到底成没成**。落盘结果是独立于 ssh 生命周期的权威来源:
   *   - `phase:"done"` + `ok:true` + bv → 其实成功了(修复「假失败」);
   *   - `phase:"uploading"` → 结果不确定 → **绝不自动重传**(可能已建稿);
   *   - `null`(文件不存在/损坏)→ 按原失败路径处理。
   *
   * 返回 null = 读不到(旧 bundle 无该命令 / 文件不存在 / 节点不可达)。**不抛错** ——
   * 它只在失败路径上被调用,不该再用一个异常盖掉原始错误。
   */
  nodeResult?(streamKey: string): Promise<NodePipelineResultFile | null>;
  /**
   * **主动终止**该节点上某 `streamKey` 的节点执行体(issue #2 A2,experimental)。
   *
   * 为什么:`nodePipeline` 是 ssh 长命令,master 的 `runLong` 超时只杀**本地 ssh 客户端**,
   * 远端 `_node-pipeline` 及其 biliup/ffmpeg 子进程会继续跑 → master 已把台账判 failed/needs_manual,
   * 节点稍后却可能**偷偷建稿**(重复投稿,B站不可逆)。master 在**终态失败收口时**调用本方法把执行体收掉,
   * 确保「台账一旦说失败,节点不会在其后继续建稿」。
   *
   * **可选**:旧 bundle 无 `_node-abort` 子命令 → 实现方**必须优雅降级**(不抛、记日志、返回
   * `{ aborted: false }`),不得用异常掩盖 master 侧的原始失败原因。调用方据 `aborted` 区分
   * 「确认已终止(可读 started → failed)」与「无法确认(保守 → needs_manual)」。
   */
  abortNodePipeline?(streamKey: string): Promise<{ aborted: boolean; detail?: string }>;
}

type Factory = (cfg: WorkerConfig) => Transport;
const registry = new Map<string, Factory>();

export function registerTransport(kind: string, factory: Factory): void { registry.set(kind, factory); }
export function getTransport(cfg: WorkerConfig): Transport {
  const f = registry.get(cfg.kind);
  if (!f) throw new Error(`未注册的 transport kind: ${cfg.kind}`);
  return f(cfg);
}
/** 测试用：清空注册表。 */
export function _resetTransports(): void { registry.clear(); }
