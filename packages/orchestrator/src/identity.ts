import type { NodeRecording } from "./transport.js";

export interface BroadcastMember { tenantId: string; rec: NodeRecording; }
export interface Broadcast { streamKey: string; roomSlug: string; startMs: number; members: BroadcastMember[]; }

const DEFAULT_TOLERANCE = 5 * 60_000;

function overlaps(a: NodeRecording, b: NodeRecording, tol: number): boolean {
  return a.startMs <= b.endMs + tol && b.startMs <= a.endMs + tol;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function ymd(ms: number): string { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function hhmm(ms: number): string { const d = new Date(ms); return `${pad(d.getHours())}${pad(d.getMinutes())}`; }

export function clusterBroadcasts(
  platform: string,
  byTenant: { tenantId: string; recordings: NodeRecording[] }[],
  overlapToleranceMs = DEFAULT_TOLERANCE,
): Broadcast[] {
  // 展平成 (tenantId, rec)，按 roomSlug 分组，组内按 startMs 排序后做区间合并聚簇。
  const flat: BroadcastMember[] = byTenant.flatMap((t) => t.recordings.map((rec) => ({ tenantId: t.tenantId, rec })));
  const byRoom = new Map<string, BroadcastMember[]>();
  for (const m of flat) { const k = m.rec.roomSlug; (byRoom.get(k) ?? byRoom.set(k, []).get(k)!).push(m); }

  const out: Broadcast[] = [];
  for (const [roomSlug, members] of byRoom) {
    members.sort((a, b) => a.rec.startMs - b.rec.startMs);
    let cluster: BroadcastMember[] = [];
    const flush = (): void => {
      if (!cluster.length) return;
      const startMs = Math.min(...cluster.map((m) => m.rec.startMs));
      out.push({ roomSlug, startMs, members: cluster, streamKey: "" });
      cluster = [];
    };
    for (const m of members) {
      if (cluster.length && cluster.some((c) => overlaps(c.rec, m.rec, overlapToleranceMs))) cluster.push(m);
      else { flush(); cluster = [m]; }
    }
    flush();
  }
  // 同房间同一天多簇 → streamKey 追加 _HHMM 区分。
  const dayCount = new Map<string, number>();
  for (const b of out) { const k = `${b.roomSlug}:${ymd(b.startMs)}`; dayCount.set(k, (dayCount.get(k) ?? 0) + 1); }
  for (const b of out) {
    const day = ymd(b.startMs); const base = `${platform}:${b.roomSlug}:${day}`;
    b.streamKey = (dayCount.get(`${b.roomSlug}:${day}`)! > 1) ? `${base}_${hhmm(b.startMs)}` : base;
  }
  return out;
}
