/**
 * QueuePage — processing queue (/queue). Master shows one session stream plus this host's node queue;
 * workers show only the node queue. All session facts come from GET /api/hub/queue.
 */
import { AlertTriangle, ArrowDownUp, Check, ChevronDown, ChevronRight, ClipboardCheck, ExternalLink, FileText, Hourglass, Loader2, RotateCcw, Search, X } from "lucide-react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type HubQueueDTO, type ProcActiveDTO, type Task, type WorkerStatus } from "../api/client";
import { hubEnabledAtom, serverTimezoneAtom } from "../atoms";
import { humanSec, humanSecFull, JobLogDialog } from "../components/HubJobs";
import { platformLabel, roomId } from "../lib/labels";
import { errMessage, useHubStream, usePolling, useTicker, useToast } from "../lib/hooks";
import { ConfirmDialog } from "../components/ConfirmDialog";
import {
  baseVersion,
  deriveNodeHealthProbe,
  INITIAL_NODE_HEALTH_LOAD_STATE,
  loadNodeHealthSnapshot,
  summarizeNodes,
  type NodeHealthLoadState,
  type NodeSummary,
} from "../lib/nodes-summary";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { LivePool, LiveUploadLanes } from "../components/QueueLive";
import { liveUploadLanes } from "../lib/queue-live";
import { stepLabel } from "../lib/queue-chain";
import { NodeUploadLine, QueueStateBadges } from "../components/QueueBadges";
import { buildQueueFlow, queueEmptyKey, type QueueAction, type QueueFlowRow, type QueueGroupId } from "../lib/queue-flow";
import { queueRowSummary, type QueueRowGroup } from "../lib/queue-summary";
import { useT } from "../lib/i18n";
import { fmtTimeInTz } from "../lib/tz";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

const NODE_QUEUE_POLL_MS = 10_000;
/** Known proc-queue kinds (must stay in sync with providers-register.ts): the UI gives these
 * dedicated labels; anything else folds into the "unknown" aggregate row, never exposing raw keys. */
export const NODE_QUEUE_KINDS = ["upload-part", "cleanup-part", "reconcile-part", "remux", "upload-prep", "biliup"] as const;
export type NodeQueueKnownKind = (typeof NODE_QUEUE_KINDS)[number];
type NodeQueueState = { data: ProcActiveDTO | null; available: boolean; loaded: boolean };
const INITIAL_NODE_QUEUE_STATE: NodeQueueState = { data: null, available: true, loaded: false };

/** Node-local proc-queue snapshot; swapping in row-level data later only changes this component. */
function NodeQueueCard(): ReactNode {
  const t = useT();
  const [state, setState] = useState<NodeQueueState>(INITIAL_NODE_QUEUE_STATE);
  const alive = useRef(true);
  usePolling(() => api.getProcActive()
    .then((data) => { if (alive.current) setState({ data, available: true, loaded: true }); })
    .catch(() => { if (alive.current) setState({ data: null, available: false, loaded: true }); }),
  NODE_QUEUE_POLL_MS);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  const data = state.data;
  const unknownKinds = data
    ? [...new Set([...Object.keys(data.running), ...Object.keys(data.pending), ...Object.keys(data.leaseAlive)])]
      .filter((kind) => !NODE_QUEUE_KINDS.some((known) => known === kind))
      .sort()
    : [];
  const hasUnknown = unknownKinds.length > 0;
  const snapshot = state.available ? data : null;
  return (
    <section className="queue-support">
      <div className="section-label mb-2.5">{t("queue.nodeQueue.title")}</div>
      <div className="card p-3.5">
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <span className="text-[12px] text-muted">{t("queue.nodeQueue.subtitle")}</span>
          {snapshot && <span className="chip ml-auto">{t(snapshot.host ? "queue.nodeQueue.hostRunning" : "queue.nodeQueue.hostStopped")}</span>}
        </div>
        {!state.available && <div className="mb-3 text-[12px] text-muted">{t("queue.nodeQueue.unavailable")}</div>}
        {!state.loaded && <div className="text-[12px] text-muted">{t("hub.common.loading")}</div>}
        {state.loaded && snapshot && (
          <div className="space-y-1.5">
            {NODE_QUEUE_KINDS.map((kind) => {
              const running = snapshot.running[kind] ?? 0;
              const pending = snapshot.pending[kind] ?? 0;
              const leaseAlive = snapshot.leaseAlive[kind] === true;
              return (
                <div key={kind} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 border-t border-[var(--hairline)] first:border-t-0">
                  <span className="text-[13px] font-medium text-ink">{t(`queue.nodeQueue.kinds.${kind}`)}</span>
                  <span className="font-mono text-[11px] text-muted">{kind}</span>
                  <span className="chip ml-auto">{t("queue.nodeQueue.running")} {running}</span>
                  <span className="chip">{t("queue.nodeQueue.pending")} {pending}</span>
                  <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                    <span className="dot" style={{ background: leaseAlive ? "var(--success)" : "var(--muted-soft)" }} />
                    {t(leaseAlive ? "queue.nodeQueue.leaseAlive" : "queue.nodeQueue.leaseDead")}
                  </span>
                </div>
              );
            })}
            {hasUnknown && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1.5 border-t border-[var(--hairline)]">
                <span className="text-[13px] font-medium text-ink">{t("queue.nodeQueue.unknownKind")}</span>
                <span className="chip ml-auto">{t("queue.nodeQueue.running")} {unknownKinds.reduce((sum, k) => sum + (snapshot.running[k] ?? 0), 0)}</span>
                <span className="chip">{t("queue.nodeQueue.pending")} {unknownKinds.reduce((sum, k) => sum + (snapshot.pending[k] ?? 0), 0)}</span>
                <span className="inline-flex items-center gap-1.5 text-[11px] text-muted">
                  <span className="dot" style={{ background: unknownKinds.some((k) => snapshot.leaseAlive[k] === true) ? "var(--success)" : "var(--muted-soft)" }} />
                  {t(unknownKinds.some((k) => snapshot.leaseAlive[k] === true) ? "queue.nodeQueue.leaseAlive" : "queue.nodeQueue.leaseDead")}
                </span>
              </div>
            )}
          </div>
        )}
        {state.loaded && !snapshot && <div className="text-[12px] text-muted">{state.available ? t("queue.nodeQueue.empty") : t("queue.nodeQueue.unavailable")}</div>}
      </div>
    </section>
  );
}

