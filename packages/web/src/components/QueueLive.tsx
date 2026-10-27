import { useState, type ReactNode } from "react";
import { Activity, ArrowRight, Check, ChevronDown, Clock3, ExternalLink, FileText, Gauge, Loader2, Timer } from "lucide-react";
import { Link } from "react-router-dom";
import type { HubBlockedBroadcastDTO, HubPoolSnapshotDTO, QueueItemDTO } from "../api/client";
import { humanSec, JobLogDialog } from "./HubJobs";
import { useT } from "../lib/i18n";
import { platformLabel, roomId } from "../lib/labels";
import { liveStepLabel } from "../lib/queue-live";
import { countNodeHealth, fmtBytes, type NodeSummary } from "../lib/nodes-summary";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

function stepLabel(t: TFunc, step: string): string {
  const key = `hub.jobs.stepNode.${step}`;
  const label = t(key);
  return label === key ? step : label;
}

function sessionLabel(streamKey: string): string {
  const suffix = streamKey.split(":").slice(2).join(":");
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2}))?(-zd)?$/.exec(suffix);
  if (!m) return suffix;
  return `${m[1]!.slice(5)}${m[2] ? ` ${m[2]}:${m[3]}` : ""}${m[4] ? " · 0落盘" : ""}`;
}

/** Real node-upload telemetry; no synthetic percentages. */
function uploadLine(item: QueueItemDTO, t: TFunc): ReactNode {
  const u = item.nodeUpload;
  if (!u) return null;
  const p = u.progress;
  const pct = p && p.totalBytes > 0 ? Math.min(100, Math.max(0, (p.doneBytes / p.totalBytes) * 100)) : null;
  return (
    <div className="mt-2 space-y-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted">
        <span className="inline-flex items-center gap-1"><Gauge className="w-3 h-3" />{t("queue.live.upload")}</span>
        <span>{u.nodeId}</span>
        <span>{u.phase}{u.step ? ` · ${u.step}` : ""}</span>
        {p && <span>{fmtBytes(p.doneBytes)} / {fmtBytes(p.totalBytes)}</span>}
        {p?.bps != null && p.bps > 0 && <span>{fmtBytes(p.bps)}/s</span>}
        {u.attempts != null && u.attempts > 1 && <span>{t("queue.nodeUpload.attempt", { n: u.attempts })}</span>}
      </div>
      {pct != null && <div className="live-progress"><span style={{ width: `${pct}%` }} /></div>}
    </div>
  );
}

/**
 * One active pipeline lane. The current step and future steps are real ledger data; elapsed/ETA
 * are locally ticked from the last successful snapshot rather than invented.
 */
