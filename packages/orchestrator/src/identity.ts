import { isSameBroadcast, isSameBroadcastGap, processTimeZone, SAME_BROADCAST_GAP_MS, zonedStamp } from "@drec/core";
import type { NodeRecording } from "./transport.js";

export interface BroadcastMember { workerId: string; rec: NodeRecording; }
export interface Broadcast { streamKey: string; platform: string; roomSlug: string; startMs: number; members: BroadcastMember[]; }

function overlaps(a: NodeRecording, b: NodeRecording, tol: number): boolean {
  return isSameBroadcastGap(a.startMs - b.endMs, tol) && isSameBroadcastGap(b.startMs - a.endMs, tol);
}

/** Issue #320: live ids decide when both are known; otherwise the time-window overlap as before. */
function sameBroadcast(a: NodeRecording, b: NodeRecording, tol: number): boolean {
  if (a.liveSessionId && b.liveSessionId) return isSameBroadcast({ aLiveId: a.liveSessionId, bLiveId: b.liveSessionId, gapMs: 0 });
  return overlaps(a, b, tol);
}

function ymd(ms: number, tz: string): string { return zonedStamp(ms, tz).date; }
function hhmm(ms: number, tz: string): string { const z = zonedStamp(ms, tz); return `${z.hh}${z.mm}`; }

/**
 * 跨节点把录像聚成「同一场直播」。**按 (platform, roomSlug) 分组**(douyin/bilibili 同房间号不撞),
 * 组内按时间窗(间隔 <= 60min 为同一场,core `SAME_BROADCAST_GAP_MS`)区间合并;两条录像都带平台 liveId 时
 * 只看 liveId 是否相同(issue #320,core `isSameBroadcast`)。streamKey = `{platform}:{roomSlug}:{date}`(同日多簇追加 _HHMM)。
 * platform 取自每条 rec(scan 从 meta.json 读;旧录像 fallback douyin);defaultPlatform 仅作极端兜底。
 */
export function clusterBroadcasts(
  byTenant: { workerId: string; recordings: NodeRecording[] }[],
  overlapToleranceMs = SAME_BROADCAST_GAP_MS,
  defaultPlatform = "douyin",
  knownKeys: Iterable<{ streamKey: string; startMs?: number | null; updatedAt?: number }> = [],
  /** streamKey 日期所用时区(设置时区);缺省 = 进程生效时区,不看宿主机本地时区(issue #155)。 */
  timeZone: string = processTimeZone(),
): Broadcast[] {
  // 展平成 (workerId, rec)，按 platform+roomSlug 分组(键含平台),组内按 startMs 排序后区间合并聚簇。
  const flat: BroadcastMember[] = byTenant.flatMap((t) => t.recordings.map((rec) => ({ workerId: t.workerId, rec })));
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
      if (cluster.length && cluster.some((c) => sameBroadcast(c.rec, m.rec, overlapToleranceMs))) cluster.push(m);
      else { flush(); cluster = [m]; }
    }
    flush();
  }
  // 同 (platform,房间) 同一天多簇 → streamKey 追加 _HHMM 区分。
  const dayCount = new Map<string, number>();
  for (const b of out) { const k = `${b.platform}:${b.roomSlug}:${ymd(b.startMs, timeZone)}`; dayCount.set(k, (dayCount.get(k) ?? 0) + 1); }
  const known = new Map(Array.from(knownKeys, (k) => [k.streamKey, k]));
  for (const b of out) {
    const day = ymd(b.startMs, timeZone); const base = `${b.platform}:${b.roomSlug}:${day}`;
    const knownJob = known.get(base);
    // 已知 job 与当前簇同一场(开录时间在容差内)→ 继续用 base(幂等);
    // 旧库无 startMs 时,用「开录早于 job 最后更新」近似判断,避免把已 done 的第一场误判成第二场。
    const sameAsKnown = knownJob
      ? knownJob.startMs != null
        ? Math.abs(knownJob.startMs - b.startMs) <= overlapToleranceMs
        : b.startMs <= (knownJob.updatedAt ?? 0) + overlapToleranceMs
      : false;
    // 同一天多簇 + 已存在的异场 job 都要 _HHMM,否则会复用 base key 被幂等跳过。
    const clash = dayCount.get(base)! > 1;
    b.streamKey = (clash || knownJob) && !sameAsKnown ? `${base}_${hhmm(b.startMs, timeZone)}` : base;
  }
  return out;
}
