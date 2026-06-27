import type { NodeRecording } from "./transport.js";
import type { Broadcast, BroadcastMember } from "./identity.js";

export function coverageOf(rec: NodeRecording): number {
  const spanSec = (rec.endMs - rec.startMs) / 1000;
  if (spanSec <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - rec.totalGapSec / spanSec));
}

export interface Selection {
  winner: BroadcastMember | null;
  clean: boolean;
  perNode: { tenantId: string; coverage: number; durationSec: number }[];
}

export function selectWinner(b: Broadcast, cleanMaxGapSec: number): Selection {
  const perNode = b.members.map((m) => ({ tenantId: m.tenantId, coverage: coverageOf(m.rec), durationSec: m.rec.durationSec }));
  const winner = [...b.members].sort((x, y) =>
    coverageOf(y.rec) - coverageOf(x.rec) || y.rec.durationSec - x.rec.durationSec
  )[0] ?? null;
  const clean = !!winner && winner.rec.totalGapSec <= cleanMaxGapSec;
  return { winner, clean, perNode };
}
