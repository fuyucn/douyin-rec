import type { NodeRecording } from "./transport.js";
import type { Broadcast, BroadcastMember } from "./identity.js";

export function coverageOf(rec: NodeRecording): number {
  const spanSec = (rec.endMs - rec.startMs) / 1000;
  if (spanSec <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - rec.totalGapSec / spanSec));
}

/** 整场首尾容差下限。取流/建连晚几十秒是常态,不能因此把连续完整的节点判成没录全。 */
export const COVER_EDGE_MIN_SEC = 180;

export interface CandidateMetrics {
  workerId: string;
  coverage: number;
  durationSec: number;
  startMs: number;
  endMs: number;
  totalGapSec: number;
  /** 该 worker 本场弹幕条目数(各会话求和)。0 = 无弹幕/仅表头空 xml。 */
  danmuCount: number;
}

export interface Selection {
  /** 胜出 worker 的完整会话清单(按开录时间序);单会话时与 winner 一致。 */
  winnerMembers: BroadcastMember[];
  /** 主会话(= winnerMembers[0]),兼容旧调用方。 */
  winner: BroadcastMember | null;
  clean: boolean;
  perNode: CandidateMetrics[];
}

function sortSessions(sessions: BroadcastMember[]): BroadcastMember[] {
  return [...sessions].sort((a, c) => a.rec.startMs - c.rec.startMs);
}

function workerMetrics(sessions: BroadcastMember[]): {
  startMs: number;
  endMs: number;
  spanSec: number;
  gapSec: number;
  durationSec: number;
} {
  const sorted = sortSessions(sessions);
  let durationSec = 0;
  let internalGap = 0;
  for (const s of sorted) {
    durationSec += s.rec.durationSec;
    internalGap += s.rec.totalGapSec;
  }
  const startMs = sorted[0]?.rec.startMs ?? 0;
  const endMs = sorted[sorted.length - 1]?.rec.endMs ?? startMs;
  let interGap = 0;
  for (let i = 1; i < sorted.length; i++) {
    interGap += Math.max(0, (sorted[i].rec.startMs - sorted[i - 1].rec.endMs) / 1000);
  }
  return {
    startMs,
    endMs,
    spanSec: Math.max(0, (endMs - startMs) / 1000),
    gapSec: internalGap + interGap,
    durationSec,
  };
}

/**
 * 选优。
 *
 * @param requireDanmu 本场后处理是否需要弹幕(烧 danmu/livechat 版)。为 true 且组内**存在**有弹幕的
 *   成员时,「有弹幕」优先于覆盖率/时长 —— 因为烧录只取 winner 自己的 xml(`pipeline.ts` 的 `xmlArg`),
 *   若让「视频覆盖更高但 xml 为空」的节点胜出,上传的弹幕就是空的,哪怕同组另一节点弹幕完好。
 *   `clean`(视频是否盖住整场)仍是**第一优先级**:不能为弹幕牺牲「录全」这个正确性闸门。
 *   缺省 false → 排序键恒为 0,**行为与改动前完全一致**(向后兼容)。
 */
export function selectWinner(b: Broadcast, cleanMaxGapSec: number, requireDanmu = false): Selection {
  if (b.members.length === 0) return { winnerMembers: [], winner: null, clean: false, perNode: [] };
  const byWorker = new Map<string, BroadcastMember[]>();
  for (const m of b.members) {
    const arr = byWorker.get(m.workerId) ?? [];
    arr.push(m);
    byWorker.set(m.workerId, arr);
  }
  const perNode: CandidateMetrics[] = [...byWorker.entries()].map(([workerId, sessions]) => {
    const { startMs, endMs, spanSec, gapSec, durationSec } = workerMetrics(sessions);
    const coverage = spanSec <= 0 ? 1 : Math.max(0, Math.min(1, 1 - gapSec / spanSec));
    const danmuCount = sessions.reduce((s, m) => s + (m.rec.danmuCount ?? 0), 0);
    return { workerId, coverage, durationSec, startMs, endMs, totalGapSec: gapSec, danmuCount };
  });
  const prefOf = (sessions: BroadcastMember[]): { coverage: number; durationSec: number } => {
    const { spanSec, gapSec, durationSec } = workerMetrics(sessions);
    const coverage = spanSec <= 0 ? 1 : Math.max(0, Math.min(1, 1 - gapSec / spanSec));
    return { coverage, durationSec };
  };
  const allClean = (sessions: BroadcastMember[]): boolean =>
    sessions.every((m) => m.rec.totalGapSec <= cleanMaxGapSec);
  // 整场覆盖:该节点首尾包住各节点并集(容差内)。
  // 只录到前半场的节点仍可能「单会话无内部缺口」,但不能算完整。
  const broadcastStartMs = Math.min(...b.members.map((m) => m.rec.startMs));
  const broadcastEndMs = Math.max(...b.members.map((m) => m.rec.endMs));
  const edgeToleranceMs = Math.max(cleanMaxGapSec, COVER_EDGE_MIN_SEC) * 1000;
  const coversBroadcast = (sessions: BroadcastMember[]): boolean => {
    if (sessions.length === 0) return false;
    const sorted = sortSessions(sessions);
    return sorted[0].rec.startMs <= broadcastStartMs + edgeToleranceMs
      && sorted[sorted.length - 1].rec.endMs >= broadcastEndMs - edgeToleranceMs;
  };

  const groups = [...byWorker.values()].map((sessions) => ({
    sessions: sortSessions(sessions),
    clean: allClean(sessions) && coversBroadcast(sessions),
  }));
  // 组内是否有人真的录到弹幕 —— 没人有时「弹幕优先」失效(否则全 0,排序键恒等,等于不生效)。
  const anyDanmu = requireDanmu && groups.some((g) => g.sessions.some((m) => (m.rec.danmuCount ?? 0) > 0));
  const danmuRank = (sessions: BroadcastMember[]): number =>
    anyDanmu && sessions.some((m) => (m.rec.danmuCount ?? 0) > 0) ? 1 : 0;
  // 先比各节点同一场:完整优先,再「有弹幕」优先(仅 requireDanmu 且组内有人有弹幕时),
  // 同等完整度下单会话(没断网重连)优先,再取覆盖更高 / 总时长更长。
  const ranked = [...groups].sort(
    (a, c) => {
      const pa = prefOf(a.sessions);
      const pc = prefOf(c.sessions);
      return Number(c.clean) - Number(a.clean)
        || danmuRank(c.sessions) - danmuRank(a.sessions)
        || a.sessions.length - c.sessions.length
        || pc.coverage - pa.coverage
        || pc.durationSec - pa.durationSec;
    },
  );
  const winnerMembers = ranked[0]?.sessions ?? [];
  const winner = winnerMembers[0] ?? null;
  // clean ⇔ 存在录全的 worker。false = 所有节点都没盖住整场(pipeline 据此中断)。
  const clean = ranked.some((g) => g.clean);
  return { winner, winnerMembers, clean, perNode };
}
