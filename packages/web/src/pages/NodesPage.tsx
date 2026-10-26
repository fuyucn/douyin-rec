import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, ChevronRight, Database, FileText, HardDrive, Plus, RefreshCw, Server, Users } from "lucide-react";
import { api, type RollingDeliveryDTO, type RoomDTO, type Task, type WorkerDTO, type WorkerStatus } from "../api/client";
import { Button, IconButton } from "../components/Button";
import { ConnStatus } from "../components/ConnStatus";
import { NodeLogsDialog } from "../components/NodeLogsDialog";
import { WorkersPanel } from "../components/WorkersPanel";
import { useHubStream, usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtBytes } from "../lib/nodes-summary";
import { buildNodes, nodeCounts, nodeRoomHref, nodeRoleLabel, type NodeRoomView, type NodeView } from "../lib/nodes-page";
import { useAtomValue } from "jotai";
import { hubEnabledAtom } from "../atoms";

const NODE_STATE_COLOR: Record<NodeRoomView["state"], string> = {
  recording: "var(--success)",
  unavailable: "var(--warning)",
  waiting: "var(--muted-soft)",
  disabled: "var(--hairline)",
};

function ago(ms: number | null | undefined, now: number): string {
  if (!ms) return "-";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/** Master-only Nodes page: topology, health, assignments, and live rolling sessions. */
export function NodesPage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [status, setStatus] = useState<Record<string, WorkerStatus | undefined>>({});
  const [delivering, setDelivering] = useState<RollingDeliveryDTO[]>([]);
  const [masterVersion, setMasterVersion] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [workersOpen, setWorkersOpen] = useState(false);
  const [logsFor, setLogsFor] = useState<{ id: string; name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const refresh = useMemo(() => async (): Promise<void> => {
    try {
      const [ts, rs, ws, ss, q] = await Promise.all([
        api.listTasks(), api.listRooms(), api.listWorkers(), api.getWorkersStatus(), api.getHubQueue(),
      ]);
      setTasks(ts);
      setRooms(rs);
      setWorkers(ws);
      setStatus(Object.fromEntries(ss.map((s) => [s.id, s])));
      setDelivering(q.delivering ?? []);
      setNow(Date.now());
    } finally {
      setLoaded(true);
    }
  }, []);
  const stream = useHubStream(refresh, { enabled: hubEnabled === true });
  usePolling(() => void refresh().catch(() => {}), 15_000, hubEnabled === true);
  usePolling(() => void api.getVersion().then((r) => setMasterVersion(r.version.split("-")[0] ?? "")).catch(() => {}), 300_000, hubEnabled === true);

  const nodes = useMemo(
    () => buildNodes(tasks, rooms, workers, status, delivering, masterVersion),
    [tasks, rooms, workers, status, delivering, masterVersion],
  );
  const online = nodes.filter((n) => n.ok !== false).length;
  const recording = nodes.reduce((n, x) => n + x.recordingRooms, 0);
  const sessions = nodes.reduce((n, x) => n + x.rollingSessions, 0);

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
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("nodes.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("nodes.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ConnStatus conn={stream.lastOkAt ? { ok: !stream.stale, at: stream.lastOkAt } : null} />
          <IconButton title={t("nodes.refresh")} onClick={() => void refresh().catch(() => {})}><RefreshCw className="w-4 h-4" /></IconButton>
          <Button small variant="secondary" onClick={() => setWorkersOpen(true)}><Users className="w-4 h-4" />{t("nodes.manage")}</Button>
        </div>
      </div>

      <div className="telemetry-bar mb-5">
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("nodes.online")}</span><span className="telemetry-value tabular-nums">{online}/{nodes.length}</span></div>
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
          <div className="flex flex-col gap-1.5"><span className="telemetry-label">{t("nodes.relation")}</span><span className="telemetry-value-sm truncate">master → {Math.max(0, nodes.length - 1)}</span></div>
          <span className="telemetry-icon"><ChevronRight className="w-4 h-4" /></span>
        </div>
      </div>

      {!loaded ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : nodes.length === 0 ? (
        <div className="empty-state">
          <Server className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
          <div className="text-sm font-medium text-ink">{t("nodes.empty")}</div>
          <Button small onClick={() => setWorkersOpen(true)}><Plus className="w-4 h-4" />{t("nodes.add")}</Button>
        </div>
      ) : (
        <div className="node-topology">
          {nodes.map((n) => (
            <NodeCard key={n.id} n={n} now={now} onLogs={() => setLogsFor({ id: n.id, name: n.name })} />
          ))}
        </div>
      )}

      <WorkersPanel
        open={workersOpen}
        onClose={() => setWorkersOpen(false)}
        workers={workers}
        status={Object.fromEntries(Object.entries(status).filter((x): x is [string, WorkerStatus] => x[1] !== undefined))}
        onChanged={() => void refresh().catch(() => {})}
      />
      <NodeLogsDialog workerId={logsFor?.id ?? null} workerName={logsFor?.name ?? ""} onClose={() => setLogsFor(null)} />
    </>
  );
}