export function LiveLane({ item, now, dataAt, onOpenLog }: {
  item: QueueItemDTO;
  now: number;
  dataAt: number;
  onOpenLog: (key: string) => void;
}): ReactNode {
  const t = useT();
  const drift = Math.max(0, Math.round((now - dataAt) / 1000));
  const elapsed = item.currentStepSec != null ? Math.max(0, Math.round(item.currentStepSec + drift)) : null;
  const eta = item.etaSec != null ? Math.max(0, Math.round(item.etaSec - drift)) : null;
  const done = item.doneSteps.map((s) => s.step);
  const currentKey = liveStepLabel(item);
  const current = item.phase === "queued"
    ? `${t("queue.live.waiting")}${item.resource ? ` · ${item.resource.toUpperCase()}` : ""}`
    : currentKey === "preparing" ? t("queue.doing.preparing") : stepLabel(t, currentKey);
  const next = item.nextSteps;
  const phaseText = item.phase === "queued"
    ? `${t("queue.live.waiting")}${item.queuePosition ? ` · ${t("queue.live.queueAt", { n: item.queuePosition })}` : ""}`
    : item.phase === "waiting_settle" ? t("queue.phase.settle") : t("queue.phase.running");

  return (
    <article className="live-lane" data-phase={item.phase}>
      <div className="live-lane-head">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2 min-w-0">
            <span className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</span>
            <span className="font-mono text-[11px] text-muted-soft shrink-0">{sessionLabel(item.streamKey)}</span>
          </div>
          <div className="font-mono text-[11px] text-muted-soft mt-0.5">
            {platformLabel(item.platform)} · {item.roomSlug}
          </div>
        </div>
        <span className="badge badge-neutral ml-auto">
          {item.phase === "queued" ? <Clock3 className="w-3 h-3" /> : <Activity className="w-3 h-3" />}
          {phaseText}
        </span>
        {elapsed != null && <span className="font-mono text-[11px] text-muted">{t("queue.live.started")} {humanSec(elapsed)}</span>}
        {eta != null && item.phase !== "queued" && <span className="font-mono text-[11px] text-muted">{t("queue.live.eta")} {humanSec(eta)}</span>}
        {item.winnerWorker && (
          <span className="live-candidates">
            <span className="live-candidate" data-winner="true"><Check className="w-3 h-3" />{item.winnerWorker}</span>
          </span>
        )}
        <button type="button" className="icon-btn !w-7 !h-7 ml-auto" title={t("hub.jobs.viewLog")} aria-label={t("hub.jobs.viewLog")} onClick={() => onOpenLog(item.streamKey)}>
          <FileText className="w-3.5 h-3.5" />
        </button>
        <Link to={`/rooms/${encodeURIComponent(`${item.platform}.${item.roomSlug}`)}`} className="icon-btn !w-7 !h-7" title={t("queue.openRoom")} aria-label={t("queue.openRoom")}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="live-flow" role="group" aria-label={t("queue.live.current")}>
        {done.map((s) => (
          <div key={`d-${s}`} className="live-flow-step" data-state="done">
            <div className="flex items-center gap-1.5 text-[11px] font-mono"><Check className="w-3 h-3" style={{ color: "var(--success-fg)" }} />{stepLabel(t, s)}</div>
          </div>
        ))}
        <div className="live-flow-step" data-state="current">
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            {item.phase === "queued" ? <Clock3 className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
            {current}
          </div>
          {item.queuePosition != null && <div className="text-[10px] text-muted mt-1">{t("queue.live.queueAt", { n: item.queuePosition })}</div>}
        </div>
        {next.slice(0, 4).map((s) => (
          <div key={`n-${s}`} className="live-flow-step" data-state="next">
            <div className="text-[11px] font-mono">{stepLabel(t, s)}</div>
          </div>
        ))}
        {next.length > 4 && <div className="live-flow-step" data-state="next"><ArrowRight className="w-3 h-3" /> +{next.length - 4}</div>}
      </div>
      {uploadLine(item, t)}
    </article>
  );
}

/** Resource pool strip: only real slots and cooldown values. */
export function LivePool({ pool }: { pool: HubPoolSnapshotDTO }): ReactNode {
  const t = useT();
  const cooldown = Math.max(0, Math.round((pool.upload.cooldownUntil - Date.now()) / 1000));
  const uploadUsage = pool.upload.windowLimit > 0
    ? `${pool.upload.windowUsed}/${pool.upload.windowLimit}`
    : t("queue.pool.unlimited");
  return (
    <div className="telemetry-bar telemetry-bar-cols-3 mb-5">
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5">
          <span className="telemetry-label">{t("queue.pool.cpu")}</span>
          <span className="telemetry-value tabular-nums">
            {pool.cpu.active}/{pool.cpu.max || "-"}
            {pool.cpu.queued > 0 && <span className="text-muted-soft font-normal text-[13px]"> · {t("queue.pool.queued", { n: pool.cpu.queued })}</span>}
          </span>
        </div>
        <span className="telemetry-icon"><Gauge className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5">
          <span className="telemetry-label">{t("queue.pool.upload")}</span>
          <span className="telemetry-value tabular-nums">
            {uploadUsage}
            {pool.upload.queued > 0 && <span className="text-muted-soft font-normal text-[13px]"> · {t("queue.pool.queued", { n: pool.upload.queued })}</span>}
          </span>
        </div>
        <span className="telemetry-icon"><ArrowRight className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("queue.pool.cooldown")}</span><span className="telemetry-value tabular-nums" style={{ color: cooldown ? "var(--warning-fg)" : undefined }}>{cooldown ? humanSec(cooldown) : t("queue.pool.noCooldown")}</span></div>
        <span className="telemetry-icon"><Timer className="w-4 h-4" /></span>
      </div>
    </div>
  );
}

