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
import { ChevronDown, History } from "lucide-react";
import { api, ApiError, type HubJobDTO, type RoomDTO, type RollingDeliveryDTO, type Task, type WorkerDTO } from "../api/client";
import { Button } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { JobLogDialog, RunCard } from "./HubJobs";
import { CurrentRunTree } from "./CurrentRunTree";
import { LiveRunHistory } from "./LiveRunHistory";
import { RunNowDialog } from "./RunNowDialog";
import type { FlowCfg } from "./flow-build";
import { useHubStream, usePolling, useToast, errMessage } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { todayYmdInTz } from "../lib/tz";
import { serverTimezoneAtom } from "../atoms";
import { shouldToastRunError } from "../lib/run-now";
import { hasCurrentRun, listedRunCount, showsRunsEmpty } from "../lib/room-runs";
import { useAtomValue } from "jotai";

const PAGE = 20;

export function RoomRunsPanel({
  room,
  workers,
  collapsed = false,
  task,
  rolling = [],
}: {
  room: RoomDTO;
  /** 节点 id→友好名(与本页配置半边共用同一份,查不到回落 id)。 */
  workers: WorkerDTO[];
  /** Start with every run collapsed (the detail page keeps its summary within one screen). */
  collapsed?: boolean;
  /** Live-upload / rolling progress of the running broadcast (shown as a per-part tree above the history). */
  task?: Task;
  rolling?: RollingDeliveryDTO[];
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const serverTz = useAtomValue(serverTimezoneAtom);
  const [runs, setRuns] = useState<HubJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState(1);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [runOpen, setRunOpen] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [forceRun, setForceRun] = useState<{ streamKey: string; message: string } | null>(null);

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
  const defaultKey = collapsed ? undefined : runs[0]?.streamKey;
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
  const rerun = useCallback(async (streamKey: string): Promise<void> => {
    setBusy(true);
    try {
      await api.runHubJob({ streamKey });
      toast(t("hub.jobs.started"), "info");
      await refresh().catch(() => {});
    } catch (e) {
      if (e instanceof ApiError && e.forceable) {
        setForceRun({ streamKey, message: e.message });
      } else {
        toast(errMessage(e), "error");
      }
    } finally {
      setBusy(false);
    }
  }, [refresh, toast, t]);

  const forceRerun = async (streamKey: string): Promise<void> => {
    setBusy(true);
    try {
      await api.runHubJob({ streamKey, force: true });
      toast(t("hub.jobs.started"), "info");
      await refresh().catch(() => {});
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const runNow = async ({ key, winnerWorker, force }: { key: string; winnerWorker?: string; force?: boolean }): Promise<void> => {
    setRunBusy(true);
    try {
      await api.runHubJob({ streamKey: key, winnerWorker, force });
      toast(t("hub.jobs.started"), "info");
      setRunOpen(false);
      await refresh().catch(() => {});
    } catch (e) {
      // A forceable 409 is handled by the dialog's confirm step; legacy behaviour shows only that confirm.
      if (shouldToastRunError({ forceable: e instanceof ApiError && e.forceable, force: force === true })) {
        toast(errMessage(e), "error");
      }
      throw e;
    } finally {
      setRunBusy(false);
    }
  };

  // 直播直传/边录边传的当前场次这一行是否会有(空列表判定与计数都要算上它,issue #417)。
  const hasLiveRow = hasCurrentRun({
    streamUpload: !!task?.streamUpload,
    liveNodes: (task?.zeroDisk ?? []).filter((z) => z.live).length,
    rolling: rolling.length,
  });

  // cfg 交给 RunCard 画「计划图」(进行中 run 还没写 steps 时靠它画出待办节点)。
  const cfg = useMemo(() => (room.processing?.pipeline ?? undefined) as FlowCfg | undefined, [room.key, room.processing]);

  return (
    <>
    <section className="run-list-shell">
      <div className="px-3 py-2.5 border-b border-hairline flex items-center justify-between gap-3">
        <span className="section-label">{t("rooms.runsHeading")}</span>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-muted-soft">{listedRunCount({ hubRuns: runs.length, hasCurrent: hasLiveRow })}</span>
          <Button small variant="secondary" onClick={() => setRunOpen(true)}>
            {t("hub.jobs.runNow")}
          </Button>
        </div>
      </div>
      <div className="p-1.5">
        {/* 当前场次与直播直传历史排在最前面,是同一份运行列表的最新几条,不另起区块。 */}
        <CurrentRunTree task={task} rolling={rolling} workers={workers} />
        <LiveRunHistory task={task} workers={workers} />
        {!loaded &&
          [0, 1].map((i) => (
            <div key={i} className="px-3 py-2.5" aria-hidden="true">
              <span className="skeleton block h-4 w-28 max-w-full" />
              <span className="skeleton block h-3 w-36 max-w-full mt-2" />
            </div>
          ))}
        {showsRunsEmpty({ loaded, hubRuns: runs.length, hasCurrent: hasLiveRow }) && (
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
      <RunNowDialog
        open={runOpen}
        onClose={() => setRunOpen(false)}
        runs={runs}
        workers={workers}
        roomPrefix={`${room.platform}:${room.roomSlug}`}
        roomWorkerIds={room.processing?.workers}
        today={todayYmdInTz(serverTz)}
        busy={runBusy}
        onSubmit={runNow}
      />
      <ConfirmDialog
        open={forceRun !== null}
        title={t("hub.jobs.runForceTitle")}
        message={<><span className="block">{forceRun?.message}</span><span className="block mt-2">{t("hub.jobs.runForceHint")}</span></>}
        confirmLabel={t("hub.jobs.runForceConfirm")}
        destructive
        onConfirm={() => {
          const f = forceRun;
          setForceRun(null);
          if (f) void forceRerun(f.streamKey);
        }}
        onCancel={() => setForceRun(null)}
      />
      {/* 推送失效提示(与队列页/Hub 页同款),不静默停在旧值。 */}
      {stream.stale && (
        <div className="px-3 py-2 text-[11px]" style={{ color: "var(--warning-fg)" }}>
          {stream.live ? t("hub.common.staleHintFetch") : t("hub.common.staleHint")}
        </div>
      )}
    </section>
    </>
  );
}
