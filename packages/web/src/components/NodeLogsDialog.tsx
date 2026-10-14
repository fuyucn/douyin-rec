/**
 * NodeLogsDialog — controller 代查某个节点上某个任务的日志尾巴(F3)。
 *
 * 为什么:纯 fleet 模式下节点网页日常不看,排查却要登到节点上、找到任务、再看网页。
 * master 有到节点的 ssh 通道,代查即可 —— 不必给节点开公网入口,也不必让人记节点地址。
 * 只读:一次点击 = 一条 ssh(任务清单)+ 一条 ssh(日志),不缓存(日志就是要看最新的)。
 */
import { useEffect, useState, type ReactNode } from "react";
import { api, type NodeTaskLogsDTO, type NodeTasksDTO } from "../api/client";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Loader2 } from "lucide-react";
import { useT } from "../lib/i18n";

export function NodeLogsDialog({
  workerId,
  workerName,
  onClose,
}: {
  /** null = 关闭。 */
  workerId: string | null;
  workerName: string;
  onClose: () => void;
}): ReactNode {
  const t = useT();
  const [tasks, setTasks] = useState<NodeTasksDTO | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [logs, setLogs] = useState<NodeTaskLogsDTO | null>(null);
  const [loadingLogs, setLoadingLogs] = useState(false);

  const open = workerId !== null;
  // 打开时拉一次任务清单;关闭不清空 —— 同一节点再打开时先显示上次结果,拉完覆盖(不闪空)。
  useEffect(() => {
    if (workerId === null) return;
    let alive = true;
    setTasks(null);
    setSelected(null);
    setLogs(null);
    void api.getNodeTasks(workerId)
      .then((r) => { if (alive) setTasks(r); })
      .catch((e) => { if (alive) setTasks({ workerId, tasks: [], error: (e as Error)?.message ?? String(e) }); });
    return () => { alive = false; };
  }, [workerId]);

  const loadLogs = (taskId: number): void => {
    if (workerId === null) return;
    setSelected(taskId);
    setLoadingLogs(true);
    setLogs(null);
    void api.getNodeTaskLogs(workerId, taskId)
      .then(setLogs)
      .catch((e) => setLogs({ workerId, taskId, lines: [], error: (e as Error)?.message ?? String(e) }))
      .finally(() => setLoadingLogs(false));
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-3xl"
      title={t("hub.workers.nodeLogs.title", { node: workerName })}
      description={t("hub.workers.nodeLogs.desc")}
    >
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <span className="section-label">{t("hub.workers.nodeLogs.tasks")}</span>
          <Button small variant="secondary" onClick={onClose}>{t("common.close")}</Button>
        </div>
        {tasks === null && <div className="text-muted text-sm py-3"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /> {t("hub.common.loading")}</div>}
        {tasks?.error && <div className="text-[12px]" style={{ color: "var(--error-fg)" }}>{tasks.error}</div>}
        {tasks && !tasks.error && tasks.tasks.length === 0 && (
          <div className="text-muted text-sm py-3">{t("hub.workers.nodeLogs.noTasks")}</div>
        )}
        {tasks && tasks.tasks.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {tasks.tasks.map((task) => (
              <Button
                key={task.id}
                small
                variant={selected === task.id ? undefined : "secondary"}
                onClick={() => loadLogs(task.id)}
                title={`#${task.id} · ${task.platform}`}
              >
                #{task.id} {task.anchorName ?? task.name ?? task.roomSlug}
                {task.enabled ? "" : ` · ${t("badge.disabled")}`}
              </Button>
            ))}
          </div>
        )}
        {selected !== null && (
          <>
            <div className="section-label pt-1">{t("hub.workers.nodeLogs.log", { id: String(selected) })}</div>
            {loadingLogs && <div className="text-muted text-sm"><Loader2 className="w-3.5 h-3.5 animate-spin inline" /> {t("hub.common.loading")}</div>}
            {logs?.error && <div className="text-[12px]" style={{ color: "var(--error-fg)" }}>{logs.error}</div>}
            {logs && !logs.error && (
              logs.lines.length === 0 ? (
                <div className="text-muted text-sm">{t("tasks.noLogs")}</div>
              ) : (
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all max-h-[50vh] overflow-auto bg-surface-soft rounded p-3 text-body">
                  {logs.lines.join("\n")}
                </pre>
              )
            )}
          </>
        )}
      </div>
    </Dialog>
  );
}
