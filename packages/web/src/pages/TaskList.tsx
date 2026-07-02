import { useAtom, useAtomValue } from "jotai";
import { FileText, FolderOpen, Pencil, Play, Plus, Square, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Task } from "../api/client";
import { connAtom, serverTimezoneAtom, tasksAtom } from "../atoms";
import { DanmuBadge, StatusBadge } from "../components/Badge";
import { Button, IconButton } from "../components/Button";
import { Tooltip } from "../components/Tooltip";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { QUALITY_SHORT, roomId, scheduleText } from "../lib/labels";
import { fmtTimeInTz, localScheduleTooltip, localTimeTooltip } from "../lib/tz";
import { CreateEditTaskDialog } from "../modals/CreateEditTaskDialog";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** The list page (#/): create form trigger + task table, 2s polling refresh. */
export function TaskList(): ReactNode {
  const t = useT();
  const [tasks, setTasks] = useAtom(tasksAtom);
  const [conn, setConn] = useAtom(connAtom);
  const serverTz = useAtomValue(serverTimezoneAtom);
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Task | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const list = await api.listTasks();
      setTasks(list);
      setConn({ ok: true, at: Date.now() });
    } catch {
      setConn({ ok: false, at: Date.now() });
    } finally {
      setLoaded(true);
    }
  };

  usePolling(() => void refresh(), 2000);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (t: Task): void => {
    setEditing(t);
    setDialogOpen(true);
  };

  const act = async (
    id: number,
    action: "start" | "stop" | "delete",
  ): Promise<void> => {
    if (action === "delete") {
      setPendingDelete(id); // 改用 ConfirmDialog(base-ui AlertDialog),不再用 window.confirm
      return;
    }
    try {
      if (action === "start") {
        await api.startTask(id);
        toast(t("tasks.started", { id }), "success");
      } else {
        await api.stopTask(id);
        toast(t("tasks.stopped", { id }), "info");
      }
      await refresh();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const doDelete = async (id: number): Promise<void> => {
    try {
      await api.deleteTask(id);
      toast(t("tasks.deleted", { id }), "info");
      await refresh();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  return (
    <>
      <div className="flex items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("tasks.pageTitle")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("tasks.pageSubtitle")}</p>
        </div>
        <div className="flex items-center gap-3">
          {conn && (
            <Tooltip
              content={
                conn.ok
                  ? localTimeTooltip(new Date(conn.at), serverTz, (local) => t("common.localTimeTooltip", { local }))
                  : undefined
              }
            >
              <span
                className="hidden sm:inline-flex items-center gap-1.5 text-xs"
                style={{ color: conn.ok ? "var(--success)" : "var(--error)" }}
              >
                <span className="dot" style={{ background: conn.ok ? "var(--success)" : "var(--error)" }} />
                {conn.ok
                  ? t("tasks.connected", { time: fmtTimeInTz(new Date(conn.at), serverTz) })
                  : t("tasks.connFailed")}
              </span>
            </Tooltip>
          )}
          <Button onClick={openCreate}>
            <Plus className="w-4 h-4" />
            {t("tasks.add")}
          </Button>
        </div>
      </div>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th className="w-12">ID</th>
                <th>{t("tasks.colName")}</th>
                <th>{t("tasks.colQuality")}</th>
                <th>{t("tasks.colDanmu")}</th>
                <th>{t("tasks.colSchedule")}</th>
                <th>{t("tasks.colStatus")}</th>
                <th className="text-right">{t("tasks.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr>
                  <td colSpan={7} className="text-center text-muted py-12">
                    {t("tasks.loading")}
                  </td>
                </tr>
              )}
              {loaded && tasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-16">
                    <div className="flex flex-col items-center gap-4 text-muted">
                      <FolderOpen className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
                      <div className="text-sm font-medium text-ink">{t("tasks.noneYet")}</div>
                      <Button small onClick={openCreate}>
                        {t("tasks.add")}
                      </Button>
                    </div>
                  </td>
                </tr>
              )}
              {loaded &&
                tasks.map((task) => (
                  <tr key={task.id}>
                    <td className="font-mono text-muted-soft">{task.id}</td>
                    <td>
                      <Link to={`/task/${task.id}`} className="group block cursor-pointer">
                        {task.name || task.anchorName ? (
                          <>
                            <div className="font-medium text-ink group-hover:underline">
                              {task.name || task.anchorName}
                            </div>
                            <div className="font-mono text-xs text-muted mt-0.5 break-all">{roomId(task.room)}</div>
                          </>
                        ) : (
                          <div className="font-mono text-[13px] font-medium text-ink break-all group-hover:underline">
                            {roomId(task.room)}
                          </div>
                        )}
                      </Link>
                    </td>
                    <td>
                      <span className="badge badge-muted font-mono">
                        {QUALITY_SHORT[task.quality] ?? task.quality}
                      </span>
                    </td>
                    <td>
                      <DanmuBadge task={task} />
                    </td>
                    <td>
                      {scheduleText(task) ? (
                        <Tooltip
                          content={
                            task.scheduleStart && task.scheduleEnd
                              ? localScheduleTooltip(task.scheduleStart, task.scheduleEnd, serverTz, (window, local) =>
                                  t("tasks.scheduleLocalTooltip", { window, local }),
                                )
                              : undefined
                          }
                        >
                          <span className="font-mono text-[13px] text-body">{scheduleText(task)}</span>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-soft">—</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge running={task.running} status={task.status} enabled={task.enabled} recording={task.recording} />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5 justify-end">
                        {task.enabled ? (
                          <IconButton title={t("tasks.titleStop")} onClick={() => act(task.id, "stop")}>
                            <Square className="w-4 h-4" style={{ color: "var(--warning)" }} fill="currentColor" />
                          </IconButton>
                        ) : (
                          <IconButton title={t("tasks.titleStart")} onClick={() => act(task.id, "start")}>
                            <Play className="w-4 h-4" style={{ color: "var(--success)" }} fill="currentColor" />
                          </IconButton>
                        )}
                        <Link className="btn-icon" to={`/task/${task.id}`} title={t("tasks.titleDetail")}>
                          <FileText className="w-4 h-4" />
                        </Link>
                        <IconButton title={t("tasks.titleEdit")} onClick={() => openEdit(task)}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        <IconButton
                          title={task.enabled || task.running ? t("tasks.stopFirst") : t("common.delete")}
                          style={{ color: "var(--error)" }}
                          disabled={task.enabled || task.running}
                          onClick={() => act(task.id, "delete")}
                        >
                          <Trash2 className="w-4 h-4" />
                        </IconButton>
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <CreateEditTaskDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        task={editing}
        onSaved={() => void refresh()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("tasks.deleteConfirm", { id: pendingDelete ?? 0 })}
        confirmLabel={t("common.delete")}
        destructive
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id !== null) void doDelete(id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