/** Collapsible attention cause with a few concrete examples; the full list remains in History. */
export function AttentionCard({ kind, rows, blocked, onOpenLog, onAck, defaultOpen = false }: {
  kind: string;
  rows: QueueItemDTO[];
  blocked: HubBlockedBroadcastDTO[];
  onOpenLog: (key: string) => void;
  onAck: (key: string) => void;
  defaultOpen?: boolean;
}): ReactNode {
  const t = useT();
  const [open, setOpen] = useState(defaultOpen);
  const count = rows.length + blocked.length;
  return (
    <details className="attention-group" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <ChevronDown className="w-3.5 h-3.5 transition-transform" />
        <span className="font-medium text-ink">{t(`queue.attention.${kind}`)}</span>
        <span className="font-mono text-[11px] text-muted-soft">{count}</span>
      </summary>
      {rows.map((r) => (
        <div key={r.streamKey} className="attention-row">
          <span className="font-medium text-ink">{r.anchorName ?? roomId(r.roomSlug)}</span>
          <span className="font-mono text-[11px] text-muted-soft">{sessionLabel(r.streamKey)}</span>
          <span className="text-[11px] text-muted truncate max-w-full" title={r.error ?? undefined}>{r.error}</span>
          <span className="ml-auto inline-flex items-center gap-0.5">
            {r.state === "needs_manual" && (
              <button type="button" className="icon-btn !w-7 !h-7" title={t("queue.ack.action")} aria-label={t("queue.ack.action")} onClick={() => onAck(r.streamKey)}>
                <Check className="w-3.5 h-3.5" />
              </button>
            )}
            <button type="button" className="icon-btn !w-7 !h-7" title={t("hub.jobs.viewLog")} aria-label={t("hub.jobs.viewLog")} onClick={() => onOpenLog(r.streamKey)}>
              <FileText className="w-3.5 h-3.5" />
            </button>
            <Link to={`/rooms/${encodeURIComponent(`${r.platform}.${r.roomSlug}`)}`} className="icon-btn !w-7 !h-7" title={t("queue.openRoom")} aria-label={t("queue.openRoom")}>
              <ExternalLink className="w-3.5 h-3.5" />
            </Link>
          </span>
        </div>
      ))}
      {blocked.map((b) => (
        <div key={b.streamKey} className="attention-row">
          <span className="font-medium text-ink">{b.anchorName ?? b.roomSlug}</span>
          <span className="text-[11px]" style={{ color: "var(--error-fg)" }}>{t("queue.blocked.by", { nodes: b.workers.join(", ") })}</span>
          <Link to={`/rooms/${encodeURIComponent(`${b.platform}.${b.roomSlug}`)}`} className="icon-btn !w-7 !h-7 ml-auto" title={t("queue.openRoom")} aria-label={t("queue.openRoom")}>
            <ExternalLink className="w-3.5 h-3.5" />
          </Link>
        </div>
      ))}
    </details>
  );
}

export function QueueLogDialog({ logKey, onClose }: { logKey: string | null; onClose: () => void }): ReactNode {
  return <JobLogDialog logKey={logKey} onClose={onClose} />;
}

