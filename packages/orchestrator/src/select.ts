import type { NodeRecording } from "./transport.js";
import type { Broadcast, BroadcastMember } from "./identity.js";

export function coverageOf(rec: NodeRecording): number {
  const spanSec = (rec.endMs - rec.startMs) / 1000;
  if (spanSec <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - rec.totalGapSec / spanSec));
}

export interface CandidateMetrics {
  workerId: string;
  coverage: number;
  durationSec: number;
  startMs: number;
  endMs: number;
  totalGapSec: number;
}

export interface Selection {
  /** 胜出 worker 的完整会话清单(按开录时间序);单会话时与 winner 一致。 */
  winnerMembers: BroadcastMember[];
  /** 主会话(= winnerMembers[0]),兼容旧调用方。 */
  winner: BroadcastMember | null;
  clean: boolean;
  perNode: CandidateMetrics[];
}

export function selectWinner(b: Broadcast, cleanMaxGapSec: number): Selection {
  if (b.members.length === 0) return { winnerMembers: [], winner: null, clean: false, perNode: [] };
  const perNode: CandidateMetrics[] = b.members.map((m) => ({
    workerId: m.workerId,
    coverage: coverageOf(m.rec),
    durationSec: m.rec.durationSec,
    startMs: m.rec.startMs,
    endMs: m.rec.endMs,
    totalGapSec: m.rec.totalGapSec,
  }));
  // 同一 worker 多会话 = 断流重连(新 sessionBase);每会话内部无缺口就算「完整」,
  // 可以按会话序无损拼接成一整场(不再当残缺转人工)。
  const byWorker = new Map<string, BroadcastMember[]>();
  for (const m of b.members) {
    const arr = byWorker.get(m.workerId) ?? [];
    arr.push(m);
    byWorker.set(m.workerId, arr);
  }
  const workerMetrics = (sessions: BroadcastMember[]): { spanSec: number; gapSec: number; durationSec: number } => {
    let spanSec = 0;
    let gapSec = 0;
    let durationSec = 0;
    for (const s of sessions) {
      spanSec += Math.max(0, (s.rec.endMs - s.rec.startMs) / 1000);
      gapSec += s.rec.totalGapSec;
      durationSec += s.rec.durationSec;
    }
    return { spanSec, gapSec, durationSec };
  };
  const prefOf = (sessions: BroadcastMember[]): { coverage: number; durationSec: number } => {
    const { spanSec, gapSec, durationSec } = workerMetrics(sessions);
    const coverage = spanSec <= 0 ? 1 : Math.max(0, Math.min(1, 1 - gapSec / spanSec));
    return { coverage, durationSec };
  };
  const allClean = (sessions: BroadcastMember[]): boolean =>
    sessions.every((m) => m.rec.totalGapSec <= cleanMaxGapSec);
  // 整场覆盖:首会话不晚于广播起点、末会话不早于广播终点(容差内)。
  // 只录到第一段就停掉的 node 仍是「单会话无缺口」,但缺了重连后的后半场,不能算完整。
  const broadcastStartMs = Math.min(...b.members.map((m) => m.rec.startMs));
  const broadcastEndMs = Math.max(...b.members.map((m) => m.rec.endMs));
  const edgeToleranceMs = Math.max(cleanMaxGapSec, 30) * 1000;
  const coversBroadcast = (sessions: BroadcastMember[]): boolean => {
    if (sessions.length === 0) return false;
    return sessions[0].rec.startMs <= broadcastStartMs + edgeToleranceMs
      && sessions[sessions.length - 1].rec.endMs >= broadcastEndMs - edgeToleranceMs;
  };

  const groups = [...byWorker.values()].map((sessions) => ({
    sessions: [...sessions].sort((a, c) => a.rec.startMs - c.rec.startMs),
    clean: allClean(sessions) && coversBroadcast(sessions),
  }));
  // 完整 worker 优先(含断流重连多会话);同等完整度下单会话优先(无断流痕迹),
  // 再取「覆盖最高/总时长最长」,避免只录到半场的单会话压过录全整场的重连会话。
  const ranked = [...groups].sort(
    (a, c) => {
      const pa = prefOf(a.sessions);
      const pc = prefOf(c.sessions);
      return Number(c.clean) - Number(a.clean)
        || a.sessions.length - c.sessions.length
        || pc.coverage - pa.coverage
        || pc.durationSec - pa.durationSec;
    },
  );
  const winnerMembers = ranked[0]?.sessions ?? [];
  const winner = winnerMembers[0] ?? null;
  // clean ⇔ 存在完整录全的 worker(各会话内部 gap ≤ 阈值)。false = 所有节点都断流(pipeline 据此中断)。
  const clean = ranked.some((g) => g.clean);
  return { winner, winnerMembers, clean, perNode };
}
