/**
 * Shared plumbing for `/rooms` (list) and `/rooms/:key` (detail): one data hook, one status
 * badge, one set of actions — so the two screens can't drift on what "recording" or "stop" means.
 */
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { api, type RoomDTO, type Task, type WorkerDTO } from "../../api/client";
import type { ConnState } from "../../atoms";
import { connOf } from "../../lib/conn";
import { ConfirmDialog } from "../../components/ConfirmDialog";
import { useHubStream, usePolling, errMessage, useToast, type HubStreamHandle } from "../../lib/hooks";
import { useT } from "../../lib/i18n";
import { roomName, scheduleText } from "../../lib/labels";
export { roomName } from "../../lib/labels";
import { ageOf, lastDelivery, type Delivery } from "../../lib/last-delivery";
import { lastRunHint, latestRunKey, roomStatus, type LatestRun, type RoomStatus } from "../../lib/room-status";
import { PHASE_STYLE } from "../../lib/task-status";
import { RoomEditor } from "../../modals/RoomEditor";

export interface RoomsData {
  rooms: RoomDTO[];
  loaded: boolean;
  /** Last list fetch, rooms or tasks (null = none yet). */
  conn: ConnState;
  workers: WorkerDTO[];
  /** hub master 才发规则(worker 上只建录制任务)。 */
  hubEnabled: boolean;
  taskOf: (r: RoomDTO) => Task | undefined;
  statusOf: (r: RoomDTO) => RoomStatus;
  refresh: () => Promise<void>;
  /** Re-read the worker list after add/edit/delete/reorder. */
  refreshWorkers: () => Promise<void>;
  stream: HubStreamHandle;
}