function NodeCard({ n, now, onLogs }: { n: NodeView; now: number; onLogs: () => void }): ReactNode {
  const t = useT();
  const counts = nodeCounts(n);
  const dot = n.ok === undefined ? "var(--muted-soft)" : n.ok ? "var(--success)" : "var(--error)";
  return (
    <section className="node-card" data-controller={n.id === "local" || undefined} data-offline={n.ok === false || undefined}>
      <div className="flex flex-wrap items-start gap-3 px-4 py-3">
        <span className="dot mt-1.5" style={{ background: dot }} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-2">
            <h2 className="font-medium text-ink truncate">{n.name}</h2>
            <span className="badge badge-muted">{nodeRoleLabel(n.id, t)}</span>
            {n.version && <span className="font-mono text-[11px]" style={{ color: n.drift ? "var(--warning-fg)" : "var(--muted-soft)" }}>v{n.version.split("-")[0]}</span>}
            {n.ok === false && <span className="badge badge-error">{t("nodes.offline")}</span>}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-muted-soft">
            <span>{t("nodes.activeRooms", { n: counts.active })}</span>
            {counts.recording > 0 && <span style={{ color: "var(--success-fg)" }}>{t("nodes.recordingRooms", { n: counts.recording })}</span>}
            {n.rollingSessions > 0 && <span>{t("nodes.sessions", { n: n.rollingSessions })}</span>}
            {typeof n.diskFreeGB === "number" && <span style={{ color: n.diskLow ? "var(--error-fg)" : undefined }}><HardDrive className="inline w-3 h-3" /> {t("nodes.disk", { gb: n.diskFreeGB.toFixed(1) })}</span>}
            {n.uncertainSessions > 0 && <span style={{ color: "var(--warning-fg)" }}>{t("nodes.uncertain", { n: n.uncertainSessions })}</span>}
          </div>
          {n.ok === false && n.error && <div className="mt-1 text-[11px]" style={{ color: "var(--error-fg)" }}>{n.error}</div>}
          {n.syncLag && <div className="mt-1 text-[11px]" style={{ color: "var(--warning-fg)" }}>{t("nodes.syncLag", { expected: n.expectedVersion ?? "-", applied: n.appliedVersion ?? "-" })}</div>}
          {!n.syncLag && n.appliedAt && <div className="mt-1 text-[11px] text-muted-soft">{t("nodes.synced", { ago: ago(n.appliedAt, now) })}</div>}
        </div>
        <div className="ml-auto flex items-center gap-1">
          <Button small variant="secondary" onClick={onLogs}><FileText className="w-3.5 h-3.5" />{t("nodes.logs")}</Button>
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
              <Link to={nodeRoomHref(r)} className="text-[13px] text-ink hover:underline truncate">{r.label}</Link>
              <span className="font-mono text-[10px] text-muted-soft">{r.platform} · {r.roomSlug}</span>
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
