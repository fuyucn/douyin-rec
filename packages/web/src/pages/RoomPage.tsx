/**
 * RoomPage — `/rooms/:key` detail, reordered per #553:
 *
 *   身份头（状态点+原因+图标操作组）→「当前场次」运行树（默认展开）→ 分域配置（录制/处理/投稿/
 *   通知与清理,未设置显式标注）→ 最近场次 → 日志 → 合并/维护。
 *
 * Red lines (issue #553): every action keeps its existing form — icon buttons with title, managed
 * rooms stay read-only, data flow (`useRoomsData`/`statusOf`/`roomActionsFor`) untouched. The config
 * sections render the same `RoomDTO` fields the editor edits (nothing invented): a field the editor
 * has but the old page hid is now rendered, and unset renders as「未设置」instead of disappearing.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronDown, ChevronLeft, Pencil, Play, Square } from "lucide-react";
import { api, type TaskDetail } from "../api/client";
import { useAtomValue } from "jotai";
import { serverTimezoneAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { HubStreamBanner } from "../components/HubStreamBanner";
import { TaskLogPanel } from "../components/LogTerminal";
import { MergePanel } from "../components/MergePanel";
import { RollingProgressRows, useRoomRolling } from "../components/RollingProgress";
import { RoomRunsPanel } from "../components/RoomRunsPanel";
import { Tooltip } from "../components/Tooltip";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { QUALITY_FULL, fmtClock, fmtStartedAt, platformLabel, roomHref, roomId, scheduleText } from "../lib/labels";
import { localTimeTooltip } from "../lib/tz";
import { taskOutputFormatLock } from "../lib/room-form-rules";
import { roomActionsFor, roomVisibilityFor, versionKeys } from "../lib/room-detail";
import { zeroDiskView } from "../lib/zero-disk-status";
import { LiveUploadTimeline } from "../components/LiveUploadTimeline";
import { FileText } from "lucide-react";
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
  // worker 上处理半边 / 运行历史 / 手工合并 / 直播直传时间线都不挂 —— 那些数据只在 master 有。
  const vis = roomVisibilityFor(data.caps);

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
  const taskRef = useRef(taskId);
  const live = s?.kind === "recording";
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

  return (
    <>
      <Link to="/rooms" className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors mb-5">
        <ChevronLeft className="w-4 h-4" />
        {t("room.detail.backToList")}
      </Link>

      {/* ── 身份头:状态点+原因 + 图标操作组(#553;操作形态与列表页一致,受管=只读) ── */}
      <div className="flex flex-wrap items-start justify-between gap-4 mb-5">
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
        <div className="flex flex-wrap items-center gap-1.5">
          {view.startStop && rec && !enabled && (
            <IconButton title={t("tasks.titleStart")} onClick={() => actions.setEnabled(room, true)} disabled={!!task?.stopping}>
              <Play className="w-4 h-4" style={{ color: "var(--success-fg)" }} fill="currentColor" />
            </IconButton>
          )}
          {view.startStop && rec && enabled && (
            <IconButton title={t("tasks.titleStop")} onClick={() => actions.setEnabled(room, false)}>
              <Square className="w-4 h-4" style={{ color: "var(--warning-fg)" }} fill="currentColor" />
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

      {/* ── 状态速览行:一行安静数据(#553 取代 4 格 telemetry 仪表卡) ── */}
      <div className="room-facts mb-5">
        <span className="room-fact"><span className="room-fact-label">{t("room.detail.recorded")}</span><b className={elapsed != null ? "tabular-nums" : ""} style={elapsed != null ? { color: "var(--success-fg)" } : undefined}>{elapsed != null ? fmtClock(elapsed) : live && recNodes > 0 ? t("room.detail.remoteRecording") : "-"}</b></span>
        <span className="room-fact"><span className="room-fact-label">{t("tasks.nodesBound")}</span><b>{vis.nodes ? (workers.length ? `${recNodes}/${workers.length}` : nodesText(room, data.workers, t("room.allNodes"))) : t("room.detail.local")}</b></span>
        <span className="room-fact"><span className="room-fact-label">{t("room.detail.deliver")}</span><b>{vis.processing ? delivery : "-"}</b></span>
        <span className="room-fact"><span className="room-fact-label">{t("tasks.schedule")}</span><b>{rec ? sched ?? t("room.allDay") : "-"}</b></span>
      </div>

      {/* ── 当前场次:运行树默认展开(#553 核心) ── */}
      {vis.runs && (
        <section className="mb-6">
          <RoomRunsPanel room={room} workers={data.workers} task={task} rolling={rolling} readOnly={view.readOnly} />
        </section>
      )}

      {/* ── 分域配置:录制 / 处理 / 投稿 / 通知与清理(#553;字段全集来自 formFromRoom 投影) ── */}
      <section className="cfg-domains mb-6">
        <ConfigDomain id="record" title={t("room.cfg.record")} editHint={t("room.cfg.editRecord")} managed={managed} onEdit={view.edit ? () => actions.edit(room) : undefined}>
          {rec ? (
            <>
              <Cfg label={t("tasks.room")} value={roomId(room.room)} href={roomHref(room.room)} mono />
              <Cfg label={t("tasks.anchor")} value={rec.anchorName ?? UNSET} />
              <Cfg label={t("tasks.savedName")} value={rec.name ?? UNSET} />
              <Cfg label={t("tasks.platform")} value={platformLabel(room.platform)} mono />
              <Cfg label={t("tasks.quality")} value={QUALITY_FULL[rec.quality] ?? rec.quality} />
              <Cfg label={t("tasks.recorder")} value={rec.engine} mono />
              <Cfg label={t("tasks.danmu")} value={rec.danmu ? t("common.yes") : t("common.no")} />
              <Cfg label={t("tasks.giftCookie")} value={rec.useCookie ? t("common.yes") : t("common.no")} />
              <Cfg label={t("tasks.segmentSec")} value={rec.segmentSec > 0 ? t("tasks.segmentUnit", { s: String(rec.segmentSec) }) : t("tasks.noSegment")} mono />
              <Cfg label={t("rooms.outputFormat")} value={rec.outputFormat === "original" ? t("rooms.outputFormatOriginal") : rec.outputFormat.toUpperCase()} mono
                   note={(() => { if (!rec.outputFormatLock) return undefined; const k = taskOutputFormatLock({ outputFormatLock: rec.outputFormatLock }).reasonKey; return k ? t(k) : undefined; })()} />
              <Cfg label={t("tasks.outDir")} value={rec.outDir ?? UNSET} mono />
              <Cfg label={t("tasks.schedule")} value={sched ?? t("room.allDay")} mono />
            </>
          ) : <Cfg label={t("tasks.room")} value={t("room.noTask")} unset />}
        </ConfigDomain>

        <ConfigDomain id="process" title={t("room.cfg.process")} editHint={t("room.cfg.editProcess")} managed={managed} onEdit={vis.processing && view.edit ? () => actions.edit(room) : undefined}>
          {!vis.processing ? (
            <Cfg label={t("room.detail.process")} value={t("room.detail.nodeOnlyRecording")} />
          ) : proc ? (
            <>
              <Cfg label={t("room.detail.process")} value={proc.enabled ? t("room.detail.procOn") : t("room.pausedRule")} />
              <Cfg label={t("room.detail.merge")}
                   value={proc.pipeline.steps?.mergeSegments === false ? t("room.detail.mergeSplit") : t("room.detail.mergeOne")} />
              <Cfg label={t("room.cfg.burnDanmu")} value={proc.pipeline.steps?.burnDanmu === false ? t("common.no") : t("common.yes")} />
              <Cfg label={t("room.cfg.burnLivechat")} value={proc.pipeline.steps?.burnLivechat === false ? t("common.no") : t("common.yes")} />
              <Cfg label={t("room.cfg.tsDirect")} value={proc.pipeline.steps?.tsDirect === true ? t("common.yes") : t("common.no")} />
              <Cfg label={t("room.editor.where")} value={nodesText(room, data.workers, t("room.allNodes"))} mono />
              <Cfg label={t("room.editor.versions")} value={versions || UNSET} />
              {(proc.requires?.length ?? 0) > 0 && <Cfg label={t("room.editor.caps")} value={proc.requires!.join(" · ")} mono />}
            </>
          ) : <Cfg label={t("room.detail.process")} value={t("room.detail.noRule")} />}
        </ConfigDomain>

        {vis.processing && up ? (
          <ConfigDomain id="upload" title={t("room.cfg.upload")} editHint={t("room.cfg.editUpload")} managed={managed} onEdit={view.edit ? () => actions.edit(room) : undefined}>
            <Cfg label={t("room.uploadMode")} value={delivery} />
            <Cfg label={t("room.privateShort")} value={up.private === false ? t("room.publicShort") : t("room.privateShort")} />
            <Cfg label="tid" value={up.tid != null ? String(up.tid) : UNSET} mono />
            <Cfg label={t("room.editor.tag")} value={up.tag || UNSET} />
            <Cfg label={t("room.editor.desc")} value={up.desc || UNSET} />
            <Cfg label={t("room.editor.titleTemplate")} value={up.titleTemplate || t("room.cfg.titleDefault")} mono />
            <Cfg label={t("room.editor.submissionTitle")} value={up.submissionTitleTemplate || t("room.cfg.submissionDefault")} mono />
            <Cfg label={t("room.editor.partTitle")} value={up.partTitleTemplate || t("room.cfg.partTitleDefault")} mono />
            <Cfg label={t("hub.ruleDialog.seasonSectionIdLabel")} value={up.seasonSectionId != null ? String(up.seasonSectionId) : UNSET}
                 note={up.seasonSectionId == null ? t("room.cfg.seasonOff") : undefined} mono />
            <Cfg label={t("room.editor.partSize")} value={up.partSizeMiB != null ? String(up.partSizeMiB) : UNSET}
                 note={up.partSizeMiB == null ? t("room.cfg.partSizeDefault") : undefined} mono />
          </ConfigDomain>
        ) : null}

        <ConfigDomain id="notify" title={t("room.cfg.notify")} editHint={t("room.cfg.editNotify")} managed={managed} onEdit={view.edit ? () => actions.edit(room) : undefined}>
          <Cfg label={t("dialog.webhook")} value={rec?.hasWebhook === true ? t("room.cfg.stored") : UNSET} />
          {/* 清理开关属于规则半边:没有 pipeline 时「!== false 默认保留」口径不成立,不渲染(#556 review P2) */}
          {proc && (
            <Cfg label={t("room.cfg.cleanupRow")} value={[
              proc.pipeline.cleanup?.stageSourceAfterMerge === true ? t("room.cfg.clStage") : null,
              proc.pipeline.cleanup?.sourceAfterDone === true ? t("room.cfg.clSource") : null,
              proc.pipeline.cleanup?.stageAfterDone !== false ? t("room.cfg.clArchive") : null,
            ].filter(Boolean).join(" · ") || UNSET} />
          )}
          {rec && <Cfg label={t("tasks.createdAt")} value={task ? fmtStartedAt(Date.parse(task.createdAt) || null, serverTz) : UNSET} mono />}
        </ConfigDomain>
      </section>

      {/* ── 运行态字段(零落盘/节点状态)保留原信息组语义,并入配置区尾部 ── */}
      {(task?.zeroDisk?.length || workers.length) ? (
        <section className="cfg-domains mb-6">
          <ConfigDomain id="runtime" title={t("tasks.groupRuntime")} managed={managed}>
            {(task?.zeroDisk ?? []).map((z) => {
              const v = zeroDiskView(z);
              const tone = v.tone === "ok" ? "var(--success)" : v.tone === "error" ? "var(--error)" : v.tone === "warn" ? "var(--warning-fg)" : "var(--muted-soft)";
              return (
                <Cfg key={`zd-${z.workerId}`} label={`${t("room.zeroDisk.title")} · ${z.workerName}`} value={
                  <span className="inline-flex items-center gap-1.5" title={v.detail}>
                    <span className="dot" style={{ background: tone }} />
                    {t(v.key, v.vars)}
                  </span>
                } />
              );
            })}
            {workers.map((w) => (
              <Cfg key={w.workerId} label={w.workerName} value={
                <span className="inline-flex items-center gap-1.5">
                  <span className={`dot${w.state === "recording" ? " dot-running" : ""}`}
                        style={{ background: w.state === "recording" ? "var(--success)" : w.state === "unavailable" ? "var(--error)" : "var(--muted-soft)" }} />
                  {t(w.state === "recording" ? "room.detail.nodeRecording" : w.state === "unavailable" ? "room.detail.nodeDown" : "room.detail.nodeIdle")}
                </span>
              } mono />
            ))}
            <Cfg label={t("tasks.startedAt")} value={
              startedAt != null ? (
                <Tooltip content={localTimeTooltip(new Date(startedAt), serverTz, (tz, local) => t("common.localTimeTooltip", { serverTz: tz, local }))}>
                  <span>{fmtStartedAt(startedAt, serverTz)}</span>
                </Tooltip>
              ) : "-"
            } mono />
          </ConfigDomain>
        </section>
      ) : null}

      {/* ── 日志 + 边录边传/直传进度(原位保留,#553 不动其数据流) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-6">
        {taskId !== null && (
          <div id="logs" className="min-w-0">
            <TaskLogPanel taskId={taskId} running={!!task?.running} open={logsOpen} onToggle={toggleLogs} />
          </div>
        )}
        {vis.liveUpload && task?.streamUpload && task.zeroDisk?.length ? (
          <div className="min-w-0">
            <DomainCard title={t("room.zeroDisk.live.title")}>
              <LiveUploadTimeline
                taskId={task.id}
                summaries={task.zeroDisk.flatMap((z) => z.live ? [{ workerId: z.workerId, summary: z.live }] : [])}
              />
            </DomainCard>
          </div>
        ) : null}
        {vis.processing && rolling.length > 0 && (
          <div className="min-w-0">
            <DomainCard title={t("tasks.progressTitle")}>
              <RollingProgressRows rolling={rolling} />
            </DomainCard>
          </div>
        )}
      </div>

      {vis.mergePanel && view.edit && taskId !== null && <div className="mt-6"><MergePanel taskId={taskId} /></div>}
      {actions.dialogs}
    </>
  );
}

const UNSET = "-";

/** One config domain: foldable card with a per-domain edit icon (→ the editor step; a hint, not a deep link). */
function ConfigDomain({ id, title, children, editHint, managed, onEdit }: {
  id: string;
  title: string;
  children: ReactNode;
  editHint?: string;
  managed: boolean;
  onEdit?: () => void;
}): ReactNode {
  const t = useT();
  // 非受控 details(reviewer P3):open 交给 DOM,onToggle 只驱动 CSS 箭头,不做双向同步。
  return (
    <details className="cfg-domain" data-domain={id} open>
      <summary className="cfg-domain-head">
        <span className="cfg-domain-title">{title}</span>
        <span className="cfg-domain-spacer" />
        {!managed && onEdit && (
          <IconButton
            title={editHint ?? t("room.cfg.editHint")}
            aria-label={editHint ?? t("room.cfg.editHint")}
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onEdit(); }}
          >
            <Pencil className="w-4 h-4" />
          </IconButton>
        )}
        <ChevronDown className="w-4 h-4 cfg-domain-chev" />
      </summary>
      <dl className="cfg-domain-body">{children}</dl>
    </details>
  );
}

/** A label/value pair; unset renders explicitly instead of disappearing. */
function Cfg({ label, value, mono, href, note, unset }: {
  label: string;
  value: ReactNode;
  mono?: boolean;
  href?: string;
  note?: string;
  unset?: boolean;
}): ReactNode {
  const body = href
    ? <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-ink hover:underline">{value}</a>
    : <span className={unset ? "text-muted-soft" : ""}>{value}</span>;
  return (
    <div className="cfg-row">
      <dt className="cfg-label">{label}</dt>
      <dd className={`cfg-value ${mono ? "font-mono" : ""} ${unset ? "cfg-unset" : ""}`}>
        {body}
        {note && <span className="cfg-note">{note}</span>}
      </dd>
    </div>
  );
}

/** Card shell shared by the live-upload timeline and rolling progress blocks. */
function DomainCard({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div className="card p-4">
      <div className="section-label mb-2">{title}</div>
      {children}
    </div>
  );
}
