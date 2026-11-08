/**
 * RoomPage — `/rooms/:key` detail, v2 layout per #557 (prototype: dev/room-detail-v2-proto.html).
 *
 * 页面优先级原则:正在录的房间,**进度 + 日志是高频,配置是低频**。
 *   身份头 → 状态速览行 →「正在录制」区(边录边传分段进度,首屏动态时刻)
 *   →「当前场次」区(运行树默认展开 + 日志面板默认展开) → 配置四域(默认收起+摘要+常用/更多)
 *   → 运行态域 → 最近场次/合并面板。
 *
 * Red lines (issue #553/#557): every action keeps its existing form — icon buttons with title, managed
 * rooms stay read-only, data flow (`useRoomsData`/`statusOf`/`roomActionsFor`/`useRoomRolling`) untouched.
 * Config fields render the same `RoomDTO` fields the editor edits (nothing invented); unset renders
 * as「-」instead of disappearing. The 52-field full set lives in `lib/room-detail-v2.ts`.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronLeft, FileText, Pencil, Play, Square } from "lucide-react";
import { api, type TaskDetail } from "../api/client";
import { useAtomValue } from "jotai";
import { serverTimezoneAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { TaskLogPanel } from "../components/LogTerminal";
import { MergePanel } from "../components/MergePanel";
import { useRoomRolling } from "../components/RollingProgress";
import { RoomRunsPanel } from "../components/RoomRunsPanel";
import { Tooltip } from "../components/Tooltip";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { fmtClock, fmtStartedAt, qualityLabel, scheduleText } from "../lib/labels";
import { localTimeTooltip } from "../lib/tz";
import { taskOutputFormatLock } from "../lib/room-form-rules";
import { configDomains, domainGroups, domainSummary, type DomainDef } from "../lib/room-detail-v2";
import { roomActionsFor, roomVisibilityFor, versionKeys } from "../lib/room-detail";
import { startStopVisual } from "../lib/room-status";
import { zeroDiskView } from "../lib/zero-disk-status";
import { LiveUploadTimeline } from "../components/LiveUploadTimeline";
import { deliverText, nodesText, roomName, RoomBadge, statusDetail, useRoomActions, useRoomsData } from "./rooms/shared";

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
  // 角色裁剪:能力矩阵是唯一真理(`roomVisibilityFor` / `roomActionsFor`),这里只消费结果。
  const vis = roomVisibilityFor(data.caps);

  // Logs live on this page. The list's log icon arrives with ?logs=1; a recording room gets the
  // console open by default (#557: logs are high-frequency while recording).
  const [params, setParams] = useSearchParams();
  const live = s?.kind === "recording";
  const [logsOpen, setLogsOpen] = useState(params.get("logs") === "1");
  // Switching rooms must not carry the open/closed state over; a recording room reopens it.
  useEffect(() => {
    setLogsOpen(params.get("logs") === "1" || live);
  }, [key, live, params]); // eslint-disable-line react-hooks/exhaustive-deps
  const toggleLogs = (): void => {
    const next = !logsOpen;
    setLogsOpen(next);
    if (params.get("logs")) setParams(next ? { logs: "1" } : {}, { replace: true });
  };

  // Below the `lg` breakpoint the page is one column. Bring the opened console into view when it
  // opens via the list's ?logs=1 arrival (not for the default-open of a recording room — that would
  // yank the user past the progress section).
  const logsMounted = logsOpen && !!room && taskId !== null;
  useEffect(() => {
    if (!logsMounted || !window.matchMedia("(max-width: 1023px)").matches) return;
    if (params.get("logs") !== "1") return;
    document.getElementById("logs")?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [logsMounted, key]); // eslint-disable-line react-hooks/exhaustive-deps

  // Elapsed time only exists for a local recorder process (runtime); remote-only → "—".
  const [detail, setDetail] = useState<TaskDetail | null>(null);
  const taskRef = useRef(taskId);
  usePolling(() => {
    if (taskId === null || !live) return;
    const id = taskId;
    // Drop a reply for a room we already left (the page stays mounted across room navigation).
    void api.getTask(id).then((d) => { if (taskRef.current === id) setDetail(d); }).catch(() => {});
  }, 5_000, live);
  useEffect(() => { if (!live) setDetail(null); }, [live]);
  useEffect(() => { taskRef.current = taskId; setDetail(null); }, [taskId]);
  // 边录边传进度取自 `/api/hub/queue`(master 端点):worker 上传 null 关掉轮询,连请求都不发。
  const rolling = useRoomRolling(vis.processing && room ? room.roomSlug : null);
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
  // 与列表页同一判定(`startStopVisual`):颜色只说明「正在录」,enabled 只说按钮将做什么。
  const mark = startStopVisual(enabled, s.kind);
  const managed = actions.managedOf(room);
  // 受管(`managedBy === "hub"`)= 只读:与角色无关,master 上的受管房间同样没有写操作(plan §3.3)。
  const view = roomActionsFor({ managed, caps: data.caps });
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
  const versions = versionKeys(room).map((k) => t(k)).join(" + ");
  const lockReason = rec?.outputFormatLock
    ? (() => { const k = taskOutputFormatLock({ outputFormatLock: rec.outputFormatLock }).reasonKey; return k ? t(k) : undefined; })()
    : undefined;
  const createdAt = task ? fmtStartedAt(Date.parse(task.createdAt) || null, serverTz) : null;
  const cleanupSummary = proc
    ? [
      proc.pipeline.cleanup?.stageSourceAfterMerge === true ? t("room.cfg.clStage") : null,
      proc.pipeline.cleanup?.sourceAfterDone === true ? t("room.cfg.clSource") : null,
      proc.pipeline.cleanup?.stageAfterDone !== false ? t("room.cfg.clArchive") : null,
    ].filter(Boolean).join(" · ") || t("room.cfg.cleanupDefault")
    : "";
  const domains = configDomains({
    room,
    tr: t,
    words: {
      yes: t("common.yes"), no: t("common.no"), unsetMark: "-",
      stored: t("room.cfg.stored"), paused: t("room.pausedRule"),
      merged: t("roomForm.mergeOne"), perSegment: t("roomForm.mergeSplit"),
      seasonNote: t("room.cfg.f.seasonNote"), partSizeNote: t("room.cfg.f.partSizeNote"),
      templateNote: t("room.cfg.f.templateNote"), descNote: t("room.cfg.f.descNote"),
      webhookStoredNote: t("room.cfg.f.webhookStoredNote"), webhookUnsetNote: t("room.cfg.f.webhookUnsetNote"),
      cleanupNote: t("room.cfg.f.cleanupNote"), anchorNote: t("room.cfg.f.anchorNote"),
      loginNote: t("room.cfg.f.loginNote"), outDirNote: t("room.cfg.f.outDirNote"),
      procPausedNote: t("room.cfg.f.procPausedNote"),
      engineValue: (engine) => engine,
    },
    qualityFull: qualityLabel,
    segmentUnit: (sec) => t("tasks.segmentUnit", { s: String(sec) }),
    noSegment: t("tasks.noSegment"),
    fmtOriginal: t("rooms.outputFormatOriginal"),
    schedule: sched ?? t("room.allDay"),
    lockReason,
    versions: versions || t("room.detail.noRule"),
    where: nodesText(room, data.workers, t("room.allNodes")),
    delivery,
    privateLabel: up?.private === false ? t("room.publicShort") : t("room.privateShort"),
    cleanupSummary,
    createdAt,
  });

  return (
    <>
      <Link to="/rooms" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors mb-5">
        <ChevronLeft className="w-4 h-4" />
        {t("room.detail.backToList")}
      </Link>

      {/* ── 身份头:状态点+原因 + 图标操作组(#553 形态保留;受管=只读) ── */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="headline page-h1 break-all">{roomName(room)}</h1>
            <RoomBadge s={s} />
            {managed && <span className="badge badge-muted" title={t("tasks.managedHint")}>{t("tasks.managed")}</span>}
          </div>
          {s.kind === "attention" && (
            <p className="text-sm mt-1.5" style={{ color: "var(--warning-fg)" }}>{statusDetail(t, room, s)}</p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {view.startStop && rec && !enabled && (
            <IconButton title={t("tasks.titleStart")} data-state={mark.state} onClick={() => actions.setEnabled(room, true)} disabled={!!task?.stopping}>
              <Play className="w-4 h-4" style={{ color: mark.tone ?? "var(--success-fg)" }} fill="none" />
            </IconButton>
          )}
          {view.startStop && rec && enabled && (
            <IconButton title={t("tasks.titleStop")} data-state={mark.state} onClick={() => actions.setEnabled(room, false)}>
              <Square className="w-4 h-4" style={mark.tone ? { color: mark.tone } : undefined} fill={mark.filled ? "currentColor" : "none"} />
            </IconButton>
          )}
          {view.drain && rec && enabled && live && (
            <Button small variant="secondary" onClick={() => actions.drain(room)}>{t("room.detail.drain")}</Button>
          )}
          {taskId !== null && (
            <Link className="btn-icon" to={`/rooms/${encodeURIComponent(room.key)}?logs=1`} title={t("room.detail.logs")}><FileText className="w-4 h-4" /></Link>
          )}
          {view.edit && <IconButton title={t("room.detail.edit")} onClick={() => actions.edit(room)}><Pencil className="w-4 h-4" /></IconButton>}
        </div>
      </div>

      <HubStreamBanner handle={data.stream} />

      {/* ── 状态速览行:一行安静数据(#553) ── */}
      <div className="room-facts mb-5">
        <span className="room-fact"><span className="room-fact-label">{t("room.detail.recorded")}</span><b className={elapsed != null ? "tabular-nums" : ""} style={elapsed != null ? { color: "var(--success-fg)" } : undefined}>{elapsed != null ? fmtClock(elapsed) : live && recNodes > 0 ? t("room.detail.remoteRecording") : "-"}</b></span>
        <span className="room-fact"><span className="room-fact-label">{t("tasks.nodesBound")}</span><b>{vis.nodes ? (workers.length ? `${recNodes}/${workers.length}` : nodesText(room, data.workers, t("room.allNodes"))) : t("room.detail.local")}</b></span>
        <span className="room-fact"><span className="room-fact-label">{t("room.detail.deliver")}</span><b>{vis.processing ? delivery : "-"}</b></span>
        <span className="room-fact"><span className="room-fact-label">{t("tasks.schedule")}</span><b>{rec ? sched ?? t("room.allDay") : "-"}</b></span>
      </div>

      {/* ── 「当前场次」区:运行树(默认展开,含边录边传/直传的实时进度树)+ 日志(默认展开,正在录时) ──
          注:不另设「正在录制」独立区——CurrentRunTree 已用同一份 rolling/直传快照渲染实时进度树,
          再画一遍是重复(#557 用户反馈)。动态内容都在 Processing runs 面板顶部。 ── */}
      <section className="mb-6">
        {vis.runs && <RoomRunsPanel room={room} workers={data.workers} task={task} rolling={rolling} readOnly={view.readOnly} />}
        {/* worker 上没有 runs 面板(vis.runs=false),直传时间线在这里兜底展示 */}
        {!vis.runs && vis.liveUpload && task?.streamUpload && task.zeroDisk?.length && (
          <div className="mt-4">
            <LiveUploadTimeline
              taskId={task.id}
              summaries={task.zeroDisk.flatMap((z) => z.live ? [{ workerId: z.workerId, summary: z.live }] : [])}
            />
          </div>
        )}
        {taskId !== null && (
          <div className="mt-4" id="logs">
            <TaskLogPanel taskId={taskId} running={!!task?.running} open={logsOpen} onToggle={toggleLogs} />
          </div>
        )}
      </section>

      {/* ── 配置四域:低频,默认收起 + 一句话摘要 + 常用/更多两层(#557) ── */}
      <section className="cfg-domains mb-6" aria-label={t("room.detail.info")}>
        {domains.map((d) => (
          <ConfigDomain key={d.id} domain={d} managed={managed} onEdit={view.edit ? () => actions.edit(room) : undefined} />
        ))}
      </section>

      {/* ── 运行态域(零落盘/节点状态/开播时间):低频,并入配置区尾部 ── */}
      {(task?.zeroDisk?.length || workers.length) ? (
        <section className="cfg-domains mb-6">
          <details className="cfg-domain" data-domain="runtime">
            <summary className="cfg-summary">
              <span className="cfg-title">{t("tasks.groupRuntime")}</span>
              <span className="cfg-abstract">{vis.nodes ? (workers.length ? `${recNodes}/${workers.length} ${t("room.detail.nodeRecording")}` : nodesText(room, data.workers, t("room.allNodes"))) : t("room.detail.local")}</span>
              <span className="cfg-domain-spacer" />
              <ChevronDown className="w-4 h-4 cfg-domain-chev" />
            </summary>
            <dl className="cfg-domain-body cfg-single">
              {(task?.zeroDisk ?? []).map((z) => {
                const v = zeroDiskView(z);
                const tone = v.tone === "ok" ? "var(--success)" : v.tone === "error" ? "var(--error)" : v.tone === "warn" ? "var(--warning-fg)" : "var(--muted-soft)";
                return (
                  <Field key={`zd-${z.workerId}`} label={`${t("room.zeroDisk.title")} · ${z.workerName}`} value={
                    <span className="inline-flex items-center gap-1.5" title={v.detail}>
                      <span className="dot" style={{ background: tone }} />
                      {t(v.key, v.vars)}
                    </span>
                  } />
                );
              })}
              {workers.map((w) => (
                <Field key={w.workerId} label={w.workerName} value={
                  <span className="inline-flex items-center gap-1.5">
                    <span className={`dot${w.state === "recording" ? " dot-running" : ""}`}
                          style={{ background: w.state === "recording" ? "var(--success)" : w.state === "unavailable" ? "var(--error)" : "var(--muted-soft)" }} />
                    {t(w.state === "recording" ? "room.detail.nodeRecording" : w.state === "unavailable" ? "room.detail.nodeDown" : "room.detail.nodeIdle")}
                  </span>
                } mono />
              ))}
              <Field label={t("tasks.startedAt")} value={
                startedAt != null ? (
                  <Tooltip content={localTimeTooltip(new Date(startedAt), serverTz, (tz, local) => t("common.localTimeTooltip", { serverTz: tz, local }))}>
                    <span>{fmtStartedAt(startedAt, serverTz)}</span>
                  </Tooltip>
                ) : "-"
              } mono />
            </dl>
          </details>
        </section>
      ) : null}

      {vis.mergePanel && view.edit && taskId !== null && <div className="mt-6"><MergePanel taskId={taskId} /></div>}
      {actions.dialogs}
    </>
  );
}

