/** controller「节点」总览条的纯函数(无 React 依赖,可直测)。 */
import type { RollingDeliveryDTO, Task, WorkerDTO, WorkerStatus } from "../api/client";

/** 字节 → 人类可读(1 位小数,MB/GB)。 */
export function fmtBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
}

export const baseVersion = (v: string | undefined): string => (v ?? "").split("-")[0] ?? "";

/**
 * Probe-level state is separate from per-node status: a failed probe says nothing about whether
 * any node is healthy, while a successful probe may still omit one node.
 */
export type NodeHealthProbe = "loading" | "failed" | "ready";

/** User-visible health states derived from the probe state plus the per-node result. */
export type NodeHealthState = "checking" | "probe-failed" | "unknown" | "online" | "offline";

export interface NodeHealthCounts {
  total: number;
  checking: number;
  probeFailed: number;
  unknown: number;
  online: number;
  offline: number;
}

export interface NodeHealthProbeInput {
  /** The health request has completed, successfully or not. */
  statusSettled: boolean;
  /** At least one non-empty status snapshot has been received. */
  statusHasSnapshot: boolean;
  /** The configured-worker directory has completed its first load. */
  workersLoaded: boolean;
}

/**
 * Derive the probe state without hiding backend behavior: the status endpoint may return an empty
 * 200 when every probe failed. With no snapshot, the settled result is a failed probe. A later
 * failure keeps `statusHasSnapshot` true and remains ready.
 */
export function deriveNodeHealthProbe(input: NodeHealthProbeInput): NodeHealthProbe {
  if (!input.statusSettled || !input.workersLoaded) return "loading";
  if (input.statusHasSnapshot) return "ready";
  return "failed";
}

export interface NodeHealthLoadState {
  statusSettled: boolean;
  statusHasSnapshot: boolean;
  statusStale: boolean;
}

export const INITIAL_NODE_HEALTH_LOAD_STATE: NodeHealthLoadState = {
  statusSettled: false,
  statusHasSnapshot: false,
  statusStale: false,
};

export interface NodeHealthLoadResult {
  state: NodeHealthLoadState;
  statuses?: WorkerStatus[];
}

/**
 * One testable load path for Nodes and Queue. An empty 200 is stale/failed, a thrown request keeps
 * the previous snapshot, and a non-empty result replaces the snapshot. Empty responses omit
 * `statuses` so callers never replace a good snapshot with `{}`.
 */
export async function loadNodeHealthSnapshot(
  fetcher: () => Promise<WorkerStatus[]>,
  previous: NodeHealthLoadState,
): Promise<NodeHealthLoadResult> {
  try {
    const statuses = await fetcher();
    return {
      ...(statuses.length > 0 ? { statuses } : {}),
      state: {
        statusSettled: true,
        statusHasSnapshot: previous.statusHasSnapshot || statuses.length > 0,
        statusStale: statuses.length === 0,
      },
    };
  } catch {
    return {
      state: {
        statusSettled: true,
        statusHasSnapshot: previous.statusHasSnapshot,
        statusStale: true,
      },
    };
  }
}

export function nodeHealthState(node: Pick<NodeSummary, "ok">, probe: NodeHealthProbe): NodeHealthState {
  if (probe === "loading") return "checking";
  if (probe === "failed") return "probe-failed";
  if (node.ok === undefined) return "unknown";
  return node.ok ? "online" : "offline";
}

export function countNodeHealth(
  nodes: readonly Pick<NodeSummary, "ok">[],
  probe: NodeHealthProbe,
): NodeHealthCounts {
  const counts: NodeHealthCounts = { total: nodes.length, checking: 0, probeFailed: 0, unknown: 0, online: 0, offline: 0 };
  for (const node of nodes) {
    const state = nodeHealthState(node, probe);
    if (state === "probe-failed") counts.probeFailed++;
    else counts[state]++;
  }
  return counts;
}

/** 房间在某节点上的展示状态。 */
export type NodeRoomState = "recording" | "waiting" | "unavailable" | "disabled";

/** 节点卡片里的一行:一个被分配到该节点的房间 + 它在该节点上的边录边传会话。 */
export interface NodeRoom {
  key: string;
  label: string;
  /** Platform + normalized room slug; keep both so equal slugs on different platforms never merge. */
  platform?: string;
  roomSlug?: string;
  state: NodeRoomState;
  /** 该状态的核对时刻(epoch ms);未知 = undefined。 */
  checkedAt?: number;
  sessions: RollingDeliveryDTO[];
}

/**
 * 房间 URL / 纯数字 → 房间标识。**必须与后端 `platform.extractRoomSlug` 同口径**:
 * 抖音取 live.douyin.com/<数字> 的数字段,B站/快手取 URL 末段(去掉查询串)。取错会让
 * 「按房间匹配」永远不命中(例如把整段 URL 当 slug 去比对房间号)。
 */
export function roomSlugOf(room: string | undefined): string {
  const r = (room ?? "").trim();
  const dy = /live\.douyin\.com\/(\d+)/.exec(r);
  if (dy) return dy[1]!;
  if (/^\d+$/.test(r)) return r;
  const q = r.indexOf("?");
  const base = (q >= 0 ? r.slice(0, q) : r).replace(/\/+$/, "");
  return base.split("/").pop() ?? base;
}

export type NodeTaskInput = Pick<Task, "recordingWorkers"> & Partial<Pick<Task, "platform" | "room" | "name" | "anchorName" | "enabled">>;

