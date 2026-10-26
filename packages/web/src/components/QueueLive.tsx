import type { ReactNode } from "react";
import { Activity, ArrowRight, Check, ChevronDown, Clock3, ExternalLink, FileText, Gauge, Loader2, Timer } from "lucide-react";
import { Link } from "react-router-dom";
import type { HubPoolSnapshotDTO, QueueItemDTO } from "../api/client";
import { humanSec, JobLogDialog } from "./HubJobs";
import { useT } from "../lib/i18n";
import { platformLabel, roomId } from "../lib/labels";
import { liveStepLabel } from "../lib/queue-live";
import { fmtBytes } from "../lib/nodes-summary";

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
        {p?.bps && <span>{fmtBytes(p.bps)}/s</span>}
        {u.attempts && u.attempts > 1 && <span>{t("queue.nodeUpload.attempt", { n: u.attempts })}</span>}
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
  const current = liveStepLabel(item);
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
        <button type="button" className="icon-btn !w-7 !h-7 ml-auto" title={t("hub.jobs.viewLog")} onClick={() => onOpenLog(item.streamKey)}>
          <FileText className="w-3.5 h-3.5" />
        </button>
        <Link to={`/rooms/${encodeURIComponent(`${item.platform}.${item.roomSlug}`)}`} className="icon-btn !w-7 !h-7" title={t("queue.openRoom")}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>

      <div className="live-flow" aria-label={t("queue.live.current")}>
        {done.map((s) => (
          <div key={`d-${s}`} className="live-flow-step" data-state="done">
            <div className="flex items-center gap-1.5 text-[11px] font-mono"><Check className="w-3 h-3" style={{ color: "var(--success-fg)" }} />{stepLabel(t, s)}</div>
          </div>
        ))}
        <div className="live-flow-step" data-state="current">
          <div className="flex items-center gap-1.5 text-[11px] font-mono">
            {item.phase === "queued" ? <Clock3 className="w-3 h-3" /> : <Loader2 className="w-3 h-3 animate-spin" />}
            {stepLabel(t, current)}
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
  return (
    <div className="telemetry-bar telemetry-bar-cols-3 mb-5">
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("queue.pool.cpu")}</span><span className="telemetry-value tabular-nums">{pool.cpu.active}/{pool.cpu.max || "-"}</span></div>
        <span className="telemetry-icon"><Gauge className="w-4 h-4" /></span>
      </div>
      <div className="telemetry-cell">
        <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("queue.pool.upload")}</span><span className="telemetry-value tabular-nums">{pool.upload.windowUsed}/{pool.upload.windowLimit || "-"}</span></div>
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
export function AttentionCard({ kind, rows, blocked, onOpenLog, defaultOpen = false }: {
  kind: string;
  rows: QueueItemDTO[];
  blocked: Array<{ streamKey: string; roomSlug: string; workers: string[] }>;
  onOpenLog: (key: string) => void;
  defaultOpen?: boolean;
}): ReactNode {
  const t = useT();
  const count = rows.length + blocked.length;
  return (
    <details className="attention-group" open={defaultOpen || undefined}>
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
          <button type="button" className="icon-btn !w-7 !h-7 ml-auto" title={t("hub.jobs.viewLog")} onClick={() => onOpenLog(r.streamKey)}><FileText className="w-3.5 h-3.5" /></button>
        </div>
      ))}
      {blocked.map((b) => (
        <div key={b.streamKey} className="attention-row">
          <span className="font-medium text-ink">{b.roomSlug}</span>
          <span className="text-[11px]" style={{ color: "var(--error-fg)" }}>{t("queue.blocked.by", { nodes: b.workers.join(", ") })}</span>
        </div>
      ))}
    </details>
  );
}

export function QueueLogDialog({ logKey, onClose }: { logKey: string | null; onClose: () => void }): ReactNode {
  return <JobLogDialog logKey={logKey} onClose={onClose} />;
}

/** Compact node health entry for Queue. The full topology lives on `/nodes`. */
export function FleetPulse({ delivering }: { delivering: number }): ReactNode {
  const t = useT();
  return (
    <div className="card mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 px-4 py-3">
      <span className="section-label">{t("queue.fleet.title")}</span>
      <span className="text-[12px] text-muted">{t("queue.fleet.delivering", { n: delivering })}</span>
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
        <button type="button" className="icon-btn !w-7 !h-7" title={t("queue.ack.action")} onClick={() => onAck(item.streamKey)}>
          <Check className="w-3.5 h-3.5" />
        </button>
        <button type="button" className="icon-btn !w-7 !h-7" title={t("hub.jobs.viewLog")} onClick={() => onOpenLog(item.streamKey)}>
          <FileText className="w-3.5 h-3.5" />
        </button>
        <Link to={`/rooms/${encodeURIComponent(`${item.platform}.${item.roomSlug}`)}`} className="icon-btn !w-7 !h-7" title={t("queue.openRoom")}>
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </span>
    </div>
  );
}
