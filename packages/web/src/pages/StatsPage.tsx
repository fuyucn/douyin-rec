import { useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { Activity, BarChart3, Clock, Server, Users } from "lucide-react";
import { api, type StatsDTO } from "../api/client";
import { useT } from "../lib/i18n";

const DOW_KEYS = ["stats.dow.mon", "stats.dow.tue", "stats.dow.wed", "stats.dow.thu", "stats.dow.fri", "stats.dow.sat", "stats.dow.sun"] as const;
/** 热力图表头与数据行共用同一列模板,保证小时列对齐。 */
const HEAT_COLS = "44px repeat(24, minmax(14px, 1fr))";

/** rolling / upload / stage / local → 词典 key;未知值原样显示。 */
function uploadModeLabel(mode: string, t: ReturnType<typeof useT>): string {
  switch (mode) {
    case "rolling": return t("stats.mode.rolling");
    case "upload": return t("stats.mode.upload");
    case "stage": return t("stats.mode.stage");
    case "local": return t("stats.mode.local");
    default: return mode || "—";
  }
}

/** 按服务端时区格式化为 `MM-DD HH:mm`(short)与完整时间(full,用作 title)。 */
function formatCollectedAt(ms: number, timeZone: string): { short: string; full: string } {
  const d = new Date(ms);
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(d);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "";
  const full = new Intl.DateTimeFormat("zh-CN", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(d);
  return { short: `${get("month")}-${get("day")} ${get("hour")}:${get("minute")}`, full: `${full} (${timeZone})` };
}

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

  const dowLabels = DOW_KEYS.map((k) => t(k));
  const heatMax = useMemo(() => {
    if (!data) return 0;
    return Math.max(0.0001, ...data.heatmap.map((c: { hours: number }) => c.hours));
  }, [data]);

  const errorBlock = err ? (
    <div className="flex items-center justify-between gap-3 text-[var(--danger-fg)]">
      <span className="text-sm">{err}</span>
      <button className="btn btn-secondary btn-small" onClick={load} disabled={loading}>{loading ? "…" : t("stats.retry")}</button>
    </div>
  ) : null;
  if (!data) return (
    <div className="space-y-6">
      {errorBlock}
      {!err && <div className="text-muted">{loading ? t("stats.loading") : "—"}</div>}
    </div>
  );

  const o = data.overview;
  const collected = data.lastCollectedAt ? formatCollectedAt(data.lastCollectedAt, data.timeZone) : null;
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
            {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t("stats.daysOption", { days: d })}</option>)}
          </select>
          <button className="btn btn-secondary btn-small" onClick={load} disabled={loading}>
            {loading ? "…" : t("common.refresh")}
          </button>
        </div>
      </div>

      {/* overview cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card icon={<Activity className="w-4 h-4" />} label={t("stats.observedRooms")} value={o.observedRooms} sub={t("stats.knownRooms", { n: o.knownRooms })} />
        <Card icon={<Clock className="w-4 h-4" />} label={t("stats.broadcastHours")} value={`${o.broadcastHours}h`} sub={t("stats.sessionsCount", { n: o.sessions })} />
        <Card icon={<Users className="w-4 h-4" />} label={t("stats.enabledRooms")} value={o.enabledRooms} sub={t("stats.roomsWithSessions", { n: data.rooms.filter((r) => r.sessions > 0).length })} />
        <Card icon={<BarChart3 className="w-4 h-4" />} label={t("stats.collectedAt")} value={collected?.short ?? "—"} title={collected?.full} compact sub={data.empty ? t("stats.emptyHint") : ""} />
      </div>

      {/* upload mode / format / platform breakdown */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Breakdown title={t("stats.uploadMode")} items={o.uploadModes.map((x: { mode: string; count: number }) => ({ label: uploadModeLabel(x.mode, t), count: x.count }))} />
        <Breakdown title={t("stats.outputFormat")} items={o.outputFormats.map((x: { format: string; count: number }) => ({ label: x.format || "—", count: x.count }))} />
        <Breakdown title={t("stats.platform")} items={o.platforms.map((x: { platform: string; count: number }) => ({ label: x.platform, count: x.count }))} />
      </div>
      <div className="text-xs text-muted">{t("stats.danmuEngines", { on: o.danmu.on, off: o.danmu.off, engines: o.engines.map((e) => `${e.engine} ${e.count}`).join(" · ") })}</div>

      {/* global heatmap */}
      <section className="card">
        <h2 className="text-sm font-semibold mb-3">{t("stats.heatmapTitle")}</h2>
        <Heatmap cells={data.heatmap} max={heatMax} labels={dowLabels} />
      </section>

      {/* node load */}
      <section className="card">
        <h2 className="text-sm font-semibold mb-3 flex items-center gap-2"><Server className="w-4 h-4" />{t("stats.nodeLoad")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="text-left text-muted">
              <th className="px-3 py-2">{t("stats.node.node")}</th><th className="px-3 py-2">{t("stats.node.assignedRooms")}</th><th className="px-3 py-2">{t("stats.node.sessions")}</th><th className="px-3 py-2">{t("stats.node.hours")}</th><th className="px-3 py-2">{t("stats.node.peakConcurrent")}</th>
            </tr></thead>
            <tbody>
              {o.nodeLoad.map((n: StatsDTO["overview"]["nodeLoad"][number]) => (
                <tr key={n.workerId} className="border-t border-[var(--border)]">
                  <td className="px-3 py-2 font-mono text-xs">{n.name ?? n.workerId}</td>
                  <td className="px-3 py-2 tabular-nums">{n.assignedRooms}</td>
                  <td className="px-3 py-2 tabular-nums">{n.sessions}</td>
                  <td className="px-3 py-2 tabular-nums">{n.hours}</td>
                  <td className="px-3 py-2 tabular-nums">{n.peakConcurrent}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* rooms table */}
      <section className="card">
        <h2 className="text-sm font-semibold mb-3">{t("stats.roomsTitle")}</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted">
              <th className="px-3 py-1.5">{t("stats.col.anchor")}</th><th className="px-3 py-1.5">{t("stats.col.mode")}</th><th className="px-3 py-1.5">{t("stats.col.format")}</th>
              <th className="px-3 py-1.5">{t("stats.col.sessions")}</th><th className="px-3 py-1.5">{t("stats.col.totalHours")}</th><th className="px-3 py-1.5">{t("stats.col.perDayHours")}</th>
              <th className="px-3 py-1.5">{t("stats.col.avgMedian")}</th><th className="px-3 py-1.5">{t("stats.col.typicalStart")}</th><th className="px-3 py-1.5">{t("stats.col.nodes")}</th>
            </tr></thead>
            <tbody>
              {data.rooms.map((r: NonNullable<StatsDTO["rooms"][number]>) => (
                <tr key={r.key} className="border-t border-[var(--border)]">
                  <td className="px-3 py-1.5">{r.anchorName ?? r.roomSlug}</td>
                  <td className="px-3 py-1.5 whitespace-nowrap">{uploadModeLabel(r.uploadMode, t)}</td>
                  <td className="px-3 py-1.5">{r.outputFormat}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.sessions}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.totalHours}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.perDayHours}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.avgHours}/{r.medianHours}</td>
                  <td className="px-3 py-1.5 tabular-nums">{r.typicalStartHour == null ? "—" : `${r.typicalStartHour}:00`}</td>
                  <td className="px-3 py-1.5">{r.nodes.map((n: { name: string | null; workerId: string; sessions: number }) => `${n.name ?? n.workerId}×${n.sessions}`).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function Card({ icon, label, value, sub, title, compact }: { icon: ReactNode; label: string; value: ReactNode; sub?: string; title?: string; compact?: boolean }): ReactNode {
  return (
    <div className="card p-3 min-w-0">
      <div className="flex items-center gap-2 text-muted text-xs">{icon}{label}</div>
      <div className={`${compact ? "text-base" : "text-xl"} font-semibold tabular-nums mt-1 truncate`} title={title}>{value}</div>
      {sub ? <div className="text-xs text-muted mt-0.5 truncate" title={sub}>{sub}</div> : null}
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
  const hours = Array.from({ length: 24 }, (_, h) => h);
  return (
    <div className="overflow-x-auto px-1 pb-1">
      <div className="grid min-w-[480px]" style={{ gridTemplateColumns: HEAT_COLS, gap: 2 }}>
        <div />
        {hours.map((h) => (
          <div key={`h${h}`} className="text-[9px] text-muted text-center tabular-nums leading-4">{h % 3 === 0 ? h : ""}</div>
        ))}
        {labels.map((lab, dow) => (
          <Fragment key={dow}>
            <div className="text-[10px] text-muted flex items-center pr-1 whitespace-nowrap">{lab}</div>
            {hours.map((h) => {
              const v = map.get(`${dow}:${h}`) ?? 0;
              const a = Math.min(1, v / max);
              return (
                <div key={h} title={`${lab} ${h}:00  ${v.toFixed(2)}h`}
                     className="h-4 rounded-sm" style={{ background: `rgba(59,130,246,${0.08 + a * 0.82})` }} />
              );
            })}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
