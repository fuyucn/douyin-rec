/**
 * RoomPage — `/rooms/:key` detail: status → numbers → nodes → runs, top to bottom.
 *
 * The summary (header + telemetry band + nodes) fits one screen; runs below reuse
 * `RoomRunsPanel` (Hub's RunCard: workflow DAG / logs / retry) instead of redrawing it.
 * Only real data is shown — no synthesized progress or ETA beyond what RunCard already has.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, FileText, Pencil, Timer } from "lucide-react";
import { api, type TaskDetail } from "../api/client";
import { Button } from "../components/Button";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { RoomRunsPanel } from "../components/RoomRunsPanel";
import { Switch } from "../components/Switch";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtClock, scheduleText } from "../lib/labels";
import { deliverText, nodesText, roomName, RoomBadge, runLabel, statusDetail, useRoomActions, useRoomsData } from "./rooms/shared";

export function RoomPage(): ReactNode {
  const t = useT();
  const navigate = useNavigate();
  const { key = "" } = useParams();
  const data = useRoomsData();
  const actions = useRoomActions(data, { onDeleted: () => navigate("/rooms") });
  const room = data.rooms.find((r) => r.key === key);
  const task = room ? data.taskOf(room) : undefined;
  const s = room ? data.statusOf(room) : null;
  const taskId = room?.recording?.taskId ?? null;

  // Elapsed time only exists for a local recorder process (runtime); remote-only → "—".
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const live = s?.kind === "recording";
  usePolling(() => {
    if (taskId === null || !live) return;
    void api.getTask(taskId).then(setDetail).catch(() => {});
  }, 5_000, live);
  useEffect(() => { if (!live) setDetail(null); }, [live]);

  if (!data.loaded) return <div className="skeleton h-40 w-full" aria-hidden="true" />;
  if (!room || !s) {
    return (
      <div className="empty-state">
        <div className="text-sm font-medium text-ink">{t("room.detail.notFound")}</div>
        <Link className="btn-secondary btn-sm" to="/rooms">{t("room.detail.back")}</Link>
      </div>
    );
  }

  const enabled = task?.enabled ?? room.recording?.enabled ?? false;
  const managed = actions.managedOf(room);
  const workers = task?.recordingWorkers ?? [];
  const recNodes = workers.filter((w) => w.state === "recording").length;
  const up = room.processing?.pipeline?.upload;
  const delivery = deliverText(t, room) + (up?.mode === "upload" || up?.mode === "rolling"
    ? ` · ${up.private === false ? t("room.publicShort") : t("room.privateShort")}`
    : room.recording?.outputFormat && room.recording.outputFormat !== "original" ? ` · ${room.recording.outputFormat.toUpperCase()}` : "");

  return (
    <>
      <Link to="/rooms" className="rm-back"><ArrowLeft className="w-3.5 h-3.5" />{t("room.detail.back")}</Link>

      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h1 className="headline text-[24px] sm:text-[32px] leading-tight flex items-center gap-3 min-w-0">
            <span className="truncate">{roomName(room)}</span>
            <RoomBadge s={s} />
          </h1>
          <p className="text-muted text-sm mt-1.5 truncate">
            {[room.platform, room.recording ? scheduleText(room.recording) || t("room.allDay") : t("room.noTask"), nodesText(room, data.workers, t("room.allNodes"))].join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
          {live && enabled && !managed && (
            <Button variant="secondary" small onClick={() => actions.drain(room)} title={t("room.detail.drain")}>
              <Timer className="w-4 h-4" /><span className="hidden sm:inline">{t("room.detail.drain")}</span>
            </Button>
          )}
          {taskId !== null && (
            <Link to={`/task/${taskId}`} className="btn-secondary btn-sm" title={t("room.detail.logs")}>
              <FileText className="w-4 h-4" /><span className="hidden sm:inline">{t("room.detail.logs")}</span>
            </Link>
          )}
          <Button variant="secondary" small onClick={() => actions.edit(room)} title={t("room.detail.edit")}>
            <Pencil className="w-4 h-4" /><span className="hidden sm:inline">{t("room.detail.edit")}</span>
          </Button>
          <span title={managed ? t("tasks.managedHint") : undefined}>
            <Switch checked={enabled} disabled={!room.recording || managed} onCheckedChange={(on) => actions.setEnabled(room, on)} />
          </span>
        </div>
      </div>

      <HubStreamBanner handle={data.stream} />

      <div className="telemetry-bar rm-tele mb-3 sm:mb-4">
        <Cell label={t("room.detail.recorded")} value={live ? fmtClock(detail?.runtime?.elapsedMs) : "—"} mono />
        <Cell label={t("room.detail.nodes")} value={workers.length ? `${recNodes}/${workers.length}` : live ? t("room.detail.local") : "—"} />
        <Cell label={t("room.detail.lastRun")} value={s.run ? runLabel(t, s.run.state) : "—"} small />
        <Cell label={t("room.detail.deliver")} value={delivery} small />
      </div>

      {(s.kind === "attention" || workers.length > 0) && (
        <section className="table-shell mb-4">
          {s.kind === "attention" && (
            <div className="rm-node-row" style={{ color: "var(--warning-fg)" }}>
              <span className="dot" style={{ background: "var(--warning)" }} />
              <span className="text-[13px]">{statusDetail(t, room, s)}</span>
            </div>
          )}
          {workers.map((w) => (
            <div key={w.workerId} className="rm-node-row">
              <span className={`dot${w.state === "recording" ? " dot-running" : ""}`}
                    style={{ background: w.state === "recording" ? "var(--success)" : w.state === "unavailable" ? "var(--error)" : "var(--muted-soft)" }} />
              <span className="font-mono text-[12px] text-ink">{w.workerName}</span>
              <span className="text-[12.5px] text-muted">
                {t(w.state === "recording" ? "room.detail.nodeRecording" : w.state === "unavailable" ? "room.detail.nodeDown" : "room.detail.nodeIdle")}
              </span>
            </div>
          ))}
        </section>
      )}

      <RoomRunsPanel room={room} workers={data.workers} collapsed />
      {actions.dialogs}
    </>
  );
}

function Cell({ label, value, mono, small }: { label: string; value: string; mono?: boolean; small?: boolean }): ReactNode {
  return (
    <div className="telemetry-cell">
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="telemetry-label">{label}</span>
        <span className={`telemetry-value truncate${mono ? " telemetry-value-mono" : ""}${small ? " rm-value-sm" : ""}`}>{value}</span>
      </div>
    </div>
  );
}