export interface NodeSummary {
  id: string;
  name: string;
  /** 探测结果:undefined = 还没拿到(显示检测中)。 */
  ok?: boolean;
  error?: string;
  version?: string;
  drift: boolean;
  diskFreeGB?: number;
  diskLow: boolean;
  diskMinGB?: number;
  /** 正在录的房间数 / 探测不到状态的房间数。 */
  recording: number;
  unavailable: number;
  /** 边录边传:会话数、未确认占盘字节、结果未知段数。 */
  rollingSessions: number;
  lockedBytes: number;
  ambiguous: number;
  /** 分配到该节点的房间(在录优先)。 */
  rooms: NodeRoom[];
  /** 节点已应用 / master 期望的任务配置版本(旧 bundle / 未探测 → undefined)。 */
  appliedVersion?: number | null;
  expectedVersion?: number;
  appliedAt?: number | null;
  syncError?: string;
  /** 期望版本未应用(同步滞后/失败)。 */
  syncLag: boolean;
}

/** Pure model: configured workers, probe results, task assignments, and rolling sessions become one row per node. */
export function summarizeNodes(
  tasks: readonly NodeTaskInput[],
  status: Record<string, WorkerStatus | undefined>,
  delivering: readonly RollingDeliveryDTO[],
  masterVersion: string,
  workers: readonly Pick<WorkerDTO, "id" | "name">[] = [],
): NodeSummary[] {
  const byId = new Map<string, NodeSummary>();
  const ensure = (id: string, name: string): NodeSummary => {
    let n = byId.get(id);
    if (!n) {
      const s = status[id];
      const diskMinGB = s?.diskMinGB;
      const diskFreeGB = typeof s?.diskFreeGB === "number" ? s.diskFreeGB : undefined;
      n = {
        id, name,
        ok: s?.ok, error: s?.error, version: s?.appVersion,
        // 没有基准或节点没回执(旧 bundle)→ 不判漂移,避免假告警(与节点抽屉同口径)。
        drift: !!(s?.ok && s.appVersion && masterVersion && baseVersion(s.appVersion) !== masterVersion),
        diskFreeGB, diskMinGB,
        diskLow: diskFreeGB !== undefined && typeof diskMinGB === "number" && diskMinGB > 0 && diskFreeGB < diskMinGB,
        recording: 0, unavailable: 0, rollingSessions: 0, lockedBytes: 0, ambiguous: 0, rooms: [],
        appliedVersion: s?.appliedVersion, expectedVersion: s?.expectedVersion, appliedAt: s?.appliedAt, syncError: s?.syncError,
        syncLag: !!(s?.ok && s.expectedVersion != null && s.appliedVersion != null && s.expectedVersion !== s.appliedVersion),
      };
      byId.set(id, n);
    }
    return n;
  };
  // Configured workers belong on the fleet even before they get a room assignment.
  for (const w of workers) ensure(w.id, w.name || w.id);
  // A probe can mention a worker that the configured list has not refreshed yet.
  for (const id of Object.keys(status)) ensure(id, status[id]?.id ?? id);
  // Room rows are keyed by (node, platform, slug). A bare slug is not globally unique.
  const roomIdx = new Map<string, NodeRoom>();
  for (const t of tasks) {
    const slug = roomSlugOf(t.room);
    // Empty platform stays empty on the row; the identity uses the same fallback as deliveries.
    const platform = t.platform ?? "";
    for (const w of t.recordingWorkers ?? []) {
      const n = ensure(w.workerId, w.workerName);
      if (w.state === "recording") n.recording++;
      else if (w.state === "unavailable") n.unavailable++;
      const state: NodeRoomState = w.state === "recording" ? "recording" : w.state === "unavailable" ? "unavailable"
        : t.enabled === false ? "disabled" : "waiting";
      const identity = `${w.workerId}:${platform}:${slug || t.room || n.rooms.length}`;
      const row: NodeRoom = {
        key: identity,
        platform,
        roomSlug: slug || undefined,
        // Same priority as notifications and the queue page (issue #53): task name first.
        label: t.name || t.anchorName || slug || "?",
        state, checkedAt: typeof w.checkedAt === "number" ? w.checkedAt : undefined, sessions: [],
      };
      n.rooms.push(row);
      if (slug) roomIdx.set(identity, row);
    }
  }
  for (const d of delivering) {
    const n = ensure(d.workerId, d.workerName);
    n.rollingSessions++;
    n.lockedBytes += typeof d.lockedBytes === "number" ? d.lockedBytes : 0;
    n.ambiguous += d.ambiguous;
    const identity = `${d.workerId}:${d.platform ?? ""}:${d.roomSlug}`;
    let row = roomIdx.get(identity);
    if (!row) {
      // 任务清单里已没有的房间(遗留会话):照样列出,别让未确认分段「消失」。
      row = {
        key: identity,
        platform: d.platform ?? "",
        roomSlug: d.roomSlug,
        label: d.anchorName || d.roomSlug,
        state: d.recording ? "recording" : "disabled",
        sessions: [],
      };
      roomIdx.set(identity, row);
      n.rooms.push(row);
    }
    row.sessions.push(d);
  }
  const rank: Record<NodeRoomState, number> = { recording: 0, unavailable: 1, waiting: 2, disabled: 3 };
  for (const n of byId.values()) n.rooms.sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
