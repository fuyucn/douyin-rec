/**
 * RoomPage — `/rooms/:key` detail, laid out like the task detail page: header with actions,
 * telemetry band, an info card on the left (live room / recording / processing / runtime) and the
 * room's runs on the right (reuses `RoomRunsPanel`: workflow DAG / logs / retry).
 * Only real data is shown — no synthesized progress or ETA beyond what the runs panel already has.
 */
import { useEffect, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { CalendarRange, ChevronLeft, Clock3, ExternalLink, FileText, MonitorPlay, UploadCloud } from "lucide-react";
import { api, type TaskDetail } from "../api/client";
import { useAtomValue } from "jotai";
import { serverTimezoneAtom } from "../atoms";
import { Button } from "../components/Button";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { TaskLogPanel } from "../components/LogTerminal";
import { RollingProgressRows, useRoomRolling } from "../components/RollingProgress";
import { RoomRunsPanel } from "../components/RoomRunsPanel";
import { Tooltip } from "../components/Tooltip";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { QUALITY_FULL, fmtClock, fmtStartedAt, platformLabel, roomHref, roomId, scheduleText } from "../lib/labels";
import { localTimeTooltip } from "../lib/tz";
import { versionKeys } from "../lib/room-detail";
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

  // Logs live on this page (no hop to the task page). The list's log icon arrives with ?logs=1.
  const [params, setParams] = useSearchParams();
  const [logsOpen, setLogsOpen] = useState(params.get("logs") === "1");
  // Switching rooms must not carry the open/closed state over; closing drops ?logs=1 so a refresh stays closed.
  useEffect(() => { setLogsOpen(params.get("logs") === "1"); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLogs = (): void => {
    const next = !logsOpen;
    setLogsOpen(next);
    setParams(next ? { logs: "1" } : {}, { replace: true });
  };

  // Below the `lg` breakpoint the page is one column and the log panel sits under the info column, i.e. off
  // screen. Bring it into view when it opens (also for the list's ?logs=1 arrival, once the room has loaded).
  const logsMounted = logsOpen && !!room && taskId !== null;
  useEffect(() => {
    if (!logsMounted || !window.matchMedia("(max-width: 1023px)").matches) return;
    document.getElementById("logs")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [logsMounted]);

  // Elapsed time only exists for a local recorder process (runtime); remote-only → "—".
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const live = s?.kind === "recording";
  usePolling(() => {
    if (taskId === null || !live) return;
    void api.getTask(taskId).then(setDetail).catch(() => {});
  }, 5_000, live);
  useEffect(() => { if (!live) setDetail(null); }, [live]);
  const rolling = useRoomRolling(room ? room.roomSlug : null);
  const serverTz = useAtomValue(serverTimezoneAtom);

  if (!data.loaded) return <div className="skeleton h-40 w-full" aria-hidden="true" />;
  if (!room || !s) {
    return (
      <div className="empty-state">
        <div className="text-sm font-medium text-ink">{t("room.detail.notFound")}</div>
        <Link className="btn-secondary btn-sm" to="/rooms">{t("room.detail.back")}</Link>
      </div>
    );
  }

  const rec = room.recording;
  const proc = room.processing;
  const enabled = task?.enabled ?? rec?.enabled ?? false;
  const managed = actions.managedOf(room);
  const workers = task?.recordingWorkers ?? [];
  const recNodes = workers.filter((w) => w.state === "recording").length;
  const up = proc?.pipeline?.upload;
  const uploading = up?.mode === "upload" || up?.mode === "rolling";
  const delivery = deliverText(t, room) + (uploading
    ? ` · ${up?.private === false ? t("room.publicShort") : t("room.privateShort")}`
    : rec?.outputFormat && rec.outputFormat !== "original" ? ` · ${rec.outputFormat.toUpperCase()}` : "");
  const sched = rec ? scheduleText(rec) : null;
  // Only a local recorder process reports elapsed time; a remote recording has none to show.
  const elapsed = live ? detail?.runtime?.elapsedMs ?? null : null;
  const startedAt = live ? detail?.runtime?.startedAt ?? null : null;
  const steps = proc?.pipeline?.steps;
  const versions = versionKeys(room).map((k) => t(k)).join(" + ");

  return (
    <>
      <Link to="/rooms" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors mb-5">
        <ChevronLeft className="w-4 h-4" />
        {t("room.detail.backToList")}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="headline text-[26px] sm:text-[30px] leading-tight break-all">{roomName(room)}</h1>
            <RoomBadge s={s} />
            {managed && <span className="badge badge-muted" title={t("tasks.managedHint")}>{t("tasks.managed")}</span>}
          </div>
          {s.kind === "attention" && (
            <p className="text-sm mt-1.5" style={{ color: "var(--warning-fg)" }}>{statusDetail(t, room, s)}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {rec && !enabled && (
            <Button small onClick={() => actions.setEnabled(room, true)} disabled={managed || !!task?.stopping}
                    title={task?.stopping ? t("tasks.stoppingHint") : managed ? t("tasks.managedHint") : undefined}>
              {t("tasks.start")}
            </Button>
          )}
          {rec && enabled && live && !managed && (
            <Button small variant="secondary" onClick={() => actions.drain(room)}>{t("room.detail.drain")}</Button>
          )}
          {rec && enabled && (
            <Button small variant="secondary" onClick={() => actions.setEnabled(room, false)} disabled={managed}
                    title={managed ? t("tasks.managedHint") : undefined}>
              {t("tasks.stop")}
            </Button>
          )}
          {taskId !== null && (
            <Button small variant="secondary" onClick={toggleLogs} aria-expanded={logsOpen}>
              <FileText className="w-4 h-4" />{t(logsOpen ? "room.detail.hideLogs" : "room.detail.showLogs")}
            </Button>
          )}
          <Button small variant="secondary" onClick={() => actions.edit(room)}>{t("room.detail.edit")}</Button>
        </div>
      </div>

      <HubStreamBanner handle={data.stream} />

      <div className="telemetry-bar mb-6">
        <Cell label={t("room.detail.recorded")} icon={<Clock3 className="w-4 h-4" />} tone={elapsed != null ? "var(--success-fg)" : undefined}
              value={elapsed != null ? fmtClock(elapsed) : live && recNodes > 0 ? t("room.detail.remoteRecording") : "-"}
              valueClass={elapsed != null ? "telemetry-value tabular-nums" : "telemetry-value-sm truncate"} />
        <Cell label={t("tasks.nodesBound")} icon={<MonitorPlay className="w-4 h-4" />}
              value={workers.length ? `${recNodes}/${workers.length}` : nodesText(room, data.workers, t("room.allNodes"))} />
        <Cell label={t("room.detail.deliver")} icon={<UploadCloud className="w-4 h-4" />} value={delivery} />
        <Cell label={t("tasks.schedule")} icon={<CalendarRange className="w-4 h-4" />}
              value={rec ? sched ?? t("room.allDay") : "-"} valueClass="telemetry-value-mono truncate" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-1">
          <div className="flex items-center justify-between mb-4">
            <h3 className="section-label">{t("room.detail.info")}</h3>
            <span className="font-mono text-[10px] text-muted-soft uppercase">{room.platform}</span>
          </div>
          <div className="card p-5 space-y-5">
            <InfoGroup title={t("tasks.groupLive")}>
              <Row label={t("tasks.room")} mono value={
                <a href={roomHref(room.room)} target="_blank" rel="noreferrer"
                   className="inline-flex items-center gap-1 text-ink hover:underline" title={t("tasks.openLive")}>
                  {roomId(room.room)}<ExternalLink className="w-3.5 h-3.5 opacity-70" />
                </a>
              } />
              <Row label={t("tasks.anchor")} value={rec?.anchorName ?? "-"} />
              <Row label={t("tasks.savedName")} value={rec?.name ?? "-"} />
              <Row label={t("tasks.platform")} mono value={platformLabel(room.platform)} />
            </InfoGroup>

            <InfoGroup title={t("tasks.groupRecord")}>
              {rec ? (
                <>
                  <Row label={t("tasks.quality")} value={QUALITY_FULL[rec.quality] ?? rec.quality} />
                  <Row label={t("tasks.recorder")} mono value={rec.engine} />
                  <Row label={t("tasks.danmu")} value={rec.danmu ? t("common.yes") : t("common.no")} />
                  <Row label={t("tasks.giftCookie")} value={rec.useCookie ? t("common.yes") : t("common.no")} />
                  <Row label={t("tasks.segmentSec")} mono
                       value={rec.segmentSec > 0 ? t("tasks.segmentUnit", { s: String(rec.segmentSec) }) : t("tasks.noSegment")} />
                  <Row label={t("rooms.outputFormat")} mono
                       value={rec.outputFormat === "original" ? t("rooms.outputFormatOriginal") : rec.outputFormat.toUpperCase()} />
                  <Row label={t("tasks.outDir")} mono value={rec.outDir ?? "-"} />
                </>
              ) : <Row label={t("tasks.room")} value={t("room.noTask")} />}
            </InfoGroup>

            <InfoGroup title={t("tasks.groupPipeline")}>
              {proc ? (
                <>
                  <Row label={t("room.detail.process")} value={proc.enabled ? t("room.detail.procOn") : t("room.pausedRule")} />
                  <Row label={t("room.detail.deliver")} value={delivery} />
                  <Row label={t("room.editor.where")} mono value={nodesText(room, data.workers, t("room.allNodes"))} />
                  <Row label={t("room.detail.merge")}
                       value={steps?.mergeSegments === false ? t("room.detail.mergeSplit") : t("room.detail.mergeOne")} />
                  <Row label={t("room.editor.versions")} value={versions} />
                </>
              ) : <Row label={t("room.detail.process")} value={t("room.detail.noRule")} />}
            </InfoGroup>

            <InfoGroup title={t("tasks.groupRuntime")}>
              <Row label={t("room.detail.lastRun")} value={s.run ? runLabel(t, s.run.state) : "-"} />
              <Row label={t("tasks.startedAt")} mono value={
                startedAt != null ? (
                  <Tooltip content={localTimeTooltip(new Date(startedAt), serverTz, (tz, local) => t("common.localTimeTooltip", { serverTz: tz, local }))}>
                    <span>{fmtStartedAt(startedAt, serverTz)}</span>
                  </Tooltip>
                ) : "-"
              } />
              <Row label={t("tasks.createdAt")} mono value={task ? fmtStartedAt(Date.parse(task.createdAt) || null, serverTz) : "-"} />
              {workers.map((w) => (
                <Row key={w.workerId} label={w.workerName} mono value={
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`dot${w.state === "recording" ? " dot-running" : ""}`}
                          style={{ background: w.state === "recording" ? "var(--success)" : w.state === "unavailable" ? "var(--error)" : "var(--muted-soft)" }} />
                    {t(w.state === "recording" ? "room.detail.nodeRecording" : w.state === "unavailable" ? "room.detail.nodeDown" : "room.detail.nodeIdle")}
                  </span>
                } />
              ))}
            </InfoGroup>

            {rolling.length > 0 && (
              <InfoGroup title={t("tasks.progressTitle")}>
                <RollingProgressRows rolling={rolling} />
              </InfoGroup>
            )}
          </div>
        </section>

        <section className="lg:col-span-2 min-w-0">
          {/* Opened logs go ABOVE the runs: the runs list is long and the panel would land below the fold. */}
          {logsOpen && taskId !== null && (
            <div className="mb-5" id="logs">
              <TaskLogPanel taskId={taskId} running={!!task?.running} />
            </div>
          )}
          <RoomRunsPanel room={room} workers={data.workers} collapsed />
        </section>
      </div>
      {actions.dialogs}
    </>
  );
}

function Cell({ label, value, icon, tone, valueClass = "telemetry-value-sm truncate" }: {
  label: string; value: string; icon: ReactNode; tone?: string; valueClass?: string;
}): ReactNode {
  return (
    <div className="telemetry-cell">
      <div className="flex flex-col gap-1.5 min-w-0">
        <span className="telemetry-label">{label}</span>
        <span className={valueClass} style={tone ? { color: tone } : undefined} title={value}>{value}</span>
      </div>
      <span className="telemetry-icon" style={tone ? { color: tone } : undefined}>{icon}</span>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: ReactNode; mono?: boolean }): ReactNode {
  return (
    <div className="flex justify-between gap-3 py-2.5 first:pt-0 last:pb-0 border-b border-hairline last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-ink text-right break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

function InfoGroup({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <div className="section-label mb-1.5">{title}</div>
      <dl className="text-sm">{children}</dl>
    </div>
  );
}
