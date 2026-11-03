import { useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { Activity, BarChart3, Clock, Server, Users } from "lucide-react";
import { api, type StatsDTO } from "../api/client";
import { useT } from "../lib/i18n";

const DOW_LABELS = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];


export function StatsPage(): ReactNode {
  const t = useT();
  const [days, setDays] = useState(30);
  const [data, setData] = useState<StatsDTO | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const reqIdRef = useRef(0);
  const load = (): void => {
    const myId = ++reqIdRef.current;
    setLoading(true);
    setErr(null);
    void api.getStats(days)
      .then((d) => { if (reqIdRef.current === myId) setData(d); })
      .catch((e) => { if (reqIdRef.current === myId) setErr(String(e?.message ?? e)); })
      .finally(() => { if (reqIdRef.current === myId) setLoading(false); });
  };
  useEffect(() => { load(); }, [days]);

  const dowLabels = DOW_LABELS;
  const heatMax = useMemo(() => {
    if (!data) return 0;
    return Math.max(0.0001, ...data.heatmap.map((c: { hours: number }) => c.hours));
  }, [data]);

  const errorBlock = err ? (
    <div className="flex items-center justify-between gap-3 text-[var(--danger-fg)]">
      <span className="text-sm">{err}</span>
      <button className="btn btn-secondary btn-small" onClick={load} disabled={loading}>{loading ? "…" : "重试"}</button>
    </div>
  ) : null;
  if (!data) return (
    <div className="space-y-6">
      {errorBlock}
      {!err && <div className="text-muted">{loading ? "加载中…" : "—"}</div>}
    </div>
  );

  const o = data.overview;
  return (
    <div className="space-y-6">
      {errorBlock}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("stats.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("stats.subtitle", { days: data.windowDays, tz: data.timeZone })}</p>
        </div>
        <div className="flex items-center gap-2">
          <select className="input" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{d} 天</option>)}
          </select>
          <button className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
            {loading ? "…" : "刷新"}
          </button>
        </div>
      </div>

      {/* overview cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card icon={<Activity className="w-4 h-4" />} label="已观测直播间" value={o.observedRooms} sub={`/ ${o.knownRooms} 个已知`} />
        <Card icon={<Clock className="w-4 h-4" />} label="总在播时长" value={`${o.broadcastHours}h`} sub={`${o.sessions} 场`} />
        <Card icon={<Users className="w-4 h-4" />} label="已启用" value={o.enabledRooms} sub={`窗口内有场次 ${data.rooms.filter((r) => r.sessions > 0).length}`} />
        <Card icon={<BarChart3 className="w-4 h-4" />} label="采集时间" value={data.lastCollectedAt ? new Date(data.lastCollectedAt).toLocaleString() : "—"} sub={data.empty ? "暂无数据(等待对账)" : ""} />
      </div>

      {/* upload mode / format / platform breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Breakdown title="上传模式" items={o.uploadModes.map((x: { mode: string; count: number }) => ({ label: x.mode || "—", count: x.count }))} />
        <Breakdown title="输出格式" items={o.outputFormats.map((x: { format: string; count: number }) => ({ label: x.format || "—", count: x.count }))} />
        <Breakdown title="平台" items={o.platforms.map((x: { platform: string; count: number }) => ({ label: x.platform, count: x.count }))} />
      </div>
      <div className="text-xs text-muted">弹幕:开 {o.danmu.on} / 关 {o.danmu.off} · 引擎: {o.engines.map((e) => `${e.engine} ${e.count}`).join(" · ")}</div>

      {/* global heatmap */}
      <section className="card">
        <h2 className="text-sm font-semibold mb-3">全局在播热力图(跨节点去重,小时)</h2>
        <Heatmap cells={data.heatmap} max={heatMax} labels={dowLabels} />
      </section>

      {/* node load */}
      <section className="card">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Server className="w-4 h-4" />节点负载</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted">
              <th className="py-1 pr-3">节点</th><th className="py-1 pr-3">分配房间</th><th className="py-1 pr-3">会话数</th><th className="py-1 pr-3">小时</th><th className="py-1 pr-3">峰值并发</th>
            </tr></thead>
            <tbody>
              {o.nodeLoad.map((n: StatsDTO["overview"]["nodeLoad"][number]) => (
                <tr key={n.workerId} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-3 font-mono text-xs">{n.name ?? n.workerId}</td>
                  <td className="py-1 pr-3 tabular-nums">{n.assignedRooms}</td>
                  <td className="py-1 pr-3 tabular-nums">{n.sessions}</td>
                  <td className="py-1 pr-3 tabular-nums">{n.hours}</td>
                  <td className="py-1 pr-3 tabular-nums">{n.peakConcurrent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* rooms table */}
      <section className="card">
        <h2 className="text-sm font-semibold mb-3">直播间明细(按每日常规在播时长排序)</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted">
              <th className="py-1 pr-2">主播</th><th className="py-1 pr-2">模式</th><th className="py-1 pr-2">格式</th>
              <th className="py-1 pr-2">场次</th><th className="py-1 pr-2">总时长h</th><th className="py-1 pr-2">每天h</th>
              <th className="py-1 pr-2">均/中位</th><th className="py-1 pr-2">典型开播</th><th className="py-1 pr-2">节点</th>
            </tr></thead>
            <tbody>
              {data.rooms.map((r: NonNullable<StatsDTO["rooms"][number]>) => (
                <tr key={r.key} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2">{r.anchorName ?? r.roomSlug}</td>
                  <td className="py-1 pr-2">{r.uploadMode}</td>
                  <td className="py-1 pr-2">{r.outputFormat}</td>
                  <td className="py-1 pr-2 tabular-nums">{r.sessions}</td>
                  <td className="py-1 pr-2 tabular-nums">{r.totalHours}</td>
                  <td className="py-1 pr-2 tabular-nums">{r.perDayHours}</td>
                  <td className="py-1 pr-2 tabular-nums">{r.avgHours}/{r.medianHours}</td>
                  <td className="py-1 pr-2 tabular-nums">{r.typicalStartHour == null ? "—" : `${r.typicalStartHour}:00`}</td>
                  <td className="py-1 pr-2">{r.nodes.map((n: { name: string | null; workerId: string; sessions: number }) => `${n.name ?? n.workerId}×${n.sessions}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Card({ icon, label, value, sub }: { icon: ReactNode; label: string; value: ReactNode; sub?: string }): ReactNode {
  return (
    <div className="card p-3">
      <div className="flex items-center gap-2 text-muted text-xs">{icon}{label}</div>
      <div className="text-xl font-semibold tabular-nums mt-1">{value}</div>
      {sub ? <div className="text-xs text-muted mt-0.5">{sub}</div> : null}
    </div>
  );
}

function Breakdown({ title, items }: { title: string; items: { label: string; count: number }[] }): ReactNode {
  const total = items.reduce((a, b) => a + b.count, 0) || 1;
  return (
    <div className="card p-3">
      <div className="text-xs font-semibold mb-2">{title}</div>
      <div className="space-y-1">
        {items.map((it) => (
          <div key={it.label} className="flex items-center gap-2 text-xs">
            <span className="w-24 truncate">{it.label}</span>
            <div className="flex-1 h-2 rounded bg-[var(--border)] overflow-hidden">
              <div className="h-full bg-[var(--accent)]" style={{ width: `${(it.count / total) * 100}%` }} />
            </div>
            <span className="tabular-nums w-8 text-right">{it.count}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Heatmap({ cells, max, labels }: { cells: { dow: number; hour: number; hours: number }[]; max: number; labels: string[] }): ReactNode {
  const map = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.hours]));
  return (
    <div className="overflow-x-auto">
      <div className="grid" style={{ gridTemplateColumns: `40px repeat(24, minmax(14px, 1fr))`, gap: 2 }}>
        <div />
        {Array.from({ length: 24 }).map((_, h) => (
          <div key={h} className="text-[9px] text-muted text-center">{h % 3 === 0 ? h : ""}</div>
        ))}
        {labels.map((lab, dow) => (
          <Fragment key={dow}>
            <div key={`l${dow}`} className="text-[10px] text-muted flex items-center">{lab}</div>
            {Array.from({ length: 24 }).map((_, h) => {
              const v = map.get(`${dow}:${h}`) ?? 0;
              const a = Math.min(1, v / max);
              return (
                <div key={`${dow}-${h}`} title={`${lab} ${h}:00  ${v.toFixed(2)}h`}
                     className="h-4 rounded-sm" style={{ background: `rgba(59,130,246,${0.08 + a * 0.82})` }} />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