/** One config domain: default-collapsed details with a one-line abstract (#557, config-proto 方案). */
function ConfigDomain({ domain, managed, onEdit }: {
  domain: DomainDef;
  managed: boolean;
  onEdit?: () => void;
}): ReactNode {
  const t = useT();
  const summary = domainSummary(domain);
  const { primary, more } = domainGroups(domain);
  return (
    <details className="cfg-domain" data-domain={domain.id}>
      <summary className="cfg-summary">
        <span className="cfg-title">{t(domain.titleKey)}</span>
        <span className="cfg-abstract">{summary ?? t("room.cfg.summaryEmpty")}</span>
        <span className="cfg-count">{t("room.cfg.fieldCount", { n: domain.fields.length })}</span>
        <span className="cfg-domain-spacer" />
        {!managed && onEdit && (
          <IconButton
            title={t("room.cfg.editHint")}
            aria-label={t("room.cfg.editHint")}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
          >
            <Pencil className="w-4 h-4" />
          </IconButton>
        )}
        <ChevronDown className="w-4 h-4 cfg-domain-chev" />
      </summary>
      <div className="cfg-body">
        <dl className="field-grid">
          {primary.map((x) => <Field key={x.key} label={x.label} value={x.value} mono={x.mono} unset={x.unset} note={x.note} />)}
        </dl>
        {more.length > 0 && (
          <details className="more">
            <summary className="more-sum">
              {t("room.cfg.moreGroup")}
              <span className="m-count">{t("room.cfg.fieldCount", { n: more.length })}</span>
              <span className="chev" />
            </summary>
            <dl className="field-grid more-body-grid">
              {more.map((x) => <Field key={x.key} label={x.label} value={x.value} mono={x.mono} unset={x.unset} note={x.note} />)}
            </dl>
          </details>
        )}
      </div>
    </details>
  );
}

/** A label/value pair; unset renders explicitly in muted tone instead of disappearing. */
function Field({ label, value, mono, note, unset }: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  note?: string;
  unset?: boolean;
}): ReactNode {
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <dd className={`field-value ${mono ? "font-mono" : ""} ${unset ? "unset" : ""}`}>{value}</dd>
      {note && <span className="field-note">{note}</span>}
    </div>
  );
}
