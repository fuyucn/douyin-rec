import type { NodeRecording } from "./transport.js";

export interface BroadcastMember { tenantId: string; rec: NodeRecording; }
export interface Broadcast { streamKey: string; platform: string; roomSlug: string; startMs: number; members: BroadcastMember[]; }

const DEFAULT_TOLERANCE = 5 * 60_000;

function overlaps(a: NodeRecording, b: NodeRecording, tol: number): boolean {
  return a.startMs <= b.endMs + tol && b.startMs <= a.endMs + tol;
}

function pad(n: number): string { return String(n).padStart(2, "0"); }
function ymd(ms: number): string { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function hhmm(ms: number): string { const d = new Date(ms); return `${pad(d.getHours())}${pad(d.getMinutes())}`; }

/**
 * 跨节点把录像聚成「同一场直播」。**按 (platform, roomSlug) 分组**(douyin/bilibili 同房间号不撞),
 * 组内按时间窗(5min 容差)区间合并。streamKey = `{platform}:{roomSlug}:{date}`(同日多簇追加 _HHMM)。
 * platform 取自每条 rec(scan 从 meta.json 读;旧录像 fallback douyin);defaultPlatform 仅作极端兜底。
 */
export function clusterBroadcasts(
  byTenant: { tenantId: string; recordings: NodeRecording[] }[],
  overlapToleranceMs = DEFAULT_TOLERANCE,
  defaultPlatform = "douyin",
): Broadcast[] {
  // 展平成 (tenantId, rec)，按 platform+roomSlug 分组(键含平台),组内按 startMs 排序后区间合并聚簇。
  const flat: BroadcastMember[] = byTenant.flatMap((t) => t.recordings.map((rec) => ({ tenantId: t.tenantId, rec })));
  const groups = new Map<string, BroadcastMember[]>();
  for (const m of flat) {
    const plat = m.rec.platform || defaultPlatform;
    const k = `${plat}:${m.rec.roomSlug}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(m);
  }

  const out: Broadcast[] = [];
  for (const [key, members] of groups) {
    const sep = key.indexOf(":");
    const platform = key.slice(0, sep);
    const roomSlug = key.slice(sep + 1);
    members.sort((a, b) => a.rec.startMs - b.rec.startMs);
    let cluster: BroadcastMember[] = [];
    const flush = (): void => {
      if (!cluster.length) return;
      const startMs = Math.min(...cluster.map((m) => m.rec.startMs));
      out.push({ platform, roomSlug, startMs, members: cluster, streamKey: "" });
      cluster = [];
    };
    for (const m of members) {
      if (cluster.length && cluster.some((c) => overlaps(c.rec, m.rec, overlapToleranceMs))) cluster.push(m);
      else { flush(); cluster = [m]; }
    }
    flush();
  }
  // 同 (platform,房间) 同一天多簇 → streamKey 追加 _HHMM 区分。
  const dayCount = new Map<string, number>();
  for (const b of out) { const k = `${b.platform}:${b.roomSlug}:${ymd(b.startMs)}`; dayCount.set(k, (dayCount.get(k) ?? 0) + 1); }
  for (const b of out) {
    const day = ymd(b.startMs); const base = `${b.platform}:${b.roomSlug}:${day}`;
    b.streamKey = (dayCount.get(base)! > 1) ? `${base}_${hhmm(b.startMs)}` : base;
  }
  return out;
}
