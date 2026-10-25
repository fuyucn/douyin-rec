/**
 * RoomsPage — `/rooms` list: one row per live room, sorted by what needs eyes first.
 *
 * Same visual language as the tasks page (telemetry band, table shell, chips/badges, icon
 * actions) so the two screens read as one product; the telemetry band doubles as the filter.
 * Coexists with the Tasks and Hub pages (untouched); data comes from the same APIs.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Activity, FileText, FolderOpen, LayoutGrid, Loader, Pencil, Play, Plus, Server, Square, TriangleAlert } from "lucide-react";
import { api, type RoomDTO, type WorkerStatus } from "../api/client";
import { Button, IconButton } from "../components/Button";
import { ConnStatus } from "../components/ConnStatus";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { WorkersPanel } from "../components/WorkersPanel";
import { AddRoomDialog } from "../modals/AddRoomDialog";
import { useTicker } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { roomId, scheduleText } from "../lib/labels";
import { sortByStatus, type RoomStatusKind } from "../lib/room-status";
import { DeliveryCell, deliverText, nodesText, roomName, RoomBadge, statusDetail, useRoomActions, useRoomsData } from "./rooms/shared";

type Filter = "all" | Extract<RoomStatusKind, "recording" | "processing" | "attention">;
const FILTER_TONE: Record<Filter, string | undefined> = {
  all: undefined, recording: "var(--success-fg)", processing: "var(--status-fg)", attention: "var(--warning-fg)",
};

export function RoomsPage(): ReactNode {
  const t = useT();
  const data = useRoomsData();
  const actions = useRoomActions(data);
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [workersOpen, setWorkersOpen] = useState(false);
  const [workerStatus, setWorkerStatus] = useState<Record<string, WorkerStatus>>({});
  // Relative times ("5 min ago") must keep moving even though the page is push-driven.
  const now = useTicker(30_000);
  const { rooms, loaded, statusOf } = data;

  const sorted = useMemo(() => sortByStatus(rooms, statusOf), [rooms, statusOf]);
  const count = (f: Filter): number => (f === "all" ? rooms.length : rooms.filter((r) => statusOf(r).kind === f).length);
  const shown = filter === "all" ? sorted : sorted.filter((r) => statusOf(r).kind === filter);
  const attention = sorted.filter((r) => statusOf(r).kind === "attention");

  const openWorkers = (): void => {
    setWorkersOpen(true);
    void api.getWorkersStatus()
      .then((list) => setWorkerStatus(Object.fromEntries(list.map((s) => [s.id, s]))))
      .catch(() => {});
  };

  const cell = (f: Filter, icon: ReactNode): ReactNode => (
    <div role="tab" tabIndex={0} aria-selected={filter === f}
         className={`telemetry-cell${filter === f ? " is-on" : ""}`}
         onClick={() => setFilter(f)} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(f); } }}>
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="telemetry-label">{f === "all" ? t("room.all") : t(`room.status.${f}`)}</span>
        <span className="telemetry-value tabular-nums" style={count(f) ? { color: FILTER_TONE[f] } : undefined}>
          {loaded ? count(f) : "–"}
        </span>
      </div>
      <span className="telemetry-icon" style={count(f) ? { color: FILTER_TONE[f] } : undefined}>{icon}</span>
    </div>
  );

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3 mb-6">
        <div className="min-w-0">
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("room.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("room.subtitle")}</p>
        </div>
        <div className="flex w-full sm:w-auto flex-wrap items-center gap-2 sm:gap-3 min-w-0">
          <ConnStatus conn={data.conn} />
          <Button small variant="secondary" onClick={openWorkers} className="min-w-0 flex-1 sm:flex-none">
            <Server className="w-4 h-4" />
            <span className="truncate">{t("hub.workers.pill", { count: data.workers.length })}</span>
          </Button>
          <Button onClick={() => setCreateOpen(true)} aria-label={t("room.add")} className="rm-add">
            <Plus className="w-4 h-4" />
            <span className="rm-add-label">{t("room.add")}</span>
          </Button>
        </div>
      </div>

      <HubStreamBanner handle={data.stream} />

      <div className="telemetry-bar mb-5" role="tablist">
        {cell("all", <LayoutGrid className="w-4 h-4" />)}
        {cell("recording", <Activity className="w-4 h-4" />)}
        {cell("processing", <Loader className="w-4 h-4" />)}
        {cell("attention", <TriangleAlert className="w-4 h-4" />)}
      </div>

      {attention.length > 0 && filter !== "attention" && (
        <div className="status-strip rm-alert mb-3 sm:mb-4">
          <span className="dot" style={{ background: "var(--warning)" }} />
          <span className="flex-1 min-w-0 truncate">
            <b className="text-ink font-medium">{t("room.alertCount", { count: attention.length })}</b>
            <span className="text-muted-soft">
              {" · "}{roomName(attention[0])}{" · "}{statusDetail(t, attention[0], statusOf(attention[0]))}
            </span>
          </span>
          <Button small variant="secondary" onClick={() => setFilter("attention")}>{t("room.view")}</Button>
        </div>
      )}

      <section className="table-shell">
        <div className="lg:hidden">
          {!loaded && [0, 1, 2].map((i) => (
            <div key={i} className="task-compact px-4 py-3.5" aria-hidden="true">
              <span className="skeleton block h-4 w-32 max-w-full" />
              <span className="skeleton block h-3 w-40 max-w-full mt-2" />
            </div>
          ))}
          {loaded && shown.length === 0 && <Empty t={t} empty={rooms.length === 0} />}
          {loaded && shown.map((r) => <RoomCompactRow key={r.key} room={r} data={data} actions={actions} now={now} />)}
        </div>

        <div className="hidden lg:block min-w-0 overflow-x-auto">
          <table className="tasks" style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th>{t("room.colRoom")}</th>
                <th className="w-[118px]">{t("room.colLastDeliver")}</th>
                <th className="w-[138px]">{t("room.colNodes")}</th>
                <th className="w-[104px]">{t("room.colSchedule")}</th>
                <th className="w-[178px]">{t("room.colStatus")}</th>
                <th className="w-[150px] text-right">{t("room.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && [0, 1, 2].map((i) => (
                <tr key={i} aria-hidden="true">
                  <td><span className="skeleton block h-4 w-40 max-w-full" /></td>
                  <td><span className="skeleton block h-4 w-16" /></td>
                  <td><span className="skeleton block h-4 w-24" /></td>
                  <td><span className="skeleton block h-4 w-20" /></td>
                  <td><span className="skeleton block h-4 w-28" /></td>
                  <td><span className="skeleton block h-8 w-8" /></td>
                </tr>
              ))}
              {loaded && shown.length === 0 && (
                <tr><td colSpan={6} className="p-0"><Empty t={t} empty={rooms.length === 0} /></td></tr>
              )}
              {loaded && shown.map((r) => (
                <tr key={r.key}>
                  <td>
                    <Link to={`/rooms/${encodeURIComponent(r.key)}`} className="group block min-w-0">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="font-medium text-ink truncate group-hover:underline">{roomName(r)}</span>
                        {actions.managedOf(r) && <span className="badge badge-muted shrink-0">{t("tasks.managed")}</span>}
                      </div>
                      <div className="font-mono text-xs text-muted mt-0.5 truncate" title={r.room}>
                        {roomId(r.room)} · {r.platform} · {deliverText(t, r)}
                        {r.processing?.pipeline?.upload?.private === false && ` · ${t("room.publicShort")}`}
                      </div>
                    </Link>
                  </td>
                  <td><DeliveryCell s={statusOf(r)} now={now} /></td>
                  <td className="font-mono text-[11px] text-muted truncate max-w-0" title={nodesText(r, data.workers, t("room.allNodes"))}>{nodesText(r, data.workers, t("room.allNodes"))}</td>
                  <td>
                    {scheduleText(scheduleOf(r)) ? (
                      <span className="font-mono text-[12.5px] text-body tabular-nums whitespace-nowrap">{scheduleText(scheduleOf(r))}</span>
                    ) : <span className="text-muted-soft">-</span>}
                  </td>
                  <td>
                    <div className="min-w-0">
                      <RoomBadge s={statusOf(r)} />
                      <div className="text-[11px] text-muted truncate mt-0.5" title={statusDetail(t, r, statusOf(r))}>
                        {statusDetail(t, r, statusOf(r))}
                      </div>
                    </div>
                  </td>
                  <td className="text-right whitespace-nowrap">
                    <RoomActions room={r} data={data} actions={actions} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {actions.dialogs}
      <AddRoomDialog
        open={createOpen}
        hubEnabled={data.hubEnabled}
        workers={data.workers}
        onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); void data.refresh().catch(() => {}); }}
      />
      <WorkersPanel
        open={workersOpen}
        onClose={() => setWorkersOpen(false)}
        workers={data.workers}
        status={workerStatus}
        onChanged={() => { void data.refreshWorkers().catch(() => {}); }}
      />
    </>
  );
}

/** Recording half may be missing (rule-only room); scheduleText wants both endpoints. */
function scheduleOf(r: RoomDTO): Pick<NonNullable<RoomDTO["recording"]>, "scheduleStart" | "scheduleEnd"> {
  return r.recording ?? { scheduleStart: null, scheduleEnd: null };
}

