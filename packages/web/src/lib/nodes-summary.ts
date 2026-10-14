/** controller「节点」总览条的纯函数(无 React 依赖,可直测)。 */
import type { RollingDeliveryDTO, Task, WorkerStatus } from "../api/client";

/** 字节 → 人类可读(1 位小数,MB/GB)。 */
export function fmtBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
}

export const baseVersion = (v: string | undefined): string => (v ?? "").split("-")[0] ?? "";

/** 房间在某节点上的展示状态。 */
export type NodeRoomState = "recording" | "waiting" | "unavailable" | "disabled";

/** 节点卡片里的一行:一个被分配到该节点的房间 + 它在该节点上的边录边传会话。 */
export interface NodeRoom {
  key: string;
  label: string;
  state: NodeRoomState;
  /** 该状态的核对时刻(epoch ms);未知 = undefined。 */
  checkedAt?: number;
  sessions: RollingDeliveryDTO[];
}

/** 房间 URL / 纯数字 → 房间标识(与后端 extractRoomSlug 对齐的最小子集:抖音数字 id / 末段路径)。 */
export function roomSlugOf(room: string | undefined): string {
  const r = (room ?? "").trim();
  const m = /live\.douyin\.com\/(\d+)/.exec(r) ?? /\/(\d+)(?:[/?]|$)/.exec(r);
  if (m) return m[1]!;
  const q = r.indexOf("?");
  const base = q >= 0 ? r.slice(0, q) : r;
  return base.replace(/\/+$/, "").split("/").pop() ?? base;
}

export type NodeTaskInput = Pick<Task, "recordingWorkers"> & Partial<Pick<Task, "room" | "name" | "anchorName" | "enabled">>;

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

/** 纯函数:把三路数据汇成每节点一行。只含被任务 recordingWorkers 提到的节点(= 被分配的节点)。 */
export function summarizeNodes(
  tasks: readonly NodeTaskInput[],
  status: Record<string, WorkerStatus | undefined>,
  delivering: readonly RollingDeliveryDTO[],
  masterVersion: string,
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
  // 房间行按 (节点, 平台无关的房间标识) 索引,供边录边传会话挂靠。
  const roomIdx = new Map<string, NodeRoom>();
  for (const t of tasks) {
    const slug = roomSlugOf(t.room);
    for (const w of t.recordingWorkers ?? []) {
      const n = ensure(w.workerId, w.workerName);
      if (w.state === "recording") n.recording++;
      else if (w.state === "unavailable") n.unavailable++;
      const state: NodeRoomState = w.state === "recording" ? "recording" : w.state === "unavailable" ? "unavailable"
        : t.enabled === false ? "disabled" : "waiting";
      const row: NodeRoom = {
        key: `${w.workerId}:${slug || t.room || n.rooms.length}`,
        label: t.anchorName || t.name || slug || "?",
        state, checkedAt: typeof w.checkedAt === "number" ? w.checkedAt : undefined, sessions: [],
      };
      n.rooms.push(row);
      if (slug) roomIdx.set(`${w.workerId}:${slug}`, row);
    }
  }
  for (const d of delivering) {
    const n = byId.get(d.workerId);
    if (!n) continue;
    n.rollingSessions++;
    n.lockedBytes += typeof d.lockedBytes === "number" ? d.lockedBytes : 0;
    n.ambiguous += d.ambiguous;
    let row = roomIdx.get(`${d.workerId}:${d.roomSlug}`);
    if (!row) {
      // 任务清单里已没有的房间(遗留会话):照样列出,别让未确认分段「消失」。
      row = { key: `${d.workerId}:${d.roomSlug}`, label: d.anchorName || d.roomSlug, state: d.recording ? "recording" : "disabled", sessions: [] };
      roomIdx.set(`${d.workerId}:${d.roomSlug}`, row);
      n.rooms.push(row);
    }
    row.sessions.push(d);
  }
  const rank: Record<NodeRoomState, number> = { recording: 0, unavailable: 1, waiting: 2, disabled: 3 };
  for (const n of byId.values()) n.rooms.sort((a, b) => rank[a.state] - rank[b.state] || a.label.localeCompare(b.label));
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
