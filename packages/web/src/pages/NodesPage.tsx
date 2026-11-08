import { useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, ChevronRight, CircleAlert, CircleHelp, Database, ExternalLink, FileText, GripVertical, HardDrive, Loader2, Pencil, Plus, RefreshCw, Server, Trash2 } from "lucide-react";
import { api, type RollingDeliveryDTO, type RoomDTO, type Task, type WorkerDTO, type WorkerStatus } from "../api/client";
import { Button, IconButton } from "../components/Button";
import { ConnStatus } from "../components/ConnStatus";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { NodeLogsDialog } from "../components/NodeLogsDialog";
import { WorkerDialog } from "../modals/WorkerDialog";
import { useDragReorder, type DragItemDomProps } from "../lib/dragReorder";
import { errMessage, useHubStream, usePolling, useTicker, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import {
  countNodeHealth,
  deriveNodeHealthProbe,
  fmtBytes,
  INITIAL_NODE_HEALTH_LOAD_STATE,
  loadNodeHealthSnapshot,
  nodeHealthState,
  type NodeHealthProbe,
  type NodeHealthState,
  type NodeHealthLoadState,
} from "../lib/nodes-summary";
import { buildNodes, nodeConnectionInfo, nodeCounts, nodeManagable, nodeRoomHref, nodeRoleLabel, type NodeRoomView, type NodeView } from "../lib/nodes-page";
import { useAtomValue } from "jotai";
import { hubEnabledAtom } from "../atoms";

const NODE_STATE_COLOR: Record<NodeRoomView["state"], string> = {
  recording: "var(--success)",
  unavailable: "var(--warning)",
  waiting: "var(--muted-soft)",
  // disabled 不能用 hairline(与分隔线同色,看起来像渲染坏了);用 muted 并配合中性 hover。
  disabled: "var(--muted)",
};

function ago(ms: number | null | undefined, now: number): string {
  if (!ms) return "-";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * Master-only Nodes page: health, assignments, live rolling sessions, and inline worker management
 * (add/edit/delete/reorder/test on the card itself; issue #549 retired the slide-in manage panel).
 */
export function NodesPage(): ReactNode {
  const t = useT();
  const toast = useToast();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [status, setStatus] = useState<Record<string, WorkerStatus | undefined>>({});
  const [delivering, setDelivering] = useState<RollingDeliveryDTO[]>([]);
  const [tasksStale, setTasksStale] = useState(false);
  const [workersStale, setWorkersStale] = useState(false);
  const [versionStale, setVersionStale] = useState(false);
  const [deliveryStale, setDeliveryStale] = useState(false);
  const [masterVersion, setMasterVersion] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [workersLoaded, setWorkersLoaded] = useState(false);
  const [healthLoad, setHealthLoad] = useState<NodeHealthLoadState>(INITIAL_NODE_HEALTH_LOAD_STATE);
  const healthLoadRef = useRef<NodeHealthLoadState>(INITIAL_NODE_HEALTH_LOAD_STATE);
  const [editorFor, setEditorFor] = useState<WorkerDTO | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [logsFor, setLogsFor] = useState<{ id: string; name: string } | null>(null);
  // Relative timestamps keep moving between the slower health probes.
  const now = useTicker(30_000);

  const refresh = useMemo(() => async (): Promise<void> => {
    try {
      // Task/room data drives assignments and changes often; ssh-backed health probes run separately.
      const [ts, rs] = await Promise.all([api.listTasks(), api.listRooms()]);
      setTasks(ts);
      setRooms(rs);
      setTasksStale(false);
    } catch {
      setTasksStale(true);
    } finally {
      setLoaded(true);
    }
  }, []);
  const refreshStatus = useMemo(() => async (): Promise<void> => {
    const result = await loadNodeHealthSnapshot(api.getWorkersStatus, healthLoadRef.current);
    if (result.statuses) setStatus(Object.fromEntries(result.statuses.map((s) => [s.id, s])));
    healthLoadRef.current = result.state;
    setHealthLoad(result.state);
  }, []);
  const refreshWorkers = useMemo(() => async (silentFailure = false): Promise<void> => {
    try {
      setWorkers(await api.listWorkers());
      setWorkersStale(false);
    } catch {
      if (!silentFailure) setWorkersStale(true);
    } finally {
      setWorkersLoaded(true);
    }
  }, []);
  // The queue snapshot is only used for live delivery sessions. Poll it separately and show stale
  // state if it fails instead of silently freezing the last snapshot.
  const refreshDelivering = useMemo(() => async (): Promise<void> => {
    try {
      const q = await api.getHubQueue();
      setDelivering(q.delivering ?? []);
      setDeliveryStale(false);
    } catch {
      // Keep the last snapshot but never present frozen sessions as live.
      setDeliveryStale(true);
    }
  }, []);
  // Push refresh only touches task/room state. The heavier delivery snapshot is polled separately.
  const stream = useHubStream(refresh, { enabled: hubEnabled === true });
  usePolling(refreshDelivering, 30_000, hubEnabled === true);
  usePolling(refreshStatus, 60_000, hubEnabled === true);
  usePolling(refresh, 30_000, hubEnabled === true);
  usePolling(refreshWorkers, 300_000, hubEnabled === true);
  usePolling(async () => {
    try {
      setMasterVersion((await api.getVersion()).version.split("-")[0] ?? "");
      setVersionStale(false);
    } catch {
      setVersionStale(true);
    }
  }, 300_000, hubEnabled === true);

  const nodes = useMemo(
    () => buildNodes(tasks, rooms, workers, status, delivering, masterVersion),
    [tasks, rooms, workers, status, delivering, masterVersion],
  );
  const healthProbe = deriveNodeHealthProbe({
    statusSettled: healthLoad.statusSettled,
    statusHasSnapshot: healthLoad.statusHasSnapshot,
    workersLoaded,
  });
  const health = countNodeHealth(nodes, healthProbe);
  const recording = nodes.reduce((n, x) => n + x.recordingRooms, 0);
  const sessions = nodes.reduce((n, x) => n + x.rollingSessions, 0);

  const openCreate = (): void => {
    setEditorFor(null);
    setEditorOpen(true);
  };
  const openEdit = (w: WorkerDTO): void => {
    setEditorFor(w);
    setEditorOpen(true);
  };
  const doDelete = async (id: string): Promise<void> => {
    try {
      await api.deleteWorker(id);
      toast(t("hub.workers.deleted"), "info");
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      void refreshWorkers(true).catch(() => {});
      void refresh().catch(() => {});
    }
  };
  // Drag-reorder persists the full id order (array order = display order, incl. the controller).
  // The hook guards concurrent commits; a local card is never draggable (see NodeCard), so the
  // committed order always keeps the controller first.
  const dnd = useDragReorder<WorkerDTO>({
    items: workers,
    keyOf: (w) => w.id,
    onCommit: async (ids) => {
      try {
        await api.reorderWorkers(ids);
        void refreshWorkers(true).catch(() => {});
      } catch (e) {
        toast(errMessage(e), "error");
        void refreshWorkers(true).catch(() => {});
      }
    },
  });
  // Cards render the drag order while a drag is in progress; afterwards the refreshed config order.
  // Only reorder the worker cards; the controller card stays pinned first (matches buildNodes).
  const orderedNodes = useMemo(() => {
    if (dnd.dragKey === null) return nodes;
    const rank = (id: string): number => {
      const i = dnd.ordered.findIndex((w) => w.id === id);
      return i === -1 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...nodes].sort((a, b) => (a.id === "local" ? -1 : b.id === "local" ? 1 : rank(a.id) - rank(b.id) || a.name.localeCompare(b.name)));
  }, [nodes, dnd.ordered, dnd.dragKey]);
  const workerById = useMemo(() => new Map(workers.map((w) => [w.id, w])), [workers]);

  const healthAnnouncement = [
    health.checking > 0 ? t("nodes.checkingCount", { n: health.checking }) : "",
    health.probeFailed > 0 ? t("nodes.probeFailedCount", { n: health.probeFailed }) : "",
    health.unknown > 0 ? t("nodes.noStatusCount", { n: health.unknown }) : "",
    health.offline > 0 ? t("nodes.offlineCount", { n: health.offline }) : "",
    t("nodes.onlineCount", { online: health.online, total: health.total }),
  ].filter(Boolean).join(" · ");

  if (hubEnabled === null) {
    return <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>;
  }

  if (hubEnabled === false) {
    return (
      <div className="card p-10 flex flex-col items-center gap-4 text-center">
        <Server className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
        <h1 className="headline text-[22px]">{t("nodes.title")}</h1>
        <p className="text-muted text-sm max-w-md">{t("nodes.childDesc")}</p>
      </div>
    );
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div className="min-w-0">
          <h1 className="headline page-h1">{t("nodes.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("nodes.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConnStatus conn={stream.lastOkAt ? { ok: !stream.stale, at: stream.lastOkAt } : null} />
          {(tasksStale || workersStale || versionStale) && <span className="text-[11px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.assignmentStale")}</span>}
          {(healthLoad.statusStale || healthProbe === "failed") && <span className="text-[11px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.healthStale")}</span>}
          {deliveryStale && <span className="text-[11px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.liveStale")}</span>}
          <IconButton title={t("nodes.refresh")} onClick={() => void Promise.all([refresh(), refreshStatus(), refreshDelivering(), refreshWorkers(true)])}>
            <RefreshCw className="w-4 h-4" />
          </IconButton>
          <Button small onClick={openCreate}><Plus className="w-4 h-4" />{t("nodes.add")}</Button>
        </div>
      </div>

      <div className="telemetry-bar mb-5">
        <div className="telemetry-cell">
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="telemetry-label">{t("nodes.online")}</span>
            <span className="telemetry-value tabular-nums">{health.online}/{health.total}</span>
            {health.checking > 0 && (
              <span className="inline-flex items-center gap-1 text-[11px] text-muted">
                <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                {t("nodes.checkingCount", { n: health.checking })}
              </span>
            )}
            {health.unknown > 0 && (
              <span className="text-[11px]" style={{ color: "var(--warning-fg)" }}>
                {t("nodes.noStatusCount", { n: health.unknown })}
              </span>
            )}
            {health.probeFailed > 0 && (
              <span className="text-[11px]" style={{ color: "var(--warning-fg)" }}>
                {t("nodes.probeFailedCount", { n: health.probeFailed })}
              </span>
            )}
            <span className="sr-only" role="status" aria-live="polite">{healthAnnouncement}</span>
          </div>
          <span className="telemetry-icon"><Server className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("nodes.recording")}</span><span className="telemetry-value tabular-nums">{recording}</span></div>
          <span className="telemetry-icon"><Activity className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("nodes.sessionsShort")}</span><span className="telemetry-value tabular-nums">{sessions}</span></div>
          <span className="telemetry-icon"><Database className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("nodes.relation")}</span><span className="telemetry-value-sm truncate">{t("nodes.topology", { n: nodes.filter((n) => n.id !== "local").length })}</span></div>
          <span className="telemetry-icon"><ChevronRight className="w-4 h-4" /></span>
        </div>
      </div>

      {!loaded || (!workersLoaded && nodes.length === 0) ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : orderedNodes.length === 0 ? (
        <div className="empty-state">
          <Server className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
          <div className="text-sm font-medium text-ink">{t("nodes.empty")}</div>
          <Button small onClick={openCreate}><Plus className="w-4 h-4" />{t("nodes.add")}</Button>
        </div>
      ) : (
        <div className="node-topology">
          {orderedNodes.map((n) => (
            <NodeCard
              key={n.id}
              n={n}
              now={now}
              healthProbe={healthProbe}
              dndProps={dnd.itemProps(n.id)}
              dragging={dnd.dragKey === n.id}
              dragOver={dnd.overKey === n.id && dnd.dragKey !== n.id}
              onLogs={() => setLogsFor({ id: n.id, name: n.name })}
              onEdit={() => {
                const w = workerById.get(n.id);
                if (w) openEdit(w);
              }}
              onDelete={() => setPendingDelete(n.id)}
              draggable={dnd.enabled && n.id !== "local"}
            />
          ))}
        </div>
      )}

      <WorkerDialog
        open={editorOpen}
        onClose={() => setEditorOpen(false)}
        worker={editorFor}
        onSaved={() => {
          void refreshWorkers(true).catch(() => {});
          void refresh().catch(() => {});
        }}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("hub.workers.deleteConfirmTitle")}
        confirmLabel={t("hub.common.delete")}
        destructive
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id !== null) void doDelete(id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
      <NodeLogsDialog workerId={logsFor?.id ?? null} workerName={logsFor?.name ?? ""} onClose={() => setLogsFor(null)} />
    </>
  );
}

