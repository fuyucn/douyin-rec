import type { ApplyTasksResult, NodeTaskDTO, RemoteTaskSpec, WorkerConfig } from "@drec/core";

// 契约在 core(app 的 worker-store 用同一形状);这里 re-export 保持既有调用点不变。
export type { ApplyTasksResult, WorkerConfig } from "@drec/core";

export interface NodeRecording {
  roomSlug: string;
  platform: string;          // douyin / bilibili(来自 meta.json;缺省 fallback douyin)。按 (platform,roomSlug) 聚类。
  sessionBase: string;       // 如 一勺小苏打_2026-06-27_07-54-33
  tsFiles: string[];         // 绝对/相对该节点路径
  xmlPath?: string;
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
   * 轻量存活探针:可达 + dataRoot 存在 → resolve;不可达 / dataRoot 不存在 → reject(带 message)。
   * 不扫 recordings(区别于 listInventory)。可选:无此能力的 transport 视为「不支持探针」。
   */
  ping?(): Promise<void>;
  /** 读取该节点的任务清单(隐藏 `_tasks` 子命令;可选:无此能力 = 不支持任务同步)。 */
  listTasks?(): Promise<NodeTasks>;
  /** 把 master 期望任务下发到该节点(隐藏 `_apply-tasks` 子命令;可选:无此能力 = 不支持任务同步)。 */
  applyTasks?(input: { desired: RemoteTaskSpec[] }): Promise<ApplyTasksResult>;
  /**
   * 该节点录制数据根所在卷的剩余空间(GB)。可选:无此能力则不参与磁盘看门狗。
   * reconciler 每轮对账时查一次 → 低于阈值由 **master 自己**告警(不依赖 worker 侧 webhook 配置)。
   */
  diskFreeGB?(): Promise<number>;
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