function sessionTime(streamKey: string, t: TFunc): string {
  const suffix = streamKey.split(":").slice(2).join(":");
  const m = /^(\d{4}-\d{2}-\d{2})(?:_(\d{2})(\d{2}))?(-zd)?$/.exec(suffix);
  if (!m) return suffix;
  const [, date, hh, mm, zd] = m;
  const short = date!.slice(5);
  if (!hh) return short;
  if (zd) return `${short} ${hh}:${mm} · ${t("queue.live.directTag")}`;
  return `${short} ${hh}:${mm}`;
}

function chipStyle(on: boolean): CSSProperties {
  return on
    ? { background: "var(--surface)", borderColor: "var(--ink)", color: "var(--ink)", cursor: "pointer" }
    : { cursor: "pointer" };
}

/** One compact search input plus status chips; all advanced chips stay behind a disclosure. */
function CompactFilterBar({
  phase, states, platform, q, sort, onPhase, onStates, onPlatform, onQ, onSort, onReset,
}: {
  phase: string[];
  states: string[];
  platform: string[];
  q: string;
  sort: "newest" | "oldest";
  onPhase: (v: string[]) => void;
  onStates: (v: string[]) => void;
  onPlatform: (v: string[]) => void;
  onQ: (v: string) => void;
  onSort: (v: "newest" | "oldest") => void;
  onReset: () => void;
}): ReactNode {
  const t = useT();
  const [more, setMore] = useState(false);
  const toggle = (arr: string[], v: string, set: (x: string[]) => void): void =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  const activeCount = phase.length + states.length + platform.length + (q ? 1 : 0);
  const quick = [
    { key: "all", label: t("queue.filter.quickAll"), on: phase.length === 0 && states.length === 0, apply: () => { onPhase([]); onStates([]); } },
    { key: "active", label: t("queue.filter.quickActive"), on: phase.length === 3 && ["running", "queued", "waiting_settle"].every((v) => phase.includes(v)) && states.length === 0, apply: () => { onStates([]); onPhase(["running", "queued", "waiting_settle"]); } },
    { key: "attention", label: t("queue.filter.quickAttention"), on: phase.length === 2 && phase.includes("waiting_manual") && phase.includes("failed") && states.length === 0, apply: () => { onStates([]); onPhase(["waiting_manual", "failed"]); } },
  ];
  const phaseChips = [
    { key: "running", label: t("queue.filter.running"), on: phase.includes("running"), toggle: () => toggle(phase, "running", onPhase) },
    { key: "queued", label: t("queue.filter.queued"), on: phase.includes("queued"), toggle: () => toggle(phase, "queued", onPhase) },
    { key: "pulling", label: t("queue.filter.pulling"), on: states.includes("syncing"), toggle: () => toggle(states, "syncing", onStates) },
    { key: "waiting_settle", label: t("queue.filter.settle"), on: phase.includes("waiting_settle"), toggle: () => toggle(phase, "waiting_settle", onPhase) },
    { key: "waiting_manual", label: t("queue.filter.manual"), on: phase.includes("waiting_manual"), toggle: () => toggle(phase, "waiting_manual", onPhase) },
    { key: "waiting_upload", label: t("queue.filter.uploadWait"), on: phase.includes("waiting_upload"), toggle: () => toggle(phase, "waiting_upload", onPhase) },
    { key: "stopped", label: t("queue.filter.stopped"), on: phase.includes("stopped"), toggle: () => toggle(phase, "stopped", onPhase) },
    { key: "done", label: t("queue.filter.done"), on: phase.includes("done"), toggle: () => toggle(phase, "done", onPhase) },
    { key: "failed", label: t("queue.filter.failed"), on: phase.includes("failed"), toggle: () => toggle(phase, "failed", onPhase) },
  ];
  return (
    <div className="queue-filters">
      <div className="relative min-w-0 flex-1">
        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" style={{ color: "var(--muted-soft)" }} />
        <input value={q} onChange={(e) => onQ(e.target.value)} placeholder={t("queue.filter.search")} className="input !pl-8 !h-8 !text-[12px] w-full" />
      </div>
      {quick.map((c) => (
        <button key={c.key} type="button" onClick={c.apply} aria-pressed={c.on} className="chip" style={chipStyle(c.on)}>
          {c.on && <Check className="w-3 h-3" />}{c.label}
        </button>
      ))}
      <button
        type="button"
        className="chip"
        style={chipStyle(sort === "oldest")}
        title={t(sort === "newest" ? "queue.sort.newestTip" : "queue.sort.oldestTip")}
        onClick={() => onSort(sort === "newest" ? "oldest" : "newest")}
      >
        <ArrowDownUp className="w-3 h-3" />{t(sort === "newest" ? "queue.flow.sort.newest" : "queue.flow.sort.oldest")}
      </button>
      <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="chip" style={{ cursor: "pointer" }}>
        {more ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        {t(more ? "queue.filter.less" : "queue.filter.more")}
      </button>
      {activeCount > 0 && (
        <button type="button" onClick={onReset} className="chip" style={{ cursor: "pointer" }} title={t("queue.filter.reset")}>
          <X className="w-3 h-3" /> {t("queue.filter.clear")} ({activeCount})
        </button>
      )}
      {more && (
        <div className="queue-filters-more">
          {phaseChips.map((c) => (
            <button key={c.key} type="button" onClick={c.toggle} aria-pressed={c.on} className="chip" style={chipStyle(c.on)}>
              {c.on && <Check className="w-3 h-3" />}{c.label}
            </button>
          ))}
          <span className="w-px h-4 mx-1.5" style={{ background: "var(--hairline)" }} />
          <span className="text-[11px] text-muted-soft">{t("queue.filter.byPlatform")}</span>
          {["douyin", "bilibili", "kuaishou"].map((p) => (
            <button key={p} type="button" onClick={() => toggle(platform, p, onPlatform)} aria-pressed={platform.includes(p)} className="chip" style={chipStyle(platform.includes(p))}>
              {platform.includes(p) && <Check className="w-3 h-3" />}{platformLabel(p)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function OverviewBand({ counts, nodes, healthProbe, directoryLoaded, stale, t }: {
  counts: { running: number; queued: number; actions: number; done: number };
  nodes: readonly NodeSummary[];
  healthProbe: "loading" | "failed" | "ready";
  directoryLoaded: boolean;
  stale: boolean;
  t: TFunc;
}): ReactNode {
  const total = nodes.length;
  const online = nodes.filter((node) => node.ok === true).length;
  const offline = nodes.filter((node) => node.ok === false).length;
  const unknown = total - online - offline;
  const healthColor = offline > 0 || healthProbe === "failed" ? "var(--error)"
    : unknown > 0 || stale || healthProbe === "loading" ? "var(--warning)"
      : "var(--success)";
  const healthText = total === 0
    ? (directoryLoaded ? t("queue.fleet.noNodes") : t("queue.fleet.loading"))
    : healthProbe === "failed" ? t("queue.fleet.probeFailed")
      : healthProbe === "loading" ? t("queue.fleet.checking", { n: total })
        : t("queue.fleet.online", { ok: online, total });
  return (
    <section className="queue-overview" aria-label={t("queue.flow.overview")}>
      <div className="queue-overview-counts">
        <span className="queue-overview-count" data-tone="primary"><Loader2 className="w-3.5 h-3.5" />{t("queue.flow.count.running", { n: counts.running })}</span>
        <span className="queue-overview-count"><Hourglass className="w-3.5 h-3.5" />{t("queue.flow.count.queued", { n: counts.queued })}</span>
        <span className="queue-overview-count" data-tone={counts.actions > 0 ? "danger" : undefined}><AlertTriangle className="w-3.5 h-3.5" />{t("queue.flow.count.actions", { n: counts.actions })}</span>
        <span className="queue-overview-count"><Check className="w-3.5 h-3.5" />{t("queue.flow.count.done", { n: counts.done })}</span>
      </div>
      <Link to="/nodes" className="queue-node-health" title={t("queue.fleet.open")}>
        <span className="dot" style={{ background: healthColor }} />
        <span>{healthText}</span>
        {offline > 0 && <span style={{ color: "var(--error-fg)" }}>{t("queue.fleet.offline", { n: offline })}</span>}
        {unknown > 0 && <span style={{ color: "var(--warning-fg)" }}>{t("queue.fleet.noStatus", { n: unknown })}</span>}
        <ChevronRight className="w-3.5 h-3.5" />
      </Link>
    </section>
  );
}

function StepPipeline({ row, t }: { row: QueueFlowRow; t: TFunc }): ReactNode {
  if (row.steps.length === 0) return <div className="queue-flow-line queue-flow-empty">{t("queue.nothingDone")}</div>;
  return (
    <div className="queue-flow-line" role="group" aria-label={t("queue.flow.steps")}>
      {row.steps.map((step) => (
        <span key={step.key} className="queue-flow-step" data-state={step.state}>
          <span className="queue-flow-glyph" aria-hidden="true">{step.state === "done" ? "✓" : step.state === "current" ? "▶" : "○"}</span>
          {stepLabel(t, step.step)}
        </span>
      ))}
    </div>
  );
}

function RowActions({ streamKey, platform, roomSlug, needsAck, onOpenLog, onAck, onRetry, noLog, t }: {
  streamKey: string;
  platform: string;
  roomSlug: string;
  needsAck?: boolean;
  onOpenLog: (key: string) => void;
  onAck: (key: string) => void;
  onRetry?: (key: string) => void;
  noLog?: boolean;
  t: TFunc;
}): ReactNode {
  return (
    <span className="queue-row-actions">
      {onRetry && (
        <button type="button" className="queue-action-btn" title={t("hub.jobs.rerun")} aria-label={t("hub.jobs.rerun")} onClick={() => onRetry(streamKey)}>
          <RotateCcw className="w-3.5 h-3.5" /><span>{t("queue.flow.retry")}</span>
        </button>
      )}
      {needsAck && (
        <button type="button" className="queue-action-btn" title={t("queue.ack.action")} aria-label={t("queue.ack.action")} onClick={() => onAck(streamKey)}>
          <ClipboardCheck className="w-3.5 h-3.5" /><span>{t("queue.flow.confirm")}</span>
        </button>
      )}
      {!noLog && (
        <button type="button" className="queue-action-btn" title={t("hub.jobs.viewLog")} aria-label={t("hub.jobs.viewLog")} onClick={() => onOpenLog(streamKey)}>
          <FileText className="w-3.5 h-3.5" /><span>{t("queue.flow.logs")}</span>
        </button>
      )}
      {noLog && (
        <Link to={`/rooms/${encodeURIComponent(`${platform}.${roomSlug}`)}`} title={t("queue.openRoom")} aria-label={t("queue.openRoom")} className="icon-btn !w-7 !h-7">
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      )}
      {!noLog && (
        <Link to={`/rooms/${encodeURIComponent(`${platform}.${roomSlug}`)}`} title={t("queue.openRoom")} className="icon-btn !w-7 !h-7">
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      )}
    </span>
  );
}

function queueSummaryText(summary: { key: string; vars: Record<string, string | number> }, t: TFunc, tz: string): string {
  const vars = { ...summary.vars };
  if (typeof vars.step === "string") vars.step = stepLabel(t, vars.step);
  if (typeof vars.resource === "string") vars.resource = t(`queue.flow.resource.${vars.resource}`);
  if (typeof vars.eta === "number") vars.eta = humanSec(vars.eta);
  if (typeof vars.since === "number") vars.since = humanSec(vars.since);
  if (typeof vars.duration === "number") vars.duration = vars.duration < 0 ? t("queue.flow.durationUnknown") : humanSecFull(Math.round(vars.duration));
  if (typeof vars.time === "number") vars.time = vars.time ? fmtTimeInTz(new Date(vars.time), tz) : "-";
  return t(summary.key, vars);
}

function FlowRow({ row, group, tz, now, t, onOpenLog, onAck }: {
  row: QueueFlowRow;
  group: QueueRowGroup;
  tz: string;
  now: number;
  t: TFunc;
  onOpenLog: (key: string) => void;
  onAck: (key: string) => void;
}): ReactNode {
  const item = row.item;
  const waitedSec = row.waitsFromMs == null ? null : Math.max(0, Math.round((now - row.waitsFromMs) / 1000));
  const summary = queueSummaryText(queueRowSummary(row, group, now), t, tz);
  return (
    <article className="queue-row" data-group={group}>
      <div className="queue-rail" aria-hidden="true"><span /></div>
      <div className="queue-row-body">
        <div className="queue-row-head">
          <div className="min-w-0">
            <div className="queue-row-title">
              <span className="font-medium text-ink truncate">{item.anchorName ?? roomId(item.roomSlug)}</span>
              <span className="font-mono text-[11px] text-muted-soft shrink-0">{sessionTime(item.streamKey, t)}</span>
            </div>
            <div className="font-mono text-[11px] text-muted-soft truncate">{platformLabel(item.platform)} · {roomId(item.roomSlug)}</div>
          </div>
          <div className="queue-row-meta">
            <QueueStateBadges item={item} t={t} />
            {group === "running" && row.elapsedSec != null && <span className="chip">{t("queue.flow.elapsed", { time: humanSec(row.elapsedSec) })}</span>}
            {group === "running" && row.etaSec != null && <span className="chip">{t("queue.flow.eta", { time: humanSec(row.etaSec) })}</span>}
            {group === "queued" && row.queuePosition != null && <span className="chip">{t("queue.flow.position", { n: row.queuePosition })}</span>}
            {group === "settling" && waitedSec != null && <span className="chip">{humanSec(waitedSec)}</span>}
            {group === "done" && row.videoDurationSec != null && <span className="chip">{humanSecFull(Math.round(row.videoDurationSec))}</span>}
            {group === "done" && row.bv && (
              <a className="queue-bv" href={`https://www.bilibili.com/video/${row.bv}`} target="_blank" rel="noreferrer">{row.bv}</a>
            )}
          </div>
          <RowActions streamKey={item.streamKey} platform={item.platform} roomSlug={item.roomSlug} onOpenLog={onOpenLog} onAck={onAck} t={t} />
        </div>
        {group !== "done" && <StepPipeline row={row} t={t} />}
        {group !== "done" && item.nodeUpload && (
          <NodeUploadLine upload={item.nodeUpload} now={now} tz={tz} t={t} className="mt-2" />
        )}
        <div className="queue-row-summary">{summary}</div>
      </div>
    </article>
  );
}

function ActionRow({ action, now, tz, t, onOpenLog, onAck, onRetry }: {
  action: QueueAction;
  now: number;
  tz: string;
  t: TFunc;
  onOpenLog: (key: string) => void;
  onAck: (key: string) => void;
  onRetry: (key: string) => void;
}): ReactNode {
  const reason = action.reason.startsWith("queue.flow.reason.") ? t(action.reason) : action.reason;
  const retries = action.item?.fails ?? (action.blocked ? action.blocked.rounds : 0);
  const upload = action.item?.nodeUpload ?? null;
  return (
    <article className="queue-row" data-group="attention" data-severity={action.severity}>
      <div className="queue-rail" aria-hidden="true"><span /></div>
      <div className="queue-row-body">
        <div className="queue-row-head">
          <div className="min-w-0">
            <div className="queue-row-title">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" style={{ color: action.severity === "error" ? "var(--error-fg)" : "var(--muted-soft)" }} />
              <span className="font-medium text-ink truncate">{action.title}</span>
              <span className="font-mono text-[11px] text-muted-soft shrink-0">{sessionTime(action.streamKey, t)}</span>
            </div>
            <div className="font-mono text-[11px] text-muted-soft truncate">{platformLabel(action.platform)} · {roomId(action.roomSlug)}</div>
          </div>
          <div className="queue-row-meta">
            {retries > 0 && <span className="chip">{action.blocked ? t("queue.flow.rounds", { n: retries }) : t("hub.jobs.retries", { count: retries })}</span>}
          </div>
          <RowActions
            streamKey={action.streamKey}
            platform={action.platform}
            roomSlug={action.roomSlug}
            needsAck={action.needsAck}
            onRetry={action.item?.state === "needs_manual" || action.item?.phase === "failed" ? onRetry : undefined}
            noLog={action.kind === "blocked"}
            onOpenLog={onOpenLog}
            onAck={onAck}
            t={t}
          />
        </div>
        {upload && <NodeUploadLine upload={upload} now={now} tz={tz} t={t} className="mt-2" />}
        {action.blocked ? (
          <div className="queue-row-summary">
            {t("queue.flow.summary.blocked", { workers: action.blocked.workers.join(", "), min: Math.max(0, Math.round((now - action.blocked.sinceMs) / 60_000)) })}
          </div>
        ) : (
          <div className="queue-action-reason" title={reason}>{reason}</div>
        )}
      </div>
    </article>
  );
}

function QueueGroup({ id, count, children, empty, emptyKey, t, defaultOpen = true, extra, footer, open: controlledOpen, onToggle }: {
  id: QueueGroupId;
  count: number;
  children: ReactNode;
  empty: boolean;
  emptyKey?: string;
  t: TFunc;
  defaultOpen?: boolean;
  extra?: ReactNode;
  footer?: ReactNode;
  open?: boolean;
  onToggle?: () => void;
}): ReactNode {
  const [selfOpen, setSelfOpen] = useState(defaultOpen);
  const open = controlledOpen ?? selfOpen;
  const toggle = (): void => {
    if (controlledOpen == null) setSelfOpen((value) => !value);
    else onToggle?.();
  };
  return (
    <section className="queue-group" data-group={id}>
      <button type="button" className="queue-group-head" aria-expanded={open} onClick={toggle}>
        <ChevronDown className="w-3.5 h-3.5 queue-group-chevron" data-open={open} />
        <span className="queue-group-title">{t(`queue.flow.group.${id}`)}</span>
        <span className="queue-group-count">{count}</span>
        <span className="queue-group-hint">{t(`queue.flow.hint.${id}`)}</span>
        {extra}
      </button>
      {open && (
        <div className="queue-group-body">
          {empty ? <div className="queue-empty">{t(emptyKey ?? queueEmptyKey(id))}</div> : children}
          {footer && <div className="queue-group-footer">{footer}</div>}
        </div>
      )}
    </section>
  );
}

/** Processing queue: an ordered stream with explicit empty states and preserved actions. */
export function QueuePage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const tz = useAtomValue(serverTimezoneAtom);
  const [data, setData] = useState<HubQueueDTO | null>(null);
  const [dataAt, setDataAt] = useState(() => Date.now());
  const [loaded, setLoaded] = useState(false);
  const [fleetTasks, setFleetTasks] = useState<Task[]>([]);
  const [fleetStatus, setFleetStatus] = useState<Record<string, WorkerStatus | undefined>>({});
  const [fleetWorkers, setFleetWorkers] = useState<Array<{ id: string; name: string }>>([]);
  const [fleetTasksStale, setFleetTasksStale] = useState(false);
  const [fleetWorkersStale, setFleetWorkersStale] = useState(false);
  const [fleetVersionStale, setFleetVersionStale] = useState(false);
  const [fleetWorkersLoaded, setFleetWorkersLoaded] = useState(false);
  const [fleetHealthLoad, setFleetHealthLoad] = useState<NodeHealthLoadState>(INITIAL_NODE_HEALTH_LOAD_STATE);
  const fleetHealthLoadRef = useRef<NodeHealthLoadState>(INITIAL_NODE_HEALTH_LOAD_STATE);
  const [masterVersion, setMasterVersion] = useState("");
  const [phase, setPhase] = useState<string[]>([]);
  const [states, setStates] = useState<string[]>([]);
  const [platform, setPlatform] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [showAllDone, setShowAllDone] = useState(false);
  const [doneOpen, setDoneOpen] = useState(false);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [ackKey, setAckKey] = useState<string | null>(null);
  const [ackNote, setAckNote] = useState("");
  const [forceRun, setForceRun] = useState<{ streamKey: string; message: string } | null>(null);
  const [retryKey, setRetryKey] = useState<string | null>(null);
  const toast = useToast();
  const masterEnabled = hubEnabled === true;
  const hubAlive = useRef(true);
  const openAck = useCallback((key: string): void => { setAckKey(key); setAckNote(""); }, []);
  const [debouncedQ, setDebouncedQ] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 250);
    return () => clearTimeout(id);
  }, [q]);
  const query = useMemo(
    () => ({ phase, states, platform, q: debouncedQ || undefined, sort }),
    [phase, states, platform, debouncedQ, sort],
  );
  const queryKey = useMemo(() => JSON.stringify(query), [query]);
  const poll = useMemo(
    () => async (): Promise<void> => {
      try {
        const d = await api.getHubQueue(JSON.parse(queryKey) as typeof query);
        if (!hubAlive.current) return;
        setData(d);
        setDataAt(Date.now());
      } finally {
        if (hubAlive.current) setLoaded(true);
      }
    },
    [queryKey],
  );
  const stream = useHubStream(poll, { enabled: masterEnabled });
  useEffect(() => {
    hubAlive.current = true;
    return () => { hubAlive.current = false; };
  }, []);
  usePolling(
    () => api.listTasks()
      .then((tasks) => { setFleetTasks(tasks); setFleetTasksStale(false); })
      .catch(() => setFleetTasksStale(true)),
    30_000,
    masterEnabled,
  );
  usePolling(
    () => api.listWorkers()
      .then((list) => {
        setFleetWorkers(list.map((w) => ({ id: w.id, name: w.name })));
        setFleetWorkersStale(false);
      })
      .catch(() => setFleetWorkersStale(true))
      .finally(() => setFleetWorkersLoaded(true)),
    300_000,
    masterEnabled,
  );
  usePolling(
    async () => {
      const result = await loadNodeHealthSnapshot(api.getWorkersStatus, fleetHealthLoadRef.current);
      if (result.statuses) setFleetStatus(Object.fromEntries(result.statuses.map((s) => [s.id, s])));
      fleetHealthLoadRef.current = result.state;
      setFleetHealthLoad(result.state);
    },
    60_000,
    masterEnabled,
  );
  usePolling(
    () => api.getVersion()
      .then((r) => { setMasterVersion(baseVersion(r.version)); setFleetVersionStale(false); })
      .catch(() => setFleetVersionStale(true)),
    300_000,
    masterEnabled,
  );
  const now = useTicker(1000);
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    void poll();
  }, [poll]);
  const reset = (): void => { setPhase([]); setStates([]); setPlatform([]); setQ(""); };
  const requestRetry = useCallback((key: string): void => setRetryKey(key), []);
  const rerun = useCallback(async (streamKey: string, force = false): Promise<void> => {
    try {
      await api.runHubJob({ streamKey, force });
      toast(t("hub.jobs.started"), "info");
      await poll().catch(() => undefined);
    } catch (e) {
      if (!force && e instanceof ApiError && e.forceable) setForceRun({ streamKey, message: e.message });
      else toast(errMessage(e), "error");
    }
  }, [poll, t, toast]);
  const rows = data?.rows ?? [];
  const liveLanes = useMemo(() => liveUploadLanes(fleetTasks), [fleetTasks]);
  const flow = useMemo(
    () => buildQueueFlow(rows, data?.blocked ?? [], liveLanes.length, now, dataAt, sort),
    [rows, data?.blocked, liveLanes.length, now, dataAt, sort],
  );
  const fleetNodes = useMemo(
    () => summarizeNodes(fleetTasks, fleetStatus, data?.delivering ?? [], masterVersion, fleetWorkers),
    [fleetTasks, fleetStatus, data?.delivering, masterVersion, fleetWorkers],
  );
  const fleetHealthProbe = deriveNodeHealthProbe({
    statusSettled: fleetHealthLoad.statusSettled,
    statusHasSnapshot: fleetHealthLoad.statusHasSnapshot,
    workersLoaded: fleetWorkersLoaded,
  });
  const filtered = phase.length + states.length + platform.length + (debouncedQ ? 1 : 0) > 0;
  const groupEmptyKey = (id: QueueGroupId): string => (filtered ? "queue.filter.noMatch" : queueEmptyKey(id));
  // Rolling sessions live outside the ledger rows; keep them visible as their own stat instead of
  // inflating the running header (which must equal the rows + lanes actually rendered below).
  const deliveringTotal = data?.delivering?.length ?? 0;
  const visibleDone = showAllDone || filtered ? flow.done : flow.done.slice(0, 5);
  const manualTotal = data?.manualTotal ?? 0;
  const manualShown = (data?.active ?? []).filter((r) => r.state === "needs_manual").length;
  const renderFlowRow = (row: QueueFlowRow, group: QueueRowGroup): ReactNode => (
    <FlowRow key={row.key} row={row} group={group} tz={tz} now={now} t={t} onOpenLog={setLogKey} onAck={openAck} />
  );
  const doneFooter = doneOpen && !filtered && flow.done.length > 5 ? (
    <button type="button" className="queue-group-more" onClick={() => setShowAllDone((v) => !v)}>
      {t(showAllDone ? "queue.flow.showLess" : "queue.flow.showMore", { n: flow.done.length })}
    </button>
  ) : undefined;
  const stale = fleetHealthLoad.statusStale || fleetHealthProbe === "failed" || fleetTasksStale || fleetWorkersStale || fleetVersionStale;
  if (hubEnabled !== true) {
    return (
      <>
        <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
          <div>
            <h1 className="headline text-[26px] sm:text-[30px] leading-tight">{t("queue.nodeQueue.workerTitle")}</h1>
            <p className="text-muted text-sm mt-1.5">{t("queue.nodeQueue.workerNotice")}</p>
          </div>
        </div>
        <NodeQueueCard />
      </>
    );
  }
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-4">
        <div>
          <h1 className="headline text-[26px] sm:text-[30px] leading-tight">{t("queue.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("queue.flow.subtitle")}</p>
        </div>
      </div>
      <HubStreamBanner handle={stream} />
      <OverviewBand counts={flow.counts} nodes={fleetNodes} healthProbe={fleetHealthProbe} directoryLoaded={fleetWorkersLoaded} stale={stale} t={t} />
      {data && <LivePool pool={data.pool} />}
      {!filtered && manualTotal > manualShown && (
        <div className="queue-manual-more" style={{ color: "var(--warning-fg)" }}>{t("queue.summary.manualMore", { total: manualTotal, shown: manualShown })}</div>
      )}
      {(data?.manualAcked ?? 0) > 0 && <div className="queue-manual-more">{t("queue.summary.acked", { n: data?.manualAcked ?? 0 })}</div>}
      <CompactFilterBar
        phase={phase} states={states} platform={platform} q={q} sort={sort}
        onPhase={setPhase} onStates={setStates} onPlatform={setPlatform} onQ={setQ} onSort={setSort} onReset={reset}
      />
      {!loaded ? (
        <>
          <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
          <NodeQueueCard />
        </>
      ) : (
        <section className="queue-stream" aria-label={t("queue.flow.stream")}>
          <QueueGroup id="attention" count={flow.actions.length} empty={flow.actions.length === 0} emptyKey={groupEmptyKey("attention")} t={t}>
            {flow.actions.map((action) => (
              <ActionRow key={action.key} action={action} now={now} tz={tz} t={t} onOpenLog={setLogKey} onAck={openAck} onRetry={requestRetry} />
            ))}
          </QueueGroup>
          <QueueGroup
            id="running"
            count={flow.counts.running}
            empty={flow.running.length === 0 && flow.delivering === 0}
            emptyKey={groupEmptyKey("running")}
            extra={deliveringTotal > 0 ? <span className="chip">{t("queue.fleet.delivering", { n: deliveringTotal })}</span> : undefined}
            t={t}
          >
            {flow.running.map((row) => renderFlowRow(row, "running"))}
            <LiveUploadLanes lanes={liveLanes} now={now} />
          </QueueGroup>
          <QueueGroup id="queued" count={flow.queued.length} empty={flow.queued.length === 0} emptyKey={groupEmptyKey("queued")} t={t}>
            {flow.queued.map((row) => renderFlowRow(row, "queued"))}
          </QueueGroup>
          <QueueGroup id="settling" count={flow.settling.length} empty={flow.settling.length === 0} emptyKey={groupEmptyKey("settling")} t={t}>
            {flow.settling.map((row) => renderFlowRow(row, "settling"))}
          </QueueGroup>
          <QueueGroup id="done" count={flow.done.length} empty={visibleDone.length === 0} emptyKey={groupEmptyKey("done")} t={t} defaultOpen={false} open={doneOpen} onToggle={() => setDoneOpen((v) => !v)} footer={doneFooter}>
            {visibleDone.map((row) => renderFlowRow(row, "done"))}
          </QueueGroup>
          <NodeQueueCard />
        </section>
      )}
      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
      <ConfirmDialog
        open={ackKey !== null}
        title={t("queue.ack.title")}
        message={t("queue.ack.message")}
        confirmLabel={t("queue.ack.confirm")}
        onCancel={() => setAckKey(null)}
        onConfirm={() => {
          const key = ackKey;
          if (!key) return;
          if (!ackNote.trim()) { toast(t("queue.ack.required"), "error"); return; }
          api.ackHubJob(key, { note: ackNote.trim() })
            .then(() => { toast(t("queue.ack.done"), "success"); setAckKey(null); void poll(); })
            .catch((e: unknown) => toast(errMessage(e), "error"));
        }}
      >
        <div className="space-y-2 mb-3">
          <div className="font-mono text-[11px] text-muted break-all">{ackKey}</div>
          <textarea className="input w-full min-h-[72px]" maxLength={500} value={ackNote} placeholder={t("queue.ack.placeholder")} onChange={(e) => setAckNote(e.target.value)} />
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={retryKey !== null}
        title={t("queue.flow.retryTitle")}
        message={t("queue.flow.retryMessage")}
        confirmLabel={t("queue.flow.retry")}
        destructive
        onCancel={() => setRetryKey(null)}
        onConfirm={() => {
          const key = retryKey;
          setRetryKey(null);
          if (key) void rerun(key);
        }}
      />
      <ConfirmDialog
        open={forceRun !== null}
        title={t("hub.jobs.runForceTitle")}
        message={<><span className="block">{forceRun?.message}</span><span className="block mt-2">{t("hub.jobs.runForceHint")}</span></>}
        confirmLabel={t("hub.jobs.runForceConfirm")}
        destructive
        onCancel={() => setForceRun(null)}
        onConfirm={() => {
          const target = forceRun;
          setForceRun(null);
          if (target) void rerun(target.streamKey, true);
        }}
      />
    </>
  );
}
