import { ChevronLeft, ExternalLink } from "lucide-react";
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type Task, type TaskDetail as TaskDetailModel } from "../api/client";
import { serverTimezoneAtom } from "../atoms";
import { DanmuBadge, StatusBadge } from "../components/Badge";
import { Button } from "../components/Button";
import { Tooltip } from "../components/Tooltip";
import { errMessage, usePolling, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { classifyLogLine, LOG_LINE_STYLE } from "../lib/logLevel";
import { QUALITY_FULL, fmtClock, fmtStartedAt, roomHref, roomId, scheduleText } from "../lib/labels";
import { localScheduleTooltip, localTimeTooltip } from "../lib/tz";
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

  const preRef = useRef<HTMLPreElement>(null);
  const autoScrollRef = useRef(true);

  const poll = useCallback(async (): Promise<void> => {
    try {
      const [tk, l] = await Promise.all([api.getTask(taskId), api.getTaskLogs(taskId)]);
      setTask(tk);
      setLogs(l.lines ?? []);
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
            <h1 className="headline text-[28px] sm:text-[32px] leading-tight break-all">
              {task ? task.name || task.anchorName || task.room : "—"}
            </h1>
            {task && <StatusBadge running={task.running} status={task.status} enabled={task.enabled} recording={task.recording} />}
          </div>
          <p className="font-mono text-sm text-muted mt-1.5 break-all">
            {task && (task.name || task.anchorName) ? roomId(task.room) : ""}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {task && !task.enabled && (
            <Button small onClick={() => action("start")}>
              {t("tasks.start")}
            </Button>
          )}
          {task && task.enabled && (
            <Button small variant="secondary" onClick={() => action("stop")}>
              {t("tasks.stop")}
            </Button>
          )}
          <Button small variant="secondary" onClick={() => setEditOpen(true)} disabled={!task}>
            {t("tasks.edit")}
          </Button>
          <Button
            small
            variant="secondary"
            style={{ color: "var(--error)" }}
            onClick={() => setConfirmDel(true)}
            disabled={!task || task.enabled || task.running}
            title={task && (task.enabled || task.running) ? t("tasks.stopFirst") : t("common.delete")}
          >
            {t("common.delete")}
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <section className="card p-6 lg:col-span-1">
          <h3 className="headline text-[16px] mb-4">{t("tasks.info")}</h3>
          <dl className="space-y-3 text-sm">
            <Row
              label={t("tasks.room")}
              mono
              value={
                task ? (
                  <a
                    href={roomHref(task.room)}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-ink hover:underline"
                    title={t("tasks.openLive")}
                  >
                    {roomId(task.room)}
                    <ExternalLink className="w-3.5 h-3.5 opacity-70" />
                  </a>
                ) : (
                  "—"
                )
              }
            />
            <Row label={t("tasks.anchor")} value={task?.anchorName ?? "—"} />
            <Row label={t("tasks.quality")} value={task ? QUALITY_FULL[task.quality] ?? task.quality : "—"} />
            <Row label={t("tasks.recorder")} mono value={task?.engine ?? "—"} />
            <div className="flex justify-between gap-3">
              <dt className="text-muted">{t("tasks.danmu")}</dt>
              <dd className="text-right">{task ? <DanmuBadge task={task} /> : "—"}</dd>
            </div>
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
                  sched ?? "—"
                )
              }
            />
            <Row label={t("tasks.giftCookie")} value={task ? (task.useCookie ? t("common.yes") : t("common.no")) : "—"} />
            <Row label={t("tasks.outDir")} mono value={task?.outDir ?? "—"} />
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
                  "—"
                )
              }
            />
            <Row label={t("tasks.elapsed")} mono value={fmtClock(task?.runtime?.elapsedMs)} />
          </dl>
        </section>

        <section className="card p-6 lg:col-span-2 flex flex-col">
          <div className="flex items-center justify-between mb-3">
            <h3 className="headline text-[16px]">{t("tasks.logs")}</h3>
            <span className="text-xs text-muted-soft">{logs.length ? t("tasks.lines", { count: logs.length }) : ""}</span>
          </div>
          <pre
            ref={preRef}
            onScroll={onScroll}
            className="text-[12.5px] leading-relaxed rounded p-4 overflow-auto"
            style={{
              background: "var(--surface-soft)",
              border: "1px solid var(--hairline)",
              height: "360px",
              whiteSpace: "pre-wrap",
              fontFamily: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
              color: "var(--body)",
            }}
          >
            {logs.length
              ? logs.map((line, i) => (
                  <div
                    key={i}
                    style={{
                      ...LOG_LINE_STYLE[classifyLogLine(line)],
                      // 让整行(含背景)铺满,error 浅红底覆盖整行。
                      margin: "0 -16px",
                      padding: "0 16px",
                    }}
                  >
                    {line || " "}
                  </div>
                ))
              : t("tasks.noLogs")}
          </pre>
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
    <div className="flex justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className={`text-ink text-right break-all ${mono ? "font-mono" : ""}`}>{value}</dd>
    </div>
  );
}
