/**
 * RoomRunsPanel — **某房间的处理运行态**(T31:`/rooms` 要替代 Hub 页,不能只有配置)。
 *
 * **为什么单独有这个组件**:此前 `/rooms` 只搬了 Hub 的**配置**半边(规则字段),
 * 运行态半边(workflow 流程图 / 运行记录 / 日志 / 重跑)全在 `RoomDetail` 里没跟过来 ——
 * 结果「配好了却看不到在跑什么」,而用户要的正是「一处配 + 一处看」。
 *
 * **刻意复用 `RunCard`**(不重写):它是 workflow DAG(PipelineFlow)、步骤时间线、
 * ETA、日志入口、单节点重试、二次确认的唯一实现。在这里另画一套 = 两处必然漂移
 * (改一处文案/交互,另一处不变),这正是本次审计要消灭的那类问题。
 *
 * 数据口径与 Hub 房间详情一致:`GET /api/hub/jobs?room={key}`(该房间的历次 run,新→旧),
 * 推送驱动刷新(与队列页同款:推送不可用自动退化为有界退避轮询)。
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, History, Pencil, X } from "lucide-react";
import { api, type HubJobDTO, type RoomDTO, type WorkerDTO } from "../api/client";
import { Button, IconButton } from "./Button";
import { JobLogDialog, RunCard } from "./HubJobs";
import type { FlowCfg } from "./flow-build";
import { useHubStream, usePolling, useToast, errMessage } from "../lib/hooks";
import { useT } from "../lib/i18n";

const PAGE = 20;

export function RoomRunsPanel({
  room,
  workers,
}: {
  room: RoomDTO;
  /** 节点 id→友好名(与本页配置半边共用同一份,查不到回落 id)。 */
  workers: WorkerDTO[];
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const [runs, setRuns] = useState<HubJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState(1);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 稳定引用:workerName 只在 workers 变化时换,否则每次渲染新引用会击穿 RunCard 内
  // PipelineFlow 的 memo(既有 RoomDetail 同款注释,不是新问题)。
  const workerName = useCallback((id: string): string => workers.find((w) => w.id === id)?.name ?? id, [workers]);

  const refresh = useCallback(async (): Promise<void> => {
    // 不吞错:reject 让 useHubStream 置 stale(页面显示「数据可能已过期」),而不是悄悄停在旧值。
    try {
      const d = await api.listHubJobs({ room: room.key, limit: pages * PAGE, offset: 0 });
      setRuns(d.jobs ?? []);
      setTotal(d.total ?? 0);
    } finally {
      setLoaded(true);
    }
  }, [room.key, pages]);

  const stream = useHubStream(refresh);
  usePolling(() => void refresh().catch(() => {}), 30_000);
  // 换房间时回到第一页并重拉(否则会把上一房间的页码带过来)。
  useEffect(() => { setPages(1); }, [room.key]);

  // 默认展开最近一条;点行展开/收起该行自己的流程图。
  const defaultKey = runs[0]?.streamKey;
  const isExpanded = (k: string): boolean => (expandedKey === null ? k === defaultKey : expandedKey === k);
  const toggleRun = (k: string): void =>
    setExpandedKey((prev) => (prev === null ? k : prev === k ? "" : k));

  const withBusy = useCallback(async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    try {
      await fn();
      await refresh().catch(() => {});
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

  const retryNode = useCallback(
    (streamKey: string, node: string, force = false) =>
      withBusy(async () => {
        await api.retryHubNode(streamKey, node, { force });
        toast(t("hub.jobs.retryNode"), "info");
      }),
    [withBusy, toast, t],
  );
  const stopJob = useCallback(
    (streamKey: string) =>
      withBusy(async () => {
        await api.stopHubJob(streamKey);
        toast(t("hub.jobs.stopped"), "info");
      }),
    [withBusy, toast, t],
  );
  const rerun = useCallback(
    (streamKey: string) =>
      withBusy(async () => {
        await api.runHubJob({ streamKey });
        toast(t("hub.jobs.started"), "info");
      }),
    [withBusy, toast, t],
  );

  // cfg 交给 RunCard 画「计划图」(进行中 run 还没写 steps 时靠它画出待办节点)。
  const cfg = useMemo(() => (room.processing?.pipeline ?? undefined) as FlowCfg | undefined, [room.key, room.processing]);

  return (
    <section className="run-list-shell">
      <div className="px-3 py-2.5 border-b border-hairline flex items-center justify-between gap-3">
        <span className="section-label">{t("rooms.runsHeading")}</span>
        <span className="font-mono text-[11px] text-muted-soft">{total}</span>
      </div>
      <div className="p-1.5">
        {!loaded &&
          [0, 1].map((i) => (
            <div key={i} className="px-3 py-2.5" aria-hidden="true">
              <span className="skeleton block h-4 w-28 max-w-full" />
              <span className="skeleton block h-3 w-36 max-w-full mt-2" />
            </div>
          ))}
        {loaded && runs.length === 0 && (
          <div className="empty-state" style={{ minHeight: 160 }}>
            <History className="w-9 h-9" style={{ color: "var(--muted-soft)" }} />
            <div className="text-sm font-medium text-ink">{t("rooms.runsEmpty")}</div>
            <p className="text-xs text-muted-soft max-w-sm text-center">{t("rooms.runsEmptyHint")}</p>
          </div>
        )}
        {loaded &&
          runs.map((j) => (
            <RunCard
              key={j.streamKey}
              job={j}
              onOpenLog={setLogKey}
              workerName={workerName}
              cfg={cfg}
              expanded={isExpanded(j.streamKey)}
              onToggle={toggleRun}
              onRetry={retryNode}
              onStop={stopJob}
              onRunNow={rerun}
            />
          ))}
        {runs.length < total && (
          <div className="px-3 py-2 flex justify-center">
            <Button small variant="secondary" disabled={busy} onClick={() => setPages((p) => p + 1)}>
              <ChevronDown className="w-3.5 h-3.5" />
              {t("hub.detail.loadMore", { count: total - runs.length })}
            </Button>
          </div>
        )}
      </div>
      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
      {/* 推送失效提示(与队列页/Hub 页同款),不静默停在旧值。 */}
      {stream.stale && (
        <div className="px-3 py-2 text-[11px]" style={{ color: "var(--warning-fg)" }}>
          {stream.live ? t("hub.common.staleHintFetch") : t("hub.common.staleHint")}
        </div>
      )}
    </section>
  );
}

/**
 * RoomRunsDrawer — 运行态的**右侧滑入抽屉**(与 RoomEditPanel 同一套交互标准)。
 *
 * 为什么用抽屉而不是把流程图塞进表格行:workflow 流程图有固定宽度(React Flow 画布),
 * 塞进表格会把列撑爆;抽屉给全宽,又与「点行右侧的运行态按钮」这个入口自然对应。
 * 抽屉内 = 房间头 + `RoomRunsPanel`(运行记录,每条可展开看自己的 workflow 流程图)。
 */
export function RoomRunsDrawer({
  room,
  workers,
  onClose,
  onEdit,
}: {
  room: RoomDTO;
  workers: WorkerDTO[];
  onClose: () => void;
  onEdit: () => void;
}): ReactNode {
  const t = useT();
  // Esc 关闭(与 RoomEditPanel / Worker 面板同款)。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const name = room.recording?.name || room.recording?.anchorName || room.roomSlug;

  return (
    <>
      <div
        className="modal-backdrop"
        style={{ zIndex: 100 }}
        onClick={onClose}
      />
      <aside
        className="fixed top-0 right-0 h-full w-full sm:w-[92vw] sm:max-w-[880px] overflow-y-auto"
        style={{
          zIndex: 101,
          background: "var(--raised)",
          borderLeft: "1px solid var(--hairline)",
          boxShadow: "var(--shadow-slide)",
        }}
        role="dialog"
        aria-modal="true"
      >
        <div
          className="flex items-start justify-between gap-3 px-4 sm:px-5 pt-5 pb-3 sticky top-0 z-10"
          style={{ background: "var(--raised)", borderBottom: "1px solid var(--hairline)" }}
        >
          <div className="min-w-0">
            <h2 className="headline text-[20px] leading-tight truncate">{name}</h2>
            <p className="text-muted text-xs mt-1 font-mono truncate" title={room.room}>
              {room.platform} · {room.roomSlug}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button small variant="secondary" onClick={onEdit}>
              <Pencil className="w-3.5 h-3.5" />
              {t("rooms.edit")}
            </Button>
            <IconButton title={t("hub.workers.close")} onClick={onClose}>
              <X className="w-4 h-4" />
            </IconButton>
          </div>
        </div>
        <div className="px-4 sm:px-5 py-4">
          <RoomRunsPanel room={room} workers={workers} />
        </div>
      </aside>
    </>
  );
}
