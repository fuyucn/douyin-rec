/**
 * StatsPage — `/stats`: window-level live statistics (overview, breakdowns, heatmap, node load, rooms).
 *
 * Same visual language as Rooms/Queue: page head + telemetry band + table-shell/`tasks` tables,
 * so the stats screen reads as part of the product rather than a debug dump.
 */
import { useEffect, useMemo, useRef, useState, Fragment, type ReactNode } from "react";
import { Activity, BarChart3, Clock, FolderOpen, Server, Users } from "lucide-react";
import { api, type StatsDTO } from "../api/client";
import { Button } from "../components/Button";
import { useT } from "../lib/i18n";
import { breakdownShape } from "../lib/stats-breakdown";

const DOW_KEYS = ["stats.dow.mon", "stats.dow.tue", "stats.dow.wed", "stats.dow.thu", "stats.dow.fri", "stats.dow.sat", "stats.dow.sun"] as const;
/** 热力图表头与数据行共用同一列模板,保证小时列对齐;星期列固定宽,格子有最小可读尺寸。 */
const HEAT_COLS = "48px repeat(24, minmax(18px, 1fr))";
/** 热力图色阶:0 = 空格,1..4 = accent 按占比混入 surface。 */
const HEAT_LEVELS = [0, 28, 50, 74, 100] as const;

