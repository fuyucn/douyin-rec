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
  startMs: number;           // 首段开录 epoch ms
  endMs: number;             // 末段收录 epoch ms
  totalGapSec: number;       // 断流缺口总秒数(来自 gaps sidecar)
  /** 本场直播标题(来自 `{base}.session.json`);无则 undefined。 */
  title?: string;
}
export interface NodeInventory { workerId: string; recordings: NodeRecording[]; }

/** `_tasks` 远端输出:该节点全部任务的隐私安全投影(无 cookies)。 */
export interface NodeTasks { workerId: string; tasks: NodeTaskDTO[]; }

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
    if (rule.workers?.length) for (const id of rule.workers) out.add(id);
    else for (const id of allWorkerIds) out.add(id);
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
   * 节点侧上传能力探测(experimental,见 plans/027)。无此能力(旧 bundle)= 不支持 → flag on 的房间回落现状。
   * 查:biliup 可用 + B站 cookie 存在 + 磁盘剩余。
   */
  nodeCapabilities?(): Promise<NodeCapabilities>;
  /**
   * 在该节点本地执行「remux → biliup 上传」并把 BV 回传(experimental,见 plans/027)。
   * 录像**不回传 master** —— 这正是省掉 rsync 的关键。无此能力 = 不支持 → 回落现状。
   */
  nodePipeline?(spec: NodePipelineSpec): Promise<NodePipelineResult>;
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
