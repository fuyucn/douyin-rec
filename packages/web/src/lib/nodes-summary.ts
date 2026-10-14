/** controller「节点」总览条的纯函数(无 React 依赖,可直测)。 */
import type { RollingDeliveryDTO, Task, WorkerStatus } from "../api/client";

/** 字节 → 人类可读(1 位小数,MB/GB)。 */
export function fmtBytes(n: number): string {
  return n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`;
}

export const baseVersion = (v: string | undefined): string => (v ?? "").split("-")[0] ?? "";

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
}

/** 纯函数:把三路数据汇成每节点一行。只含被任务 recordingWorkers 提到的节点(= 被分配的节点)。 */
export function summarizeNodes(
  tasks: readonly Pick<Task, "recordingWorkers">[],
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
        recording: 0, unavailable: 0, rollingSessions: 0, lockedBytes: 0, ambiguous: 0,
      };
      byId.set(id, n);
    }
    return n;
  };
  for (const t of tasks) {
    for (const w of t.recordingWorkers ?? []) {
      const n = ensure(w.workerId, w.workerName);
      if (w.state === "recording") n.recording++;
      else if (w.state === "unavailable") n.unavailable++;
    }
  }
  for (const d of delivering) {
    const n = byId.get(d.workerId);
    if (!n) continue;
    n.rollingSessions++;
    n.lockedBytes += typeof d.lockedBytes === "number" ? d.lockedBytes : 0;
    n.ambiguous += d.ambiguous;
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}