/** rolling / upload / stage / local → 词典 key;未知值原样显示。 */
function uploadModeLabel(mode: string, t: ReturnType<typeof useT>): string {
  switch (mode) {
    case "rolling": return t("stats.mode.rolling");
    case "upload": return t("stats.mode.upload");
    case "stage": return t("stats.mode.stage");
    case "local": return t("stats.mode.local");
    default: return mode || "-";
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

const hh = (h: number): string => `${String(h).padStart(2, "0")}:00`;

function heatColor(level: number): string {
  return level === 0 ? "var(--surface-soft)" : `color-mix(in srgb, var(--accent) ${HEAT_LEVELS[level]}%, var(--surface))`;
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

  const head = (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mb-6">
      <div className="min-w-0">
        <h1 className="headline page-h1">{t("stats.title")}</h1>
        {data
          ? <p className="text-muted text-sm mt-1.5">{t("stats.subtitle", { days: data.windowDays, tz: data.timeZone })}</p>
          : <span className="skeleton block h-4 w-48 mt-2.5" aria-hidden="true" />}
      </div>
      <div className="flex items-center gap-2">
        <select className="select !h-8 !w-auto text-[13px]" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {[7, 14, 30, 60, 90].map((d) => <option key={d} value={d}>{t("stats.daysOption", { days: d })}</option>)}
        </select>
        <Button small variant="secondary" onClick={load} disabled={loading} loading={loading}>
          {t("common.refresh")}
        </Button>
      </div>
    </div>
  );

  const errorBlock = err ? (
    <div className="status-strip mb-5" role="alert">
      <span className="dot" style={{ background: "var(--error)" }} />
      <span className="flex-1 min-w-0 truncate" style={{ color: "var(--error-fg)" }} title={err}>{err}</span>
      <Button small variant="secondary" onClick={load} disabled={loading}>{t("stats.retry")}</Button>
    </div>
  ) : null;

  if (!data) return (
    <>
      {head}
      {errorBlock}
      {!err && <StatsSkeleton />}
    </>
  );

  if (data.empty) return (
    <>
      {head}
      {errorBlock}
      <div className="empty-state">
        <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
        <div className="text-sm font-medium text-ink">{t("stats.emptyTitle")}</div>
        <div className="text-[13px] text-muted max-w-sm">{t("stats.emptyHint")}</div>
      </div>
    </>
  );

  const o = data.overview;
  const collected = data.lastCollectedAt ? formatCollectedAt(data.lastCollectedAt, data.timeZone) : null;
  return (
    <>
      {head}
      {errorBlock}

      <div className="telemetry-bar mb-5">
        <Metric icon={<Activity className="w-4 h-4" />} label={t("stats.observedRooms")} value={o.observedRooms} sub={t("stats.knownRooms", { n: o.knownRooms })} />
        <Metric icon={<Clock className="w-4 h-4" />} label={t("stats.broadcastHours")} value={`${o.broadcastHours}h`} sub={t("stats.sessionsCount", { n: o.sessions })} />
        <Metric icon={<Users className="w-4 h-4" />} label={t("stats.enabledRooms")} value={o.enabledRooms} sub={t("stats.roomsWithSessions", { n: data.rooms.filter((r) => r.sessions > 0).length })} />
        <Metric icon={<BarChart3 className="w-4 h-4" />} label={t("stats.collectedAt")} value={collected?.short ?? "-"} title={collected?.full} mono sub={data.timeZone} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
        <Breakdown title={t("stats.uploadMode")} items={o.uploadModes.map((x: { mode: string; count: number }) => ({ label: uploadModeLabel(x.mode, t), count: x.count }))} />
        <Breakdown title={t("stats.outputFormat")} items={o.outputFormats.map((x: { format: string; count: number }) => ({ label: x.format || "-", count: x.count }))} />
        <Breakdown title={t("stats.platform")} items={o.platforms.map((x: { platform: string; count: number }) => ({ label: x.platform, count: x.count }))} />
      </div>
      <div className="font-mono text-[11px] text-muted-soft mb-6">
        {t("stats.danmuEngines", { on: o.danmu.on, off: o.danmu.off, engines: o.engines.map((e) => `${e.engine} ${e.count}`).join(" · ") })}
      </div>

      <section className="card mb-6">
        <SectionHead title={t("stats.heatmapTitle")} />
        <div className="p-5">
          <Heatmap cells={data.heatmap} max={heatMax} labels={dowLabels} />
          <div className="mt-4 flex items-center justify-end gap-2 font-mono text-[11px] text-muted">
            <span>{t("stats.legendLess")}</span>
            {HEAT_LEVELS.map((_, lv) => <span key={lv} className="w-3.5 h-3.5 rounded-[3px]" style={{ background: heatColor(lv) }} />)}
            <span>{t("stats.legendMore")}</span>
            <span className="ml-3 text-muted-soft tabular-nums">{t("stats.legendPeak", { h: heatMax < 0.01 ? 0 : heatMax.toFixed(2) })}</span>
          </div>
        </div>
      </section>

      <section className="table-shell mb-6">
        <SectionHead icon={<Server className="w-4 h-4" />} title={t("stats.nodeLoad")} />
        <div className="overflow-x-auto">
          <table className="tasks min-w-[560px]">
            <thead>
              <tr>
                <th>{t("stats.node.node")}</th>
                <th className="text-right">{t("stats.node.assignedRooms")}</th>
                <th className="text-right">{t("stats.node.sessions")}</th>
                <th className="text-right">{t("stats.node.hours")}</th>
                <th className="text-right">{t("stats.node.peakConcurrent")}</th>
              </tr>
            </thead>
            <tbody>
              {o.nodeLoad.map((n: StatsDTO["overview"]["nodeLoad"][number]) => (
                <tr key={n.workerId}>
                  <td className="font-mono text-[12.5px] text-ink" title={n.workerId}>{n.name ?? n.workerId}</td>
                  <Num>{n.assignedRooms}</Num>
                  <Num>{n.sessions}</Num>
                  <Num>{n.hours}</Num>
                  <Num>{n.peakConcurrent}</Num>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="table-shell">
        <SectionHead title={t("stats.roomsTitle")} />
        <div className="overflow-x-auto">
          {/* 固定列宽:9 列在 1024 视口会挤出 64px 横向滚动(实测 1038 vs 974)。固定布局把列宽压到
              合计 940px,窄屏不再出现「只能看到前 8.2 列」的横向漂移,被截断的单元格都带 title。 */}
          <table className="tasks stats-rooms-table min-w-[940px]" style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="w-[192px]">{t("stats.col.anchor")}</th>
                <th className="w-[112px]">{t("stats.col.mode")}</th>
                <th className="w-[92px]">{t("stats.col.format")}</th>
                <th className="w-[72px] text-right">{t("stats.col.sessions")}</th>
                <th className="w-[84px] text-right">{t("stats.col.totalHours")}</th>
                <th className="w-[88px] text-right">{t("stats.col.perDayHours")}</th>
                <th className="w-[120px] text-right">{t("stats.col.avgMedian")}</th>
                <th className="w-[88px] text-right">{t("stats.col.typicalStart")}</th>
                <th className="w-[112px]">{t("stats.col.nodes")}</th>
              </tr>
            </thead>
            <tbody>
              {data.rooms.map((r: NonNullable<StatsDTO["rooms"][number]>) => {
                const nodes = r.nodes.map((n: { name: string | null; workerId: string; sessions: number }) => `${n.name ?? n.workerId}×${n.sessions}`).join(", ");
                return (
                  <tr key={r.key}>
                    <td className="max-w-[192px]">
                      <div className="font-medium text-ink truncate" title={r.anchorName ?? r.roomSlug}>{r.anchorName ?? r.roomSlug}</div>
                      <div className="mt-1 flex items-center gap-1.5 min-w-0">
                        <span className="badge badge-muted shrink-0">{r.platform}</span>
                        <span className="font-mono text-xs text-muted truncate">{r.roomSlug}</span>
                      </div>
                    </td>
                    {/* EN 标签比中文长("Rolling upload" 111px vs "边录边传"):固定列宽下换行,别让 shell 裁掉。 */}
                    <td><span className="badge badge-muted text-[11px] max-w-full whitespace-normal leading-[1.35]">{uploadModeLabel(r.uploadMode, t)}</span></td>
                    <td className="font-mono text-[12px] text-muted">{r.outputFormat || "-"}</td>
                    <Num>{r.sessions}</Num>
                    <Num>{r.totalHours}</Num>
                    <Num strong>{r.perDayHours}</Num>
                    <Num>{r.avgHours}<span className="text-muted-soft"> / </span>{r.medianHours}</Num>
                    <Num>{r.typicalStartHour == null ? <span className="text-muted-soft">-</span> : hh(r.typicalStartHour)}</Num>
                    <td className="font-mono text-[11px] text-muted truncate max-w-[200px]" title={nodes}>{nodes || "-"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function SectionHead({ title, icon }: { title: string; icon?: ReactNode }): ReactNode {
  return (
    <div className="flex items-center gap-2 px-5 py-4 border-b border-[var(--hairline)]">
      {icon && <span className="text-muted">{icon}</span>}
      <h2 className="text-[15px] font-semibold text-ink leading-tight">{title}</h2>
    </div>
  );
}

/** 数字单元格:统一右对齐 + 等宽数字。 */
function Num({ children, strong }: { children: ReactNode; strong?: boolean }): ReactNode {
  return <td className={`text-right tabular-nums whitespace-nowrap font-mono text-[12.5px] ${strong ? "text-ink font-medium" : "text-body"}`}>{children}</td>;
}

function Metric({ icon, label, value, sub, title, mono }: { icon: ReactNode; label: string; value: ReactNode; sub: string; title?: string; mono?: boolean }): ReactNode {
  return (
    <div className="telemetry-cell">
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="telemetry-label truncate">{label}</span>
        <span className={`telemetry-value tabular-nums truncate${mono ? " telemetry-value-mono" : ""}`} title={title}>{value}</span>
        <span className="text-[11.5px] text-muted-soft truncate" title={sub}>{sub}</span>
      </div>
      <span className="telemetry-icon">{icon}</span>
    </div>
  );
}

function Breakdown({ title, items }: { title: string; items: { label: string; count: number }[] }): ReactNode {
  const shape = breakdownShape(items);
  const total = items.reduce((a, b) => a + b.count, 0) || 1;
  return (
    <div className="card px-5 py-4 min-w-0">
      <div className="section-label mb-3">{title}</div>
      {shape.kind === "empty" ? <div className="text-[12px] text-muted-soft">—</div>
        : shape.kind === "single" ? (
          // 单个类别:占比恒为 100%,满条不携带任何信息 → 一行 label · count。
          <div className="flex items-baseline justify-between gap-3 min-w-0">
            <span className="text-[12.5px] text-body truncate" title={shape.item.label}>{shape.item.label}</span>
            <span className="font-mono text-[12px] text-ink tabular-nums shrink-0">{shape.item.count}</span>
          </div>
        ) : (
          <div className="grid grid-cols-[88px_minmax(0,1fr)_36px] items-center gap-x-3 gap-y-2.5">
            {shape.items.map((it) => (
              <Fragment key={it.label}>
                <span className="text-[12.5px] text-body truncate" title={it.label}>{it.label}</span>
                <div className="h-2 rounded-sm bg-[var(--surface-soft)] overflow-hidden">
                  <div className="h-full rounded-sm bg-[var(--accent)]" style={{ width: `${(it.count / total) * 100}%` }} />
                </div>
                <span className="font-mono text-[12px] text-ink tabular-nums text-right">{it.count}</span>
              </Fragment>
            ))}
          </div>
        )}
    </div>
  );
}

type HeatTip = { text: string; x: number; y: number };

function Heatmap({ cells, max, labels }: { cells: { dow: number; hour: number; hours: number }[]; max: number; labels: string[] }): ReactNode {
  const map = new Map(cells.map((c) => [`${c.dow}:${c.hour}`, c.hours]));
  const hours = Array.from({ length: 24 }, (_, h) => h);
  const [tip, setTip] = useState<HeatTip | null>(null);
  return (
    <div className="overflow-x-auto" onMouseLeave={() => setTip(null)} onScroll={() => setTip(null)}>
      <div className="grid min-w-[480px]" style={{ gridTemplateColumns: HEAT_COLS, gap: 3 }}>
        <div />
        {hours.map((h) => (
          <div key={`h${h}`} className="font-mono text-[11px] text-muted-soft tabular-nums leading-4 pb-1">{h % 3 === 0 ? String(h).padStart(2, "0") : ""}</div>
        ))}
        {labels.map((lab, dow) => (
          <Fragment key={dow}>
            <div className="text-[11px] text-muted flex items-center whitespace-nowrap">{lab}</div>
            {hours.map((h) => {
              const v = map.get(`${dow}:${h}`) ?? 0;
              const level = v <= 0 ? 0 : Math.max(1, Math.ceil(Math.min(1, v / max) * 4));
              const text = `${lab} ${hh(h)} · ${v.toFixed(2)}h`;
              return (
                <div key={h} aria-label={text}
                     className="h-5 rounded-[3px] transition-[outline-color] outline outline-1 outline-transparent hover:outline-[var(--ink)]"
                     style={{ background: heatColor(level) }}
                     onMouseEnter={(e) => {
                       const r = e.currentTarget.getBoundingClientRect();
                       setTip({ text, x: r.left + r.width / 2, y: r.top });
                     }} />
              );
            })}
          </Fragment>
        ))}
      </div>
      {tip && (
        <div className="tooltip-popup tabular-nums pointer-events-none whitespace-nowrap"
             style={{ position: "fixed", left: tip.x, top: tip.y - 6, transform: "translate(-50%, -100%)", zIndex: 200 }}>
          {tip.text}
        </div>
      )}
    </div>
  );
}

function StatsSkeleton(): ReactNode {
  return (
    <div aria-hidden="true">
      <div className="telemetry-bar mb-5">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="telemetry-cell">
            <div className="flex flex-col gap-2 min-w-0 flex-1">
              <span className="skeleton block h-3 w-20" />
              <span className="skeleton block h-5 w-14" />
              <span className="skeleton block h-3 w-24" />
            </div>
            <span className="skeleton block w-8 h-8" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-6">
        {[0, 1, 2].map((i) => (
          <div key={i} className="card px-5 py-4 space-y-3">
            <span className="skeleton block h-3 w-16" />
            <span className="skeleton block h-2 w-full" />
            <span className="skeleton block h-2 w-3/4" />
          </div>
        ))}
      </div>
      <div className="card mb-6">
        <div className="px-5 py-4 border-b border-[var(--hairline)]"><span className="skeleton block h-4 w-56" /></div>
        <div className="p-5"><span className="skeleton block h-[172px] w-full" /></div>
      </div>
      <div className="table-shell">
        <div className="px-5 py-4 border-b border-[var(--hairline)]"><span className="skeleton block h-4 w-40" /></div>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="task-compact px-5 py-3.5 flex items-center gap-6">
            <span className="skeleton block h-4 w-40" />
            <span className="skeleton block h-4 w-16 ml-auto" />
            <span className="skeleton block h-4 w-16" />
          </div>
        ))}
      </div>
    </div>
  );
}
