/**
 * RoomsPage — `/rooms` list: one row per live room, sorted by what needs eyes first.
 *
 * One screen by design: the telemetry band doubles as the filter (no separate chip row), faults
 * collapse into a single alert line, and each row is one line on desktop / two on phones.
 * Click a row → `/rooms/:key`. The switch is the room's recording intent (task enabled).
 *
 * Coexists with the Tasks and Hub pages (they are untouched); data comes from the same APIs.
 */
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FolderOpen, Plus } from "lucide-react";
import type { RoomDTO } from "../api/client";
import { Button } from "../components/Button";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { Switch } from "../components/Switch";
import { CreateEditTaskDialog } from "../modals/CreateEditTaskDialog";
import { useT } from "../lib/i18n";
import { sortByStatus, type RoomStatusKind } from "../lib/room-status";
import { nodesText, roomName, RoomBadge, statusDetail, useRoomActions, useRoomsData } from "./rooms/shared";

type Filter = "all" | Extract<RoomStatusKind, "recording" | "processing" | "attention">;
const FILTERS: Filter[] = ["all", "recording", "processing", "attention"];
const FILTER_COLOR: Record<Filter, string | undefined> = {
  all: undefined, recording: "var(--success-fg)", processing: "var(--status-fg)", attention: "var(--warning-fg)",
};

export function RoomsPage(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const data = useRoomsData();
  const actions = useRoomActions(data);
  const [filter, setFilter] = useState<Filter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const { rooms, loaded, statusOf } = data;

  const sorted = useMemo(() => sortByStatus(rooms, statusOf), [rooms, statusOf]);
  const count = (f: Filter): number => (f === "all" ? rooms.length : rooms.filter((r) => statusOf(r).kind === f).length);
  const shown = filter === "all" ? sorted : sorted.filter((r) => statusOf(r).kind === filter);
  const attention = sorted.filter((r) => statusOf(r).kind === "attention");

  return (
    <>
      <div className="flex items-end justify-between gap-4 mb-4 sm:mb-5">
        <div className="min-w-0">
          <h1 className="headline text-[24px] sm:text-[32px] leading-tight">{t("room.title")}</h1>
          <p className="text-muted text-sm mt-1.5 hidden sm:block">{t("room.subtitle")}</p>
        </div>
        <Button onClick={() => setCreateOpen(true)} aria-label={t("room.add")} className="rm-add">
          <Plus className="w-4 h-4" />
          <span className="rm-add-label">{t("room.add")}</span>
        </Button>
      </div>

      <HubStreamBanner handle={data.stream} />

      <div className="telemetry-bar rm-tele mb-3 sm:mb-4" role="tablist">
        {FILTERS.map((f) => (
          <div key={f} role="tab" tabIndex={0} aria-selected={filter === f}
               className={`telemetry-cell${filter === f ? " is-on" : ""}`}
               onClick={() => setFilter(filter === f && f !== "all" ? "all" : f)}
               onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setFilter(f); } }}>
            <div className="flex flex-col gap-1.5 min-w-0">
              <span className="telemetry-label">{f === "all" ? t("room.all") : t(`room.status.${f}`)}</span>
              <span className="telemetry-value tabular-nums" style={{ color: count(f) || f === "all" ? FILTER_COLOR[f] : "var(--muted-soft)" }}>
                {loaded ? count(f) : "–"}
              </span>
            </div>
          </div>
        ))}
      </div>

      {attention.length > 0 && filter !== "attention" && (
        <div className="status-strip rm-alert mb-3 sm:mb-4">
          <span className="dot" style={{ background: "var(--warning)" }} />
          <span className="flex-1 min-w-0 truncate">
            <b className="text-ink font-medium">{roomName(attention[0])}</b>
            {" · "}{statusDetail(t, attention[0], statusOf(attention[0]))}
            {attention.length > 1 && <span className="text-muted-soft"> · {t("room.alertMore", { n: attention.length - 1 })}</span>}
          </span>
          <Button small variant="secondary" onClick={() => (attention.length > 1 ? setFilter("attention") : navigate(`/rooms/${encodeURIComponent(attention[0].key)}`))}>
            {t("room.view")}
          </Button>
        </div>
      )}

      <section className="table-shell">
        {!loaded && [0, 1, 2].map((i) => (
          <div key={i} className="rm-row" aria-hidden="true">
            <span className="skeleton block h-4 w-32" /><span className="skeleton block h-4 w-48 max-w-full" />
          </div>
        ))}
        {loaded && shown.length === 0 && (
          <div className="empty-state">
            <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
            <div className="text-sm font-medium text-ink">{rooms.length === 0 ? t("rooms.empty") : t("rooms.noMatch")}</div>
          </div>
        )}
        {loaded && shown.map((r) => (
          <RoomRow key={r.key} room={r} data={data} actions={actions}
                   onOpen={() => navigate(`/rooms/${encodeURIComponent(r.key)}`)} />
        ))}
      </section>

      {actions.dialogs}
      <CreateEditTaskDialog
        open={createOpen}
        task={null}
        onClose={() => setCreateOpen(false)}
        onSaved={() => { setCreateOpen(false); void data.refresh().catch(() => {}); }}
      />
    </>
  );
}

function RoomRow({ room, data, actions, onOpen }: {
  room: RoomDTO;
  data: ReturnType<typeof useRoomsData>;
  actions: ReturnType<typeof useRoomActions>;
  onOpen: () => void;
}): ReactNode {
  const t = useT();
  const s = data.statusOf(room);
  const task = data.taskOf(room);
  const enabled = task?.enabled ?? room.recording?.enabled ?? false;
  const managed = actions.managedOf(room);
  return (
    <div className={`rm-row${s.kind === "paused" ? " is-off" : ""}`} onClick={onOpen}>
      <div className="rm-name">
        <Link to={`/rooms/${encodeURIComponent(room.key)}`} onClick={(e) => e.stopPropagation()} className="text-ink font-medium truncate">
          {roomName(room)}
        </Link>
        <span className="font-mono text-[11px] text-muted shrink-0">{room.platform}</span>
      </div>
      <div className="rm-status">
        <RoomBadge s={s} />
        <span className="text-[12.5px] text-muted truncate">{statusDetail(t, room, s)}</span>
      </div>
      <div className="rm-nodes font-mono text-[11px] text-muted truncate">{nodesText(room, data.workers, t("room.allNodes"))}</div>
      <div className="rm-switch" onClick={(e) => e.stopPropagation()}
           title={managed ? t("tasks.managedHint") : !room.recording ? t("room.noTask") : undefined}>
        <Switch checked={enabled} disabled={!room.recording || managed} onCheckedChange={(on) => actions.setEnabled(room, on)} />
      </div>
    </div>
  );
}