export function useRoomsData(): RoomsData {
  const [rooms, setRooms] = useState<RoomDTO[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [runs, setRuns] = useState<Map<string, LatestRun>>(new Map());
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [hubEnabled, setHubEnabled] = useState(false);
  const [loaded, setLoaded] = useState(false);
  /**
   * Shown in the list header like the Tasks page, so a failing fetch is not silent. Rooms and tasks are tracked
   * apart: the 5 s task poll keeps the time fresh, but must not hide a failing room fetch.
   */
  const [fetches, setFetches] = useState<{ rooms: ConnState; tasks: ConnState }>({ rooms: null, tasks: null });
  const mark = useCallback((k: "rooms" | "tasks", ok: boolean) => setFetches((f) => ({ ...f, [k]: { ok, at: Date.now() } })), []);

  const refreshRuns = useCallback(async (): Promise<void> => {
    const { rooms: rs } = await api.getLatestRuns();
    setRuns(new Map(rs.map((r) => [r.roomKey, r])));
  }, []);
  const refreshWorkers = useCallback(async (): Promise<void> => {
    setWorkers(await api.listWorkers());
  }, []);
  const refresh = useCallback(async (): Promise<void> => {
    try {
      // Tasks drive the start/stop icons and the status badge: refresh them with the rooms so an add / start /
      // stop shows at once instead of waiting for the 5 s poll. A failure keeps the previous list.
      void api.listTasks().then(setTasks).catch(() => {});
      try {
        setRooms(await api.listRooms());
        mark("rooms", true);
      } catch (e) {
        mark("rooms", false);
        throw e;
      }
      // Runs are secondary: a failure must not hide the room list, but still marks the stream stale.
      await refreshRuns();
    } finally {
      setLoaded(true);
    }
  }, [refreshRuns]);
  // Push-driven (hub stream) with bounded backoff polling fallback; same as the queue page.
  const stream = useHubStream(refresh);
  usePolling(() => void refresh().catch(() => {}), 30_000);
  // The 5 s task poll also refreshes the connection time: room fetches are push-driven and can be minutes apart.
  usePolling(() => void api.listTasks().then((ts) => { setTasks(ts); mark("tasks", true); })
    .catch(() => mark("tasks", false)), 5_000);
  usePolling(() => void refreshWorkers().catch(() => {}), 300_000);
  usePolling(() => void api.getHubStatus().then((s) => setHubEnabled(s.enabled)).catch(() => {}), 300_000);

  const taskById = useMemo(() => new Map(tasks.map((x) => [x.id, x])), [tasks]);
  const taskOf = useCallback((r: RoomDTO) => (r.recording?.taskId != null ? taskById.get(r.recording.taskId) : undefined), [taskById]);
  const conn = useMemo((): ConnState => connOf(fetches.rooms, fetches.tasks), [fetches]);
  const statusOf = useCallback((r: RoomDTO) => roomStatus(r, taskOf(r), runs.get(latestRunKey(r)) ?? null), [taskOf, runs]);
  return { rooms, loaded, conn, workers, hubEnabled, taskOf, statusOf, refresh, refreshWorkers, stream };
}

export function nodesText(r: RoomDTO, workers: WorkerDTO[], all: string): string {
  const ids = r.processing?.workers ?? [];
  if (ids.length === 0) return all;
  return ids.map((id) => workers.find((w) => w.id === id)?.name || id).join(" · ");
}

/** Delivery mode label: archive vs upload (rolling counts as upload — it is only earlier timing). */
export function deliverText(t: ReturnType<typeof useT>, r: RoomDTO): string {
  const mode = r.processing?.pipeline?.upload?.mode;
  return mode === "upload" || mode === "rolling" ? t("room.uploadMode") : t("room.archiveMode");
}

const KIND_STYLE: Record<RoomStatus["kind"], { tone: string; dot: string; pulse: boolean }> = {
  recording: { tone: "badge-success", dot: "var(--success)", pulse: true },
  processing: { tone: "badge-neutral", dot: "var(--status-fg)", pulse: true },
  attention: { tone: "badge-orange", dot: "var(--warning)", pulse: false },
  waiting: { tone: "badge-muted", dot: "var(--muted-soft)", pulse: false },
  paused: { tone: "badge-muted", dot: "transparent", pulse: false },
};

export function RoomBadge({ s }: { s: RoomStatus }): ReactNode {
  const t = useT();
  const st = KIND_STYLE[s.kind];
  // Recording faults use the task phase's own colour (offline/error are red there, not amber).
  const dot = s.kind === "attention" && s.phase && (s.phase.kind === "offline" || s.phase.kind === "error") ? PHASE_STYLE[s.phase.kind].dot : st.dot;
  return (
    <span className={`badge ${st.tone} shrink-0`}>
      {s.kind !== "paused" && <span className={`dot${st.pulse ? " dot-running" : ""}`} style={{ background: dot }} />}
      {s.kind === "processing" && s.run ? runLabel(t, s.run.state) : t(`room.status.${s.kind}`)}
    </span>
  );
}

/** "Last delivery" cell: outcome icon-dot + relative time + submission link. Same verdict as the status column. */
export function DeliveryCell({ s, now }: { s: RoomStatus; now: number }): ReactNode {
  const t = useT();
  const d: Delivery = lastDelivery(s.run);
  const tone: Record<Delivery["kind"], string> = {
    none: "var(--muted-soft)", running: "var(--status-fg)", uploaded: "var(--success-fg)",
    archived: "var(--muted)", stopped: "var(--muted)", fault: "var(--warning-fg)",
  };
  const age = d.at != null ? ageOf(now, d.at) : null;
  return (
    <span className="inline-flex flex-col min-w-0">
      <span className="inline-flex items-center gap-1.5 text-[13px] font-medium" style={{ color: tone[d.kind] }}>
        <span className="dot" style={{ background: tone[d.kind] }} />
        {t(`room.lastDeliver.${d.kind}`)}
      </span>
      {(age || d.bv) && (
        <span className="text-[11px] text-muted-soft mt-0.5 truncate">
          {age && t(`room.ago.${age.unit}`, { n: String(age.n) })}
          {d.bv && (
            <>
              {age && " · "}
              <a href={`https://www.bilibili.com/video/${d.bv}`} target="_blank" rel="noreferrer"
                 className="hover:text-ink hover:underline" title={t("room.lastDeliver.openBv")}>{d.bv}</a>
            </>
          )}
        </span>
      )}
    </span>
  );
}

export function runLabel(t: ReturnType<typeof useT>, state: string): string {
  const k = `room.run.${state}`;
  const v = t(k);
  return v === k ? state : v;
}

/** One-line "why" next to the badge. Only facts we actually have — no invented progress. */
export function statusDetail(t: ReturnType<typeof useT>, r: RoomDTO, s: RoomStatus): string {
  const phase = s.phase;
  switch (s.kind) {
    case "recording": {
      const nodes = phase?.recordingNodes.length ? phase.recordingNodes.join(" · ") : t("room.detail.local");
      return phase?.kind === "recording" ? nodes : `${t(phase?.textKey ?? "badge.recording", { nodes })}`;
    }
    case "processing":
      return deliverText(t, r);
    case "attention":
      if (phase && (phase.kind === "offline" || phase.kind === "error")) {
        return t(phase.textKey, { nodes: phase.unavailableNodes.join(" · ") });
      }
      return s.run ? runLabel(t, s.run.state) : "";
    case "waiting":
    case "paused": {
      const parts: string[] = [];
      if (s.kind === "waiting") parts.push((r.recording && scheduleText(r.recording)) || t("room.allDay"));
      else if (r.processing?.enabled === false) parts.push(t("room.pausedRule"));
      else if (!r.recording) parts.push(t("room.noTask"));
      const hint = lastRunHint(s.run);
      if (hint) parts.push(hint.kind === "bv" ? t("room.lastBv") : t("room.lastRun", { state: runLabel(t, hint.state) }));
      return parts.join(" · ");
    }
  }
}

/**
 * Room actions shared by list + detail. Turning a room off = hard stop of the task (cuts the
 * current segment) → always confirmed; on = start. Drain stops after the current stream ends.
 */
export function useRoomActions(data: Pick<RoomsData, "refresh" | "taskOf">, opts: { onDeleted?: () => void } = {}) {
  const t = useT();
  const toast = useToast();
  const [confirm, setConfirm] = useState<{ kind: "stop" | "delete"; room: RoomDTO } | null>(null);
  const [editing, setEditing] = useState<RoomDTO | null>(null);

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    try {
      await fn();
      await data.refresh().catch(() => {});
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const taskIdOf = (r: RoomDTO): number | null => r.recording?.taskId ?? null;
  const setEnabled = (r: RoomDTO, on: boolean): void => {
    const id = taskIdOf(r);
    if (id === null) return;
    if (on) void run(() => api.startTask(id));
    else setConfirm({ kind: "stop", room: r });
  };
  const drain = (r: RoomDTO): void => {
    const id = taskIdOf(r);
    if (id !== null) void run(() => api.drainTask(id));
  };
  const managedOf = (r: RoomDTO): boolean => data.taskOf(r)?.managedBy === "hub";

  const dialogs = (
    <>
      {editing && (
        <RoomEditor
          room={editing}
          managed={managedOf(editing)}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void data.refresh().catch(() => {}); }}
          onDelete={taskIdOf(editing) !== null && !managedOf(editing) ? () => setConfirm({ kind: "delete", room: editing }) : undefined}
        />
      )}
      <ConfirmDialog
        open={confirm !== null}
        title={confirm?.kind === "delete"
          ? t("rooms.deleteConfirm", { name: confirm ? roomName(confirm.room) : "" })
          : t("rooms.stopConfirm", { name: confirm ? roomName(confirm.room) : "" })}
        confirmLabel={confirm?.kind === "delete" ? t("common.delete") : t("rooms.stopNow")}
        destructive
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          if (!confirm) return;
          const { kind, room } = confirm;
          const id = taskIdOf(room);
          setConfirm(null);
          if (id === null) return;
          if (kind === "stop") { void run(() => api.stopTask(id)); return; }
          void run(async () => {
            await api.deleteTask(id);
            setEditing(null);
            toast(t("rooms.deleted"), "info");
            opts.onDeleted?.();
          });
        }}
      />
    </>
  );
  return { setEnabled, drain, edit: setEditing, managedOf, dialogs };
}
