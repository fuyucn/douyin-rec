/**
 * NodesStrip — controller 常驻「节点」总览条(F2b)。
 *
 * fleet 模式下节点网页日常不看,controller 是唯一观察入口:一眼看到每个被分配的节点
 * 在不在线、版本漂没漂、磁盘还剩多少、在录几个房间、边录边传有多少未确认占盘。
 * 只读;数据全来自既有接口(任务的 recordingWorkers / workers status / 队列 delivering)。
 * 只显示「被某个房间选中」的节点 —— 没分配任务的节点不占版面。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type RollingDeliveryDTO, type Task, type WorkerStatus } from "../api/client";
import { baseVersion, fmtBytes, summarizeNodes } from "../lib/nodes-summary";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";

export function NodesStrip({ delivering }: { delivering: readonly RollingDeliveryDTO[] }): ReactNode {
  const t = useT();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<Record<string, WorkerStatus | undefined>>({});
  const [masterVersion, setMasterVersion] = useState("");

  useEffect(() => {
    let alive = true;
    void api.getVersion().then((r) => { if (alive) setMasterVersion(baseVersion(r.version)); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // 在录状态:任务接口自带 recordingWorkers(master 5 秒缓存),10 秒拉一次。失败保留上次。
  usePolling(() => { void api.listTasks().then(setTasks).catch(() => {}); }, 10_000);
  // 存活/版本/磁盘要 ssh 探测:60 秒一次(队列页打开期间)。
  usePolling(() => {
    void api.getWorkersStatus()
      .then((l) => setStatus(Object.fromEntries(l.map((s) => [s.id, s]))))
      .catch(() => {});
  }, 60_000);

  const nodes = useMemo(() => summarizeNodes(tasks, status, delivering, masterVersion), [tasks, status, delivering, masterVersion]);
  if (nodes.length === 0) return null;

  return (
    <div className="mb-5">
      <div className="section-label mb-2.5">{t("queue.nodes.title")}</div>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
        {nodes.map((n) => {
          const dot = n.ok === undefined ? "var(--muted-soft)" : n.ok ? "var(--success)" : "var(--error)";
          return (
            <div key={n.id} className="card px-4 py-3 text-sm space-y-1" data-testid={`node-${n.id}`}>
              <div className="flex items-center gap-2">
                <span className="dot shrink-0" style={{ background: dot }} />
                <span className="font-medium truncate">{n.name}</span>
                {n.version && (
                  <span className="ml-auto font-mono text-[11px]" style={{ color: n.drift ? "var(--warning)" : "var(--muted-soft)" }}
                    title={n.drift ? t("queue.nodes.drift", { v: baseVersion(n.version), m: masterVersion }) : undefined}>
                    {n.drift ? "⚠ " : ""}v{baseVersion(n.version)}
                  </span>
                )}
              </div>
              {n.ok === false && (
                <div className="text-[12px]" style={{ color: "var(--error-fg)" }}>{n.error ?? t("queue.nodes.offline")}</div>
              )}
              <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-[12px] text-muted">
                <span>{t("queue.nodes.recording", { n: n.recording })}</span>
                {n.unavailable > 0 && <span style={{ color: "var(--warning)" }}>{t("queue.nodes.unavailable", { n: n.unavailable })}</span>}
                {n.diskFreeGB !== undefined && (
                  <span style={{ color: n.diskLow ? "var(--error-fg)" : undefined }}>
                    {n.diskLow ? "⚠ " : ""}{t("queue.nodes.disk", { gb: n.diskFreeGB.toFixed(1) })}
                  </span>
                )}
                {n.rollingSessions > 0 && <span>{t("queue.nodes.rolling", { n: n.rollingSessions })}</span>}
                {n.lockedBytes > 0 && <span className="font-mono">{t("queue.nodes.locked", { size: fmtBytes(n.lockedBytes) })}</span>}
                {n.ambiguous > 0 && <span style={{ color: "var(--error-fg)" }}>{t("queue.delivering.unknown")} {n.ambiguous}</span>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