function Empty({ t, empty }: { t: ReturnType<typeof useT>; empty: boolean }): ReactNode {
  return (
    <div className="empty-state">
      <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
      <div className="text-sm font-medium text-ink">{empty ? t("rooms.empty") : t("rooms.noMatch")}</div>
    </div>
  );
}

/** Start/stop + logs + edit, matching the tasks table action column. Delete lives in the editor. */
function RoomActions({ room, data, actions }: {
  room: RoomDTO;
  data: ReturnType<typeof useRoomsData>;
  actions: ReturnType<typeof useRoomActions>;
}): ReactNode {
  const t = useT();
  const task = data.taskOf(room);
  const managed = actions.managedOf(room);
  const enabled = task?.enabled ?? room.recording?.enabled ?? false;
  const taskId = room.recording?.taskId ?? null;
  return (
    <div className="inline-flex items-center gap-1.5 justify-end">
      {task ? (
        enabled ? (
          <IconButton title={managed ? t("tasks.managedHint") : t("tasks.titleStop")} disabled={managed} onClick={() => actions.setEnabled(room, false)}>
            <Square className="w-4 h-4" style={{ color: "var(--warning-fg)" }} />
          </IconButton>
        ) : (
          <IconButton title={managed ? t("tasks.managedHint") : t("tasks.titleStart")} disabled={managed} onClick={() => actions.setEnabled(room, true)}>
            <Play className="w-4 h-4" style={{ color: "var(--success-fg)" }} fill="currentColor" />
          </IconButton>
        )
      ) : null}
      {taskId !== null && (
        <Link className="btn-icon" to={`/rooms/${encodeURIComponent(room.key)}?logs=1`} title={t("room.detail.logs")}><FileText className="w-4 h-4" /></Link>
      )}
      <IconButton title={t("room.detail.edit")} onClick={() => actions.edit(room)}><Pencil className="w-4 h-4" /></IconButton>
    </div>
  );
}