/** Compact node health entry for Queue. The full topology lives on `/nodes`. */
export function FleetPulse({ nodes, delivering, healthLoaded = true, directoryLoaded = true, stale = false }: {
  nodes: readonly NodeSummary[];
  delivering: number;
  healthLoaded?: boolean;
  directoryLoaded?: boolean;
  stale?: boolean;
}): ReactNode {
  const t = useT();
  const total = nodes.length;
  const health = countNodeHealth(nodes, healthLoaded);
  const recording = nodes.reduce((n, node) => n + node.recording, 0);
  const diskLow = nodes.filter((n) => n.diskLow).length;
  const drift = nodes.filter((n) => n.drift || n.syncLag).length;
  const healthColor = health.offline > 0 ? "var(--error)" : health.unknown > 0 ? "var(--warning)" : "var(--success)";
  return (
    <div className="card mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
      <span className="section-label">{t("queue.fleet.title")}</span>
      <span className="inline-flex items-center gap-1.5 text-[12px]">
        <span
          className="dot"
          style={{ background: total === 0 || !healthLoaded ? "var(--muted-soft)" : healthColor }}
        />
        {total === 0
          ? (directoryLoaded ? t("queue.fleet.noNodes") : (
              <>
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t("queue.fleet.loading")}
              </>
            ))
          : !healthLoaded
            ? (
                <>
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                  {t("queue.fleet.checking", { n: total })}
                </>
              )
            : t("queue.fleet.online", { ok: health.online, total })}
      </span>
      {health.unknown > 0 && <span className="text-[12px]" style={{ color: "var(--warning-fg)" }}>{t("queue.fleet.noStatus", { n: health.unknown })}</span>}
      {health.offline > 0 && <span className="text-[12px]" style={{ color: "var(--error-fg)" }}>{t("queue.fleet.offline", { n: health.offline })}</span>}
      <span className="text-[12px] text-muted">{t("queue.fleet.recording", { n: recording })}</span>
      <span className="text-[12px] text-muted">{t("queue.fleet.delivering", { n: delivering })}</span>
      {diskLow > 0 && <span className="text-[12px]" style={{ color: "var(--error-fg)" }}>{t("queue.fleet.diskLow", { n: diskLow })}</span>}
      {drift > 0 && <span className="text-[12px]" style={{ color: "var(--warning-fg)" }}>{t("queue.fleet.drift", { n: drift })}</span>}
      {stale && <span className="text-[12px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.healthStale")}</span>}
      <Link to="/nodes" className="ml-auto inline-flex items-center gap-1 text-[12px] text-ink hover:underline">
        {t("queue.fleet.open")} <ArrowRight className="w-3.5 h-3.5" />
      </Link>
    </div>
  );
}

/** Stage-mode normal close-out: stored, not an incident. */
export function StageReadyRow({ item, onOpenLog, onAck }: {
  item: QueueItemDTO;
  onOpenLog: (key: string) => void;
  onAck: (key: string) => void;
}): ReactNode {
  const t = useT();
  return (
    <div className="attention-row">
      <span className="font-medium text-ink">{item.anchorName ?? roomId(item.roomSlug)}</span>
      <span className="font-mono text-[11px] text-muted-soft">{sessionLabel(item.streamKey)}</span>
      <span className="text-[11px] text-muted">{t("queue.attention.stage_ready")}</span>
      <span className="ml-auto inline-flex items-center gap-0.5">
        <button type="button" className="icon-btn !w-7 !h-7" title={t("queue.ack.action")} aria-label={t("queue.ack.action")} onClick={() => onAck(item.streamKey)}>
          <Check className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="icon-btn !w-7 !h-7" title={t("hub.jobs.viewLog")} aria-label={t("hub.jobs.viewLog")} onClick={() => onOpenLog(item.streamKey)}>
          <FileText className="w-3.5 h-3.5" />
        </button>
        <Link to={`/rooms/${encodeURIComponent(`${item.platform}.${item.roomSlug}`)}`} className="icon-btn !w-7 !h-7" title={t("queue.openRoom")} aria-label={t("queue.openRoom")}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </span>
    </div>
  );
}