function NodeHealthBadge({ health }: { health: NodeHealthState }): ReactNode {
  const t = useT();
  if (health === "checking") {
    return (
      <span className="badge badge-muted">
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        {t("nodes.checking")}
      </span>
    );
  }
  if (health === "probe-failed") {
    return (
      <span className="badge badge-orange">
        <CircleAlert className="h-3 w-3" aria-hidden="true" />
        {t("nodes.probeFailed")}
      </span>
    );
  }
  if (health === "unknown") {
    return (
      <span className="badge badge-muted">
        <CircleHelp className="h-3 w-3" aria-hidden="true" />
        {t("nodes.noStatus")}
      </span>
    );
  }
  return <span className={`badge ${health === "online" ? "badge-success" : "badge-error"}`}>{t(`nodes.${health}`)}</span>;
}

function NodeCard({
  n,
  now,
  healthProbe,
  dndProps,
  dragging,
  dragOver,
  onLogs,
  onEdit,
  onDelete,
  draggable,
}: {
  n: NodeView;
  now: number;
  healthProbe: NodeHealthProbe;
  dndProps: DragItemDomProps;
  dragging: boolean;
  dragOver: boolean;
  onLogs: () => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Dragging is the management reorder, so the controller card never carries it. */
  draggable: boolean;
}): ReactNode {
  const t = useT();
  const counts = nodeCounts(n);
  const health = nodeHealthState(n, healthProbe);
  const conn = nodeConnectionInfo(n);
  const manage = nodeManagable(n);
  const dot = health === "online"
    ? "var(--success)"
    : health === "offline"
      ? "var(--error)"
      : health === "probe-failed"
        ? "var(--warning)"
        : "var(--muted-soft)";
  return (
    <section
      className={`node-card${dragOver ? " drag-over" : ""}`}
      data-controller={n.id === "local" || undefined}
      data-offline={health === "offline" || undefined}
      data-health={health}
      aria-busy={health === "checking" || undefined}
      style={dragging ? { opacity: 0.5 } : undefined}
      // The controller card gets no drag handlers at all: not draggable, and not a drop target
      // (dropping onto it would persist a config order with `local` not first).
      {...(draggable ? dndProps : {})}
    >
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        {draggable && <span className="rail-grip node-card-grip" title={t("hub.common.dragTip")}><GripVertical className="w-3.5 h-3.5 shrink-0" /></span>}
        <span className="dot mt-1.5" style={{ background: dot }} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-medium text-ink truncate">{n.name}</h2>
            <span className="badge badge-muted">{nodeRoleLabel(n.id, t)}</span>
            {n.version && <span className="font-mono text-[11px]" style={{ color: n.drift ? "var(--warning-fg)" : "var(--muted-soft)" }}>v{n.version.split("-")[0]}</span>}
            <NodeHealthBadge health={health} />
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-soft">
            <span>{t("nodes.activeRooms", { n: counts.active })}</span>
            {counts.recording > 0 && <span style={{ color: "var(--success-fg)" }}>{t("nodes.recordingRooms", { n: counts.recording })}</span>}
            {n.rollingSessions > 0 && <span>{t("nodes.sessions", { n: n.rollingSessions })}</span>}
            {typeof n.diskFreeGB === "number" && <span style={{ color: n.diskLow ? "var(--error-fg)" : undefined }}><HardDrive className="inline w-3 h-3" /> {t("nodes.disk", { gb: n.diskFreeGB.toFixed(1) })}</span>}
            {n.uncertainSessions > 0 && <span style={{ color: "var(--warning-fg)" }}>{t("nodes.uncertain", { n: n.uncertainSessions })}</span>}
          </div>
          {(conn.host || conn.apiUrl) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[11px] text-muted-soft">
              {conn.host && <span title={t("hub.workers.colHost")}>{conn.host}</span>}
              {conn.apiUrl && (
                <a href={conn.apiUrl} target="_blank" rel="noreferrer" className="hover:text-ink inline-flex items-center gap-1">
                  {t("nodes.openWeb")}<ExternalLink className="w-3 h-3" aria-hidden="true" />
                </a>
              )}
            </div>
          )}
          {n.capabilities && n.capabilities.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {n.capabilities.map((c) => (
                <span key={c} className="font-mono text-[11px] px-1.5 py-0.5 border border-hairline text-muted-soft" style={{ borderRadius: "var(--r-pill, 999px)" }}>{c}</span>
              ))}
            </div>
          )}
          {health === "offline" && n.error && <div className="mt-1 text-[11px]" style={{ color: "var(--error-fg)" }}>{n.error}</div>}
          {health === "probe-failed" && <div className="mt-1 text-[11px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.probeFailedHint")}</div>}
          {health === "unknown" && <div className="mt-1 text-[11px] text-muted-soft">{t("nodes.noStatusHint")}</div>}
          {n.syncLag && <div className="mt-1 text-[11px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.syncLag", { expected: n.expectedVersion ?? "-", applied: n.appliedVersion ?? "-" })}</div>}
          {!n.syncLag && n.appliedAt && <div className="mt-1 text-[11px] text-muted-soft">{t("nodes.synced", { ago: ago(n.appliedAt, now) })}</div>}
        </div>
        <div className="ml-auto flex items-center gap-1 shrink-0">
          <IconButton title={t("nodes.logs")} onClick={onLogs}><FileText className="w-4 h-4" /></IconButton>
          {manage && <IconButton title={t("hub.common.edit")} onClick={onEdit}><Pencil className="w-4 h-4" /></IconButton>}
          {manage && <IconButton title={t("hub.common.delete")} style={{ color: "var(--error-fg)" }} onClick={onDelete}><Trash2 className="w-4 h-4" /></IconButton>}
        </div>
      </div>
      {n.rooms.length === 0 ? (
        <div className="node-room-row text-[12px] text-muted-soft">{t("nodes.noRooms")}</div>
      ) : (
        <details>
          <summary className="node-room-row cursor-pointer select-none">
            <span className="section-label">{t("nodes.rooms")}</span>
            <span className="font-mono text-[11px] text-muted-soft">{n.rooms.length}</span>
            <ChevronRight className="w-3.5 h-3.5 ml-auto transition-transform" />
          </summary>
          {n.rooms.map((r) => (
            <div key={r.key} className="node-room-row">
              <span className="dot" style={{ background: NODE_STATE_COLOR[r.state] }} />
              {nodeRoomHref(r)
                ? <Link to={nodeRoomHref(r)} className="text-[13px] text-ink hover:underline truncate">{r.label}</Link>
                : <span className="text-[13px] text-ink truncate">{r.label}</span>}
              <span className="font-mono text-[11px] text-muted-soft">{r.platform} · {r.roomSlug}</span>
              <span className="text-[11px] text-muted ml-auto">{t(`queue.nodes.state.${r.state}`)}</span>
              {r.sessions.map((s) => (
                <div key={s.sessionBase} className="node-session w-full">
                  {t("nodes.sessionProgress", { c: s.confirmed, n: s.total })}
                  {s.uploading && <span> · {t("nodes.uploading")}</span>}
                  {s.ambiguous > 0 && <span style={{ color: "var(--warning-fg)" }}> · {t("nodes.unknown", { n: s.ambiguous })}</span>}
                  {s.lockedBytes ? <span> · {t("nodes.locked", { size: fmtBytes(s.lockedBytes) })}</span> : null}
                  {s.bv ? <a className="ml-2 hover:text-ink" href={`https://www.bilibili.com/video/${s.bv}`} target="_blank" rel="noreferrer">{s.bv}</a> : <span> · {t("nodes.noBv")}</span>}
                </div>
              ))}
            </div>
          ))}
        </details>
      )}
    </section>
  );
}
