import { CalendarRange, ChevronLeft, Clock3, ExternalLink, MonitorPlay, Terminal, UploadCloud } from "lucide-react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type RollingDeliveryDTO, type Task, type TaskDetail as TaskDetailModel } from "../api/client";
import { serverTimezoneAtom } from "../atoms";
import { DanmuBadge, StatusBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { Tooltip } from "../components/Tooltip";
import { errMessage, usePolling, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { classifyLogLine, LOG_LINE_STYLE } from "../lib/logLevel";
import { QUALITY_FULL, fmtClock, fmtStartedAt, platformLabel, roomHref, roomId, scheduleText } from "../lib/labels";
import { localScheduleTooltip, localTimeTooltip } from "../lib/tz";
import { fmtBytes } from "../lib/nodes-summary";
import { CreateEditTaskDialog } from "../modals/CreateEditTaskDialog";
import { MergePanel } from "../components/MergePanel";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** Detail page (#/task/:id): info card + live logs console, 2s polling. */
export function TaskDetail(): ReactNode {
  const t = useT();
  const serverTz = useAtomValue(serverTimezoneAtom);
  const { id } = useParams();
  const taskId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const [task, setTask] = useState<TaskDetailModel | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  /** 该房间的边录边传实时进度(master 队列快照里按房间筛;非 master / 无会话 → 空)。 */
  const [rolling, setRolling] = useState<RollingDeliveryDTO[]>([]);

  const preRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(true);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const [tk, l] = await Promise.all([api.getTask(taskId), api.getTaskLogs(taskId)]);
      setTask(tk);
      setLogs(l.lines ?? []);
      // 边录边传进度来自 master 的队列快照(按房间过滤);节点模式/失败时静默留空,不影响主数据。
      const slug = roomId(tk.room);
      const q = await api.getHubQueue({ q: slug || undefined }).catch(() => null);
      setRolling((q?.delivering ?? []).filter((d) => !slug || d.roomSlug === slug));
    } catch {
      toast(t("tasks.unavailable"), "warning");
      navigate("/");
    }
  }, [taskId, navigate, toast, t]);

  usePolling(() => void poll(), 2000, Number.isFinite(taskId));

  // Stick to the bottom unless the user scrolled away.
  useEffect(() => {
    const pre = preRef.current;
    if (pre && autoScrollRef.current) pre.scrollTop = pre.scrollHeight;
  }, [logs]);

  const onScroll = (): void => {
    const el = preRef.current;
    if (el) autoScrollRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const action = async (kind: "start" | "stop"): Promise<void> => {
    try {
      if (kind === "start") {
        await api.startTask(taskId);
        toast(t("tasks.started", { id: taskId }), "success");
      } else {
        await api.stopTask(taskId);
        toast(t("tasks.stopped", { id: taskId }), "info");
      }
      await poll();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const doRemove = async (): Promise<void> => {
    setConfirmDel(false);
    try {
      await api.deleteTask(taskId);
      toast(t("tasks.deleted", { id: taskId }), "info");
      navigate("/");
    } catch (e) {
      toast(t("tasks.deleteFailed", { msg: errMessage(e) }), "error");
    }
  };

  // The edit dialog wants a plain Task (no runtime); fall through gracefully.
  const editTask: Task | null = task;
  const sched = task ? scheduleText(task) : null;
  // 该任务被派到哪些节点(远端受管任务才带 recordingWorkers;无 → 本机自录)。
  const nodeNames = (task?.recordingWorkers ?? []).map((w) => w.workerName);

  return (
    <>
      <Link
        to="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors mb-5"
      >
        <ChevronLeft className="w-4 h-4" />
        {t("tasks.backToList")}
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="headline text-[26px] sm:text-[30px] leading-tight break-all">
              {task ? task.name || task.anchorName || task.room : "-"}
            </h1>
            {task && (
              <>
                <StatusBadge
                  running={task.running}
                  status={task.status}
                  enabled={task.enabled}
                  recording={task.recording}
                  stopping={task.stopping}
                  recordingWorkers={task.recordingWorkers}
                />
                {task.managedBy === "hub" && (
                  <span className="badge badge-muted" title={t("tasks.managedHint")}>{t("tasks.managed")}</span>
                )}
              </>
            )}
          </div>
          <p className="font-mono text-sm text-muted mt-1.5 break-all">
            {task && (task.name || task.anchorName) ? roomId(task.room) : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {task && !task.enabled && (
            <Button
              small
              onClick={() => action("start")}
              disabled={task.managedBy === "hub" || task.stopping}
              title={task.stopping ? t("tasks.stoppingHint") : task.managedBy === "hub" ? t("tasks.managedHint") : undefined}
            >
              {t("tasks.start")}
            </Button>
          )}
          {task && task.enabled && (
            <Button
              small
              variant="secondary"
              onClick={() => action("stop")}
              disabled={task.managedBy === "hub"}
              title={task.managedBy === "hub" ? t("tasks.managedHint") : undefined}
            >
              {t("tasks.stop")}
            </Button>
          )}
          <Button
            small
            variant="secondary"
            onClick={() => setEditOpen(true)}
            disabled={!task || task.managedBy === "hub"}
            title={task?.managedBy === "hub" ? t("tasks.managedHint") : undefined}
          >
            {t("tasks.edit")}
          </Button>
          <Button
            small
            variant="danger"
            onClick={() => setConfirmDel(true)}
            disabled={!task || task.managedBy === "hub" || task.enabled || task.running}
            title={task?.managedBy === "hub" ? t("tasks.managedHint") : task && (task.enabled || task.running) ? t("tasks.stopFirst") : t("common.delete")}
          >
            {t("common.delete")}
          </Button>
        </div>
      </div>

      <div className="telemetry-bar mb-6">
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.elapsed")}</span>
            <span className="telemetry-value tabular-nums" style={{ color: task?.recording || task?.running ? "var(--success-fg)" : "var(--muted)" }}>
              {fmtClock(task?.runtime?.elapsedMs)}
            </span>
          </div>
          <span className="telemetry-icon" style={{ color: task?.recording || task?.running ? "var(--success-fg)" : undefined }}><Clock3 className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.nodesBound")}</span>
            <span className="telemetry-value-sm truncate" title={nodeNames.join(" + ")}>
              {nodeNames.length > 0 ? nodeNames.join(" + ") : t("tasks.nodesNone")}
            </span>
          </div>
          <span className="telemetry-icon"><MonitorPlay className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.rollingUpload")}</span>
            <span className="telemetry-value-sm truncate" style={{ color: task?.rollingPending ? "var(--warning-fg)" : undefined }}
              title={task?.rollingPending ? t("tasks.rollingPendingHint") : undefined}>
              {task?.rollingPending ? `⚠ ${t("tasks.rollingPending")}` : task?.rollingEffective ? t("tasks.rollingOn") : t("tasks.rollingOff")}
            </span>
          </div>
          <span className="telemetry-icon"><UploadCloud className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.schedule")}</span>
            <span className="telemetry-value-mono truncate">{sched ?? "-"}</span>
          </div>
          <span className="telemetry-icon"><CalendarRange className="w-4 h-4" /></span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="lg:col-span-1">
          <div className="flex items-center justify-between mb-4">
            <h3 className="section-label">{t("tasks.info")}</h3>
            <span className="font-mono text-[10px] text-muted-soft uppercase">#{taskId}</span>
          </div>
          <div className="card p-5 space-y-5">
            <InfoGroup title={t("tasks.groupLive")}>
              <Row
                label={t("tasks.room")}
                mono
                value={
                  task ? (
                    <a href={roomHref(task.room)} target="_blank" rel="noreferrer"
                      className="inline-flex items-center gap-1 text-ink hover:underline" title={t("tasks.openLive")}>
                      {roomId(task.room)}
                      <ExternalLink className="w-3.5 h-3.5 opacity-70" />
                    </a>
                  ) : "-"
                }
              />
              <Row label={t("tasks.anchor")} value={task?.anchorName ?? "-"} />
              <Row label={t("tasks.savedName")} value={task?.name ?? "-"} />
              <Row label={t("tasks.platform")} mono value={task ? platformLabel(task.platform) : "-"} />
            </InfoGroup>

            <InfoGroup title={t("tasks.groupRecord")}>
              <Row label={t("tasks.quality")} value={task ? QUALITY_FULL[task.quality] ?? task.quality : "-"} />
              <Row label={t("tasks.recorder")} mono value={task?.engine ?? "-"} />
              <div className="flex justify-between gap-3 py-2.5 border-b border-hairline">
                <dt className="text-muted">{t("tasks.danmu")}</dt>
                <dd className="text-right">{task ? <DanmuBadge task={task} /> : "-"}</dd>
              </div>
              <Row label={t("tasks.giftCookie")} value={task ? (task.useCookie ? t("common.yes") : t("common.no")) : "-"} />
              <Row
                label={t("tasks.segmentSec")}
                mono
                value={task ? (task.segmentSec > 0 ? t("tasks.segmentUnit", { s: String(task.segmentSec) }) : t("tasks.noSegment")) : "-"}
              />
              <Row label={t("tasks.outDir")} mono value={task?.outDir ?? "-"} />
            </InfoGroup>

            <InfoGroup title={t("tasks.groupRuntime")}>
              <Row label={t("tasks.nodesBound")} value={nodeNames.length > 0 ? nodeNames.join(" + ") : t("tasks.nodesNone")} />
              <Row
                label={t("tasks.schedule")}
                mono
                value={
                  sched && task?.scheduleStart && task?.scheduleEnd ? (
                    <Tooltip
                      content={localScheduleTooltip(task.scheduleStart, task.scheduleEnd, serverTz, (tz, local) =>
                        t("tasks.scheduleLocalTooltip", { serverTz: tz, local }),
                      )}
                    >
                      <span>{sched}</span>
                    </Tooltip>
                  ) : (
                    sched ?? "-"
                  )
                }
              />
              <Row
                label={t("tasks.startedAt")}
                mono
                value={
                  task?.runtime?.startedAt != null ? (
                    <Tooltip
                      content={localTimeTooltip(new Date(task.runtime.startedAt), serverTz, (tz, local) =>
                        t("common.localTimeTooltip", { serverTz: tz, local }),
                      )}
                    >
                      <span>{fmtStartedAt(task.runtime.startedAt, serverTz)}</span>
                    </Tooltip>
                  ) : (
                    "-"
                  )
                }
              />
              <Row label={t("tasks.elapsed")} mono value={fmtClock(task?.runtime?.elapsedMs)} />
              <Row
                label={t("tasks.createdAt")}
                mono
                value={task ? fmtStartedAt(Date.parse(task.createdAt) || null, serverTz) : "-"}
              />
            </InfoGroup>

            {task?.hubRule && (
              <InfoGroup title={t("tasks.groupPipeline")}>
                <Row
                  label={t("tasks.rollingUpload")}
                  value={
                    <Link to={`/hub/${encodeURIComponent(task.hubRule.key)}`} className="text-ink hover:underline">
                      {task.hubRule.uploadMode === "upload"
                        ? (task.rollingEffective ? t("tasks.rollingOn") : t("tasks.rollingOff"))
                        : t("tasks.stageOnly")}
                    </Link>
                  }
                />
                <Row
                  label={t("tasks.logs")}
                  value={task.hubRule.enabled
                    ? task.hubRule.steps.map((st) => stepLabel(t, st)).join(" · ")
                    : t("tasks.hubDisabled")}
                />
                <Row
                  label={t("tasks.lastRun")}
                  value={
                    task.hubRule.lastRun ? (
                      <Link to={`/hub/${encodeURIComponent(task.hubRule.key)}`} className="text-ink hover:underline">
                        {t(`hub.jobs.step.${task.hubRule.lastRun.state}`)}
                        {task.hubRule.lastRun.bv ? ` · ${task.hubRule.lastRun.bv}` : ""}
                      </Link>
                    ) : t("hub.jobs.noRunYet")
                  }
                />
                {task.rollingPending && (
                  <div className="pt-2.5 text-[11px]" style={{ color: "var(--warning-fg)" }}>
                    ⚠ {t("tasks.rollingPendingHint")}
                  </div>
                )}
              </InfoGroup>
            )}

            {rolling.length > 0 && (
              <InfoGroup title={t("tasks.progressTitle")}>
                {rolling.map((d) => (
                  <div key={d.sessionBase} className="py-2 border-b border-hairline last:border-0 last:pb-0">
                    <div className="flex items-center gap-2 text-[12px]">
                      <span className="font-mono text-muted-soft">{d.sessionBase}</span>
                      <span className="ml-auto">{t("queue.delivering.progress", { c: d.confirmed, n: d.total })}</span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-[11px] text-muted font-mono mt-0.5">
                      {d.uploading && <span>{t("queue.delivering.pending")}</span>}
                      {typeof d.lockedBytes === "number" && d.lockedBytes > 0 && <span>{fmtBytes(d.lockedBytes)}</span>}
                      {d.ambiguous > 0 && <span style={{ color: "var(--error-fg)" }}>{t("queue.delivering.unknown")} {d.ambiguous}</span>}
                      {d.bv && (
                        <a className="hover:text-ink" href={`https://www.bilibili.com/video/${d.bv}`} target="_blank" rel="noreferrer">{d.bv}</a>
                      )}
                    </div>
                  </div>
                ))}
              </InfoGroup>
            )}
          </div>
        </section>

        <section className="lg:col-span-2 flex flex-col">
          <div className="terminal">
            <div className="terminal-head">
              <span className="terminal-title">
                <span
                  className={`dot${task?.running ? " dot-running" : ""}`}
                  style={{ background: task?.running ? "var(--success)" : "var(--muted-soft)" }}
                />
                <Terminal className="w-3.5 h-3.5" />
                {t("tasks.logs")}
              </span>
              <span className="terminal-count">{logs.length ? t("tasks.lines", { count: logs.length }) : ""}</span>
            </div>
            <pre
              ref={preRef}
              onScroll={onScroll}
              className="terminal-body"
            >
              {logs.length
                ? logs.map((line, i) => (
                    <div
                      key={i}
                      style={{
                        ...LOG_LINE_STYLE[classifyLogLine(line)],
                        // 让整行(含背景)铺满,error 浅红底覆盖整行。
                        margin: "0 -14px",
                        padding: "0 14px",
                      }}
                    >
                      {line || " "}
                    </div>
                  ))
                : t("tasks.noLogs")}
            </pre>
          </div>
        </section>

        {Number.isFinite(taskId) && <MergePanel taskId={taskId} />}
      </div>

      <CreateEditTaskDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        task={editTask}
        onSaved={() => void poll()}
      />

      <ConfirmDialog
        open={confirmDel}
        title={t("tasks.deleteConfirm", { id: taskId })}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => void doRemove()}
        onCancel={() => setConfirmDel(false)}
      />
    </>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: string;
  value: ReactNode;
  mono?: boolean;
}): ReactNode {
  return (
    <div className="flex justify-between gap-3 py-2.5 first:pt-0 last:pb-0 border-b border-hairline last:border-0">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-ink text-right break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}

/** info 卡片里的分组:小标题 + 一组 dl 行(详情页字段多,分组后一眼能扫)。 */
function InfoGroup({ title, children }: { title: string; children: ReactNode }): ReactNode {
  return (
    <div>
      <div className="section-label mb-1.5">{title}</div>
      <dl className="text-sm">{children}</dl>
    </div>
  );
}

/** 步骤名 → 标签(与 hub 页同源 i18n key;未知步骤回落原文)。 */
function stepLabel(t: (key: string, vars?: Record<string, string | number>) => string, step: string): string {
  const key = `hub.jobs.stepNode.${step}`;
  const label = t(key);
  return label === key ? step : label;
}