function RoomCompactRow({ room, data, actions, now }: {
  now: number;
  room: RoomDTO;
  data: ReturnType<typeof useRoomsData>;
  actions: ReturnType<typeof useRoomActions>;
}): ReactNode {
  const t = useT();
  const s = data.statusOf(room);
  return (
    <div className="task-compact px-4 py-3.5">
      <div className="flex items-start justify-between gap-3">
        <Link to={`/rooms/${encodeURIComponent(room.key)}`} className="min-w-0 group">
          <div className="font-medium text-ink truncate group-hover:underline">{roomName(room)}</div>
          <div className="font-mono text-xs text-muted mt-0.5 truncate">{roomId(room.room)} · {room.platform}</div>
        </Link>
        <RoomActions room={room} data={data} actions={actions} />
      </div>
      <div className="mt-2 max-w-full flex items-center gap-2 min-w-0">
        <RoomBadge s={s} />
        <span className="text-[12px] text-muted truncate">{statusDetail(t, room, s)}</span>
      </div>
      <div className="mt-2"><DeliveryCell s={s} now={now} /></div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="chip">{deliverText(t, room)}</span>
        {scheduleText(scheduleOf(room)) && <span className="font-mono text-[11px] text-muted-soft tabular-nums">{scheduleText(scheduleOf(room))}</span>}
        <span className="font-mono text-[11px] text-muted-soft truncate">{nodesText(room, data.workers, t("room.allNodes"))}</span>
      </div>
    </div>
  );
}
