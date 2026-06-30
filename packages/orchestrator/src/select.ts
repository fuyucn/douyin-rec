import type { NodeRecording } from "./transport.js";
import type { Broadcast, BroadcastMember } from "./identity.js";

export function coverageOf(rec: NodeRecording): number {
  const spanSec = (rec.endMs - rec.startMs) / 1000;
  if (spanSec <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - rec.totalGapSec / spanSec));
}

export interface CandidateMetrics {
  tenantId: string;
  coverage: number;
  durationSec: number;
  startMs: number;
  endMs: number;
  totalGapSec: number;
}

export interface Selection {
  winner: BroadcastMember | null;
  clean: boolean;
  perNode: CandidateMetrics[];
}

export function selectWinner(b: Broadcast, cleanMaxGapSec: number): Selection {
  const perNode: CandidateMetrics[] = b.members.map((m) => ({
    tenantId: m.tenantId,
    coverage: coverageOf(m.rec),
    durationSec: m.rec.durationSec,
    startMs: m.rec.startMs,
    endMs: m.rec.endMs,
    totalGapSec: m.rec.totalGapSec,
  }));
  // 每个 tenant 的会话数:>1 = 该 tenant 在本场断流过(我们的录制器断流重连 = 新会话/新 sessionBase)。
  const sessionCount = new Map<string, number>();
  for (const m of b.members) sessionCount.set(m.tenantId, (sessionCount.get(m.tenantId) ?? 0) + 1);
  // 「完整录全」= 该 tenant 只有一个会话(没断流)且会话内 gap ≤ 阈值(没在录制中途断)。
  const isComplete = (m: BroadcastMember): boolean =>
    (sessionCount.get(m.tenantId) ?? 0) === 1 && m.rec.totalGapSec <= cleanMaxGapSec;
  const byPref = (x: BroadcastMember, y: BroadcastMember): number =>
    coverageOf(y.rec) - coverageOf(x.rec) || y.rec.durationSec - x.rec.durationSec;
  // winner:完整录全的优先(取最长);都不完整时取「最完整(最长)」的供人工参考。
  const completeMembers = b.members.filter(isComplete).sort(byPref);
  const winner = completeMembers[0] ?? [...b.members].sort(byPref)[0] ?? null;
  // clean ⇔ 存在完整录全的 tenant。false = 所有节点都断流(pipeline 据此中断+通知,不自动拼)。
  const clean = completeMembers.length > 0;
  return { winner, clean, perNode };
}
