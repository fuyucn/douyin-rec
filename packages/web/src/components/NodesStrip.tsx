/**
 * NodesStrip — controller 常驻「节点」总览条(F2b)。
 *
 * fleet 模式下节点网页日常不看,controller 是唯一观察入口:一眼看到每个被分配的节点
 * 在不在线、版本漂没漂、磁盘还剩多少、在录几个房间、边录边传有多少未确认占盘。
 * 只读;数据全来自既有接口(任务的 recordingWorkers / workers status / 队列 delivering)。
 * 只显示「被某个房间选中」的节点 —— 没分配任务的节点不占版面。
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { hubEnabledAtom } from "../atoms";
import { api, type RollingDeliveryDTO, type Task, type WorkerStatus } from "../api/client";
import { baseVersion, fmtBytes, summarizeNodes, type NodeRoomState } from "../lib/nodes-summary";
import { usePolling } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { Button } from "./Button";
import { NodeLogsDialog } from "./NodeLogsDialog";

const ROOM_DOT: Record<NodeRoomState, string> = {
  recording: "var(--success)", waiting: "var(--muted-soft)", unavailable: "var(--warning)", disabled: "var(--hairline)",
};

/** 「N 分钟前」式相对时间(只给粗粒度,卡片不需要秒级)。 */
function agoLabel(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export function NodesStrip({ delivering }: { delivering: readonly RollingDeliveryDTO[] }): ReactNode {
  const t = useT();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [status, setStatus] = useState<Record<string, WorkerStatus | undefined>>({});
  const [masterVersion, setMasterVersion] = useState("");
  const [logsFor, setLogsFor] = useState<{ id: string; name: string } | null>(null);
  // 只在确认是 master(hub 已启用)时才轮询;加载中/节点模式不发请求。
  const enabled = useAtomValue(hubEnabledAtom) === true;

  useEffect(() => {
    let alive = true;
    void api.getVersion().then((r) => { if (alive) setMasterVersion(baseVersion(r.version)); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  // 在录状态:任务接口自带 recordingWorkers(master 5 秒缓存),10 秒拉一次。失败保留上次。
  usePolling(() => { void api.listTasks().then(setTasks).catch(() => {}); }, 10_000, enabled);
  // 存活/版本/磁盘要 ssh 探测:60 秒一次(队列页打开期间)。
  usePolling(() => {
    void api.getWorkersStatus()
      .then((l) => setStatus(Object.fromEntries(l.map((s) => [s.id, s]))))
      .catch(() => {});
  }, 60_000, enabled);

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
                <span className="dot shrink-0" style={{ background: dot }} title={n.ok === undefined ? t("hub.workers.statusChecking") : undefined} />
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
                {/* 会话级进度已在下面的房间行里逐条给出,这里不重复「N 场 / 多少 MB」。 */}
                {n.ambiguous > 0 && <span style={{ color: "var(--error-fg)" }}>{t("queue.delivering.unknown")} {n.ambiguous}</span>}
              </div>
              {/* 分配到该节点的房间:状态 + 边录边传进度,不用点进别处才知道节点在干什么。 */}
              {n.rooms.length > 0 && (
                <ul className="pt-1 space-y-1">
                  {/* 已停用且没有未收口会话的房间只计数,不逐条占版面。 */}
                  {n.rooms.filter((r) => r.state !== "disabled" || r.sessions.length > 0).map((r) => (
                    <li key={r.key} className="text-[12px]">
                      <div className="flex items-center gap-2">
                        <span className="dot shrink-0" style={{ background: ROOM_DOT[r.state] }} />
                        <span className="truncate">{r.label}</span>
                        <span className="ml-auto text-muted-soft shrink-0">{t(`queue.nodes.state.${r.state}`)}</span>
                      </div>
                      {r.sessions.map((s) => (
                        <div key={s.sessionBase} className="pl-4 text-muted font-mono text-[11px] flex flex-wrap gap-x-2">
                          <span>{t("queue.delivering.progress", { c: s.confirmed, n: s.total })}</span>
                          {s.uploading && <span>{t("queue.delivering.pending")}</span>}
                          {typeof s.lockedBytes === "number" && s.lockedBytes > 0 && <span>{fmtBytes(s.lockedBytes)}</span>}
                          {s.ambiguous > 0 && <span style={{ color: "var(--error-fg)" }}>{t("queue.delivering.unknown")} {s.ambiguous}</span>}
                          {s.bv && <a className="hover:text-ink" href={`https://www.bilibili.com/video/${s.bv}`} target="_blank" rel="noreferrer">{s.bv}</a>}
                        </div>
                      ))}
                    </li>
                  ))}
                  {n.rooms.some((r) => r.state === "disabled" && r.sessions.length === 0) && (
                    <li className="text-[11px] text-muted-soft">
                      {t("queue.nodes.disabledCount", { n: n.rooms.filter((r) => r.state === "disabled" && r.sessions.length === 0).length })}
                    </li>
                  )}
                </ul>
              )}
              {/* 任务配置同步:最近一次应用时间;期望版本没应用上则告警。 */}
              {n.ok !== false && (n.appliedAt || n.syncLag || n.syncError) && (
                <div className="text-[11px]" style={{ color: n.syncLag || n.syncError ? "var(--warning)" : "var(--muted-soft)" }}>
                  {n.syncLag
                    ? t("queue.nodes.syncLag", { applied: String(n.appliedVersion), expected: String(n.expectedVersion) })
                    : n.syncError ?? t("queue.nodes.synced", { ago: agoLabel(n.appliedAt!) })}
                </div>
              )}
              {/* F3:master 代查该节点日志(只读),排查不用登节点看网页;本机节点由后端回提示。 */}
              <div className="pt-1">
                <Button small variant="secondary" onClick={() => setLogsFor({ id: n.id, name: n.name })}>
                  {t("hub.workers.logs")}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <NodeLogsDialog
        workerId={logsFor?.id ?? null}
        workerName={logsFor?.name ?? ""}
        onClose={() => setLogsFor(null)}
      />
    </div>
  );
}
