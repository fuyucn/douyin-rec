import { useAtom, useAtomValue } from "jotai";
import {
  Activity,
  FileText,
  FolderOpen,
  LayoutGrid,
  Network,
  Pencil,
  Play,
  Plus,
  Square,
  Timer,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, type Task } from "../api/client";
import { connAtom, serverTimezoneAtom, tasksAtom } from "../atoms";
import { DanmuBadge, StatusBadge } from "../components/Badge";
import { stateColor } from "../components/HubJobs";
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

  // 顶部指标带:总数 / 录制中 / 待命 / 错误,一眼看当前机群状态。
  const recording = tasks.filter((t) =>
    t.enabled && (
      t.recordingWorkers?.some((worker) => worker.state === "recording") ||
      (t.running && t.recording !== false)
    ),
  ).length;
  const waiting = tasks.filter((t) =>
    t.enabled &&
    !t.recordingWorkers?.some((worker) => worker.state === "recording") &&
    !t.recordingWorkers?.some((worker) => worker.state === "unavailable") &&
    !t.running &&
    t.status !== "error",
  ).length;
  const errors = tasks.filter((t) =>
    t.status === "error" || t.recordingWorkers?.some((worker) => worker.state === "unavailable"),
  ).length;

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
                  ? localTimeTooltip(new Date(conn.at), serverTz, (tz, local) =>
                      t("common.localTimeTooltip", { serverTz: tz, local }),
                    )
                  : undefined
              }
            >
              <span
                className="hidden sm:inline-flex items-center gap-1.5 text-xs"
                style={{ color: conn.ok ? "var(--success-fg)" : "var(--error-fg)" }}
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

      <div className="telemetry-bar mb-5">
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.metricTotal")}</span>
            <span className="telemetry-value tabular-nums">{tasks.length}</span>
          </div>
          <span className="telemetry-icon"><LayoutGrid className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.metricRecording")}</span>
            <span className="telemetry-value tabular-nums" style={{ color: "var(--success-fg)" }}>{recording}</span>
          </div>
          <span className="telemetry-icon" style={{ color: "var(--success-fg)" }}><Activity className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.metricWaiting")}</span>
            <span className="telemetry-value tabular-nums">{waiting}</span>
          </div>
          <span className="telemetry-icon"><Timer className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("tasks.metricError")}</span>
            <span className="telemetry-value tabular-nums" style={{ color: errors ? "var(--error-fg)" : "var(--muted-soft)" }}>{errors}</span>
          </div>
          <span className="telemetry-icon" style={errors ? { color: "var(--error-fg)" } : undefined}><TriangleAlert className="w-4 h-4" /></span>
        </div>
      </div>

      <section className="table-shell">
        <div className="overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th className="hidden sm:table-cell w-10 sm:w-12">ID</th>
                {/* 名称列给足最小宽度,否则窄屏会被固定宽的 Status/Actions 挤成一字一行。 */}
                <th className="sm:min-w-[200px]">{t("tasks.colName")}</th>
                <th className="hidden md:table-cell w-[90px]">{t("tasks.colQuality")}</th>
                <th className="hidden md:table-cell w-[90px]">{t("tasks.colDanmu")}</th>
                <th className="hidden lg:table-cell w-[110px]">{t("tasks.colSchedule")}</th>
                <th className="w-[150px] sm:w-[220px]">{t("tasks.colStatus")}</th>
                <th className="w-[56px] sm:w-[130px] text-right">{t("tasks.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded &&
                [0, 1, 2].map((i) => (
                  <tr key={i} aria-hidden="true">
                    <td className="hidden sm:table-cell"><span className="skeleton block h-4 w-8" /></td>
                    <td>
                      <span className="skeleton block h-4 w-40 max-w-full" />
                      <span className="skeleton block h-3 w-28 max-w-full mt-2" />
                    </td>
                    <td className="hidden md:table-cell"><span className="skeleton block h-4 w-12" /></td>
                    <td className="hidden md:table-cell"><span className="skeleton block h-4 w-16" /></td>
                    <td className="hidden lg:table-cell"><span className="skeleton block h-4 w-20" /></td>
                    <td><span className="skeleton block h-4 w-24" /></td>
                    <td>
                      <div className="flex justify-end gap-1.5">
                        <span className="skeleton block h-8 w-8" />
                        <span className="skeleton block h-8 w-8" />
                      </div>
                    </td>
                  </tr>
                ))}
              {loaded && tasks.length === 0 && (
                <tr>
                  <td colSpan={7} className="p-0">
                    <div className="empty-state">
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
                    <td className="hidden sm:table-cell font-mono text-muted-soft">{task.id}</td>
                    <td>
                      <Link to={`/task/${task.id}`} className="group block cursor-pointer">
                        {task.name || task.anchorName ? (
                          <>
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium text-ink group-hover:underline">
                                {task.name || task.anchorName}
                              </span>
                              {task.managedBy === "hub" && (
                                <span className="badge badge-muted" title={t("tasks.managedHint")}>
                                  {t("tasks.managed")}
                                </span>
                              )}
                            </div>
                            <div className="font-mono text-xs text-muted mt-0.5 break-all">{roomId(task.room)}</div>
                            {/* hub 关联:该任务的后处理配了什么 + 上次结果,可点进 hub 房间页。 */}
                            {task.hubRule && (
                              <Link
                                to={`/hub/${encodeURIComponent(task.hubRule.key)}`}
                                className="inline-flex items-center gap-1.5 mt-1.5 text-[11px] text-muted hover:text-ink"
                                onClick={(e) => e.stopPropagation()}
                                title={t("tasks.hubLinked")}
                              >
                                <Network className="w-3 h-3 shrink-0" />
                                <span className="chip !h-5 !text-[10px]">
                                  {task.hubRule.uploadMode === "upload" ? t("tasks.hubUpload") : t("tasks.hubStage")}
                                </span>
                                <span className="font-mono text-muted-soft">{task.hubRule.steps.join(" · ")}</span>
                                {!task.hubRule.enabled && <span className="text-muted-soft">({t("tasks.hubDisabled")})</span>}
                                {task.hubRule.lastRun && (
                                  <span className="font-mono" style={{ color: stateColor(task.hubRule.lastRun.state) }}>
                                    {task.hubRule.lastRun.bv ?? task.hubRule.lastRun.state}
                                  </span>
                                )}
                              </Link>
                            )}
                            {/* 窄屏:Quality/Danmu/Schedule 列已隐藏,这里以紧凑 meta 行补上,信息不丢。 */}
                            <div className="flex items-center gap-2 flex-wrap mt-1.5 md:hidden">
                              <span className="chip !h-5 !text-[10px]">{QUALITY_SHORT[task.quality] ?? task.quality}</span>
                              <DanmuBadge task={task} />
                              {scheduleText(task) && (
                                <span className="font-mono text-[11px] text-muted-soft tabular-nums">{scheduleText(task)}</span>
                              )}
                            </div>
                          </>
                        ) : (
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-mono text-[13px] font-medium text-ink break-all group-hover:underline">
                              {roomId(task.room)}
                            </span>
                            {task.managedBy === "hub" && (
                              <span className="badge badge-muted" title={t("tasks.managedHint")}>
                                {t("tasks.managed")}
                              </span>
                            )}
                          </div>
                        )}
                      </Link>
                    </td>
                    <td className="hidden md:table-cell">
                      <span className="chip">
                        {QUALITY_SHORT[task.quality] ?? task.quality}
                      </span>
                    </td>
                    <td className="hidden md:table-cell">
                      <DanmuBadge task={task} />
                    </td>
                    <td className="hidden lg:table-cell">
                      {scheduleText(task) ? (
                        <Tooltip
                          content={
                            task.scheduleStart && task.scheduleEnd
                              ? localScheduleTooltip(task.scheduleStart, task.scheduleEnd, serverTz, (tz, local) =>
                                  t("tasks.scheduleLocalTooltip", { serverTz: tz, local }),
                                )
                              : undefined
                          }
                        >
                          <span className="font-mono text-[12.5px] text-body tabular-nums">{scheduleText(task)}</span>
                        </Tooltip>
                      ) : (
                        <span className="text-muted-soft">-</span>
                      )}
                    </td>
                    <td>
                      <StatusBadge
                        running={task.running}
                        status={task.status}
                        enabled={task.enabled}
                        recording={task.recording}
                        recordingWorkers={task.recordingWorkers}
                      />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5 justify-end">
                        {/* 窄屏(<sm):只留「详情」入口,避免 4 个图标挤爆手机宽度;
                            完整操作在详情页可用。 */}
                        <div className="hidden sm:flex items-center gap-1.5">
                        {task.enabled ? (
                          <IconButton
                            title={task.managedBy === "hub" ? t("tasks.managedHint") : t("tasks.titleStop")}
                            disabled={task.managedBy === "hub"}
                            onClick={() => act(task.id, "stop")}
                          >
                            <Square className="w-4 h-4" style={{ color: "var(--warning-fg)" }} fill="currentColor" />
                          </IconButton>
                        ) : (
                          <IconButton
                            title={task.managedBy === "hub" ? t("tasks.managedHint") : t("tasks.titleStart")}
                            disabled={task.managedBy === "hub"}
                            onClick={() => act(task.id, "start")}
                          >
                            <Play className="w-4 h-4" style={{ color: "var(--success-fg)" }} fill="currentColor" />
                          </IconButton>
                        )}
                        <Link className="btn-icon" to={`/task/${task.id}`} title={t("tasks.titleDetail")}>
                          <FileText className="w-4 h-4" />
                        </Link>
                        {!task.managedBy && (
                          <>
                            <IconButton title={t("tasks.titleEdit")} onClick={() => openEdit(task)}>
                              <Pencil className="w-4 h-4" />
                            </IconButton>
                            <IconButton
                              title={task.enabled || task.running ? t("tasks.stopFirst") : t("common.delete")}
                              style={{ color: "var(--error-fg)" }}
                              disabled={task.enabled || task.running}
                              onClick={() => act(task.id, "delete")}
                            >
                              <Trash2 className="w-4 h-4" />
                            </IconButton>
                          </>
                        )}
                        </div>
                        <span className="sm:hidden inline-flex">
                          <Link className="btn-icon" to={`/task/${task.id}`} title={t("tasks.titleDetail")}>
                            <FileText className="w-4 h-4" />
                          </Link>
                        </span>
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
