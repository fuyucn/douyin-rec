import { Activity, ChevronLeft, GripVertical, Network, Plus, Radio, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAtomValue } from "jotai";
import { api, type HubRuleDTO, type WorkerDTO, type WorkerStatus } from "../api/client";
import { hubEnabledAtom } from "../atoms";
import { Button } from "../components/Button";
import { LatestRunBadge } from "../components/HubJobs";
import { RoomDetail } from "../components/RoomDetail";
import { WorkersPanel } from "../components/WorkersPanel";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { useDragReorder } from "../lib/dragReorder";
import { usePolling, useToast, errMessage } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { useT } from "../lib/i18n";

/** Hub 管理页(/hub 与 /hub/:key 共用):左房间列表 + 右详情(RoomDetail)。 */
/** 非终态 run 状态(Active 指标口径;与后端 HubJobState 契约对齐)。 */
const ACTIVE_STATES = ["pending", "settling", "syncing", "merging", "uploading", "retrying"];

export function HubPage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const { key } = useParams<{ key?: string }>();
  const navigate = useNavigate();
  const [rules, setRules] = useState<HubRuleDTO[]>([]);
  /** 全部非终态 run 的**数量**(Active 指标;用后端 total 权威计数,不受分页 limit 截断)。 */
  const [activeRuns, setActiveRuns] = useState(0);
  /** 每个房间最新一条 run(徽标用;权威来源,不受「最近 N 条」分页影响)。 */
  const [latestByRoom, setLatestByRoom] = useState<Record<string, { streamKey: string; state: string; bv: string | null; updatedAt: number }>>({});
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [workerStatus, setWorkerStatus] = useState<Record<string, WorkerStatus>>({});
  const [panelOpen, setPanelOpen] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setRules(await api.listHubRules());
    } catch {
      /* 静默:轮询会重试 */
    } finally {
      setLoaded(true);
    }
    // Active 指标必须统计**全部**非终态 run,不能用上面「最近 20 条」的 jobs(数据一多会恒为 0)。
    // 用 states 精确过滤 + 读后端 total(权威计数,不受 limit 截断)。
    try {
      setActiveRuns((await api.listHubJobs({ states: ACTIVE_STATES, limit: 1 })).total);
    } catch {
      /* 忽略 */
    }
    // 房间徽标:每房间最新一条 run(单独端点,不受分页影响 —— 否则有历史 run 的房间会误显示「尚无运行」)。
    try {
      const { rooms } = await api.getLatestRuns();
      setLatestByRoom(Object.fromEntries(rooms.map((r) => [r.roomKey, r])));
    } catch {
      /* 忽略 */
    }
  };
  usePolling(() => void refresh(), 3000);

  const refreshWorkers = async (): Promise<void> => {
    try {
      setWorkers(await api.listWorkers());
    } catch {
      /* 静默:轮询会重试 */
    }
  };
  usePolling(() => void refreshWorkers(), 3000, hubEnabled === true);

  const fetchWorkerStatus = async (): Promise<void> => {
    try {
      const list = await api.getWorkersStatus();
      setWorkerStatus(Object.fromEntries(list.map((s) => [s.id, s])));
    } catch {
      /* 保留上次 status */
    }
  };
  // worker 存活轮询周期(ms):5 分钟(沿用原 WorkersCard 常量)。
  usePolling(() => void fetchWorkerStatus(), 300_000, hubEnabled === true);

  /** 某规则(房间)的历次 run,新→旧:streamKey 前缀 `{platform}:{roomSlug}:` 匹配。 */
  /** 房间徽标用的「最新一条 run」:走 latestByRoom(权威端点),而不是 jobs(受最近 N 条分页限制)。 */
  const latestRunOf = (r: HubRuleDTO): { state: string; currentStepSec?: number | null } | undefined =>
    latestByRoom[`${r.platform}:${r.roomSlug}`];

  const toast = useToast();
  // 房间列表拖拽排序:drop 后整体顺序持久化到 {key}.json,服务端返回权威顺序回显。
  const dnd = useDragReorder<HubRuleDTO>({
    items: rules,
    keyOf: (r) => r.key,
    disabled: hubEnabled !== true,
    onCommit: async (keys) => {
      try {
        setRules(await api.reorderHubRules(keys));
      } catch (e) {
        toast(errMessage(e), "error");
        void refresh();
      }
    },
  });

  // 本节点不是 master(未启用 hub)→ child-node 提示(原样保留)。
  if (hubEnabled === false) {
    return (
      <div className="card p-10 flex flex-col items-center gap-4 text-center">
        <Network className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
        <h1 className="headline text-[22px]">{t("hub.page.childTitle")}</h1>
        <p className="text-muted text-sm max-w-md">
          {t("hub.page.childDesc1")}<code>task serve</code>{t("hub.page.childDesc2")}<code>--hub</code>
          {t("hub.page.childDesc3")}<b>{t("hub.page.childMaster")}</b>{t("hub.page.childDesc4")}
        </p>
      </div>
    );
  }

  // 选中房间:URL param 命中则用之,否则默认第一个。
  // explicitKey = URL 真的指定了房间(用于窄屏 master-detail:没选就只看列表)。
  const explicitKey = key && rules.some((r) => r.key === key) ? key : null;
  const selectedKey = explicitKey ?? rules[0]?.key;
  const selectedRule = rules.find((r) => r.key === selectedKey) ?? null;
  const selectRoom = (r: HubRuleDTO): void => {
    navigate(`/hub/${encodeURIComponent(r.key)}`);
  };

  // pill 健康点:全 ok=绿 / 有 fail=红 / 尚无结果=灰。
  const statuses = workers.map((w) => workerStatus[w.id]).filter(Boolean) as WorkerStatus[];
  const anyFail = statuses.some((s) => !s.ok);
  const allOk = statuses.length > 0 && statuses.every((s) => s.ok);
  const pillDot = anyFail ? "var(--error)" : allOk ? "var(--success)" : "var(--muted-soft)";
  const pillTitle = anyFail ? t("hub.workers.statusMixed") : allOk ? t("hub.workers.statusOk") : t("hub.workers.statusChecking");

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="headline text-[26px] sm:text-[30px] leading-tight">{t("hub.page.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("hub.page.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setPanelOpen(true)}
            className="btn-secondary btn-sm inline-flex items-center gap-2"
            title={pillTitle}
          >
            <Server className="w-4 h-4" />
            {t("hub.workers.pill", { count: workers.length })}
            <span className="dot" style={{ background: pillDot }} />
          </button>
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="w-4 h-4" />
            {t("hub.page.newRule")}
          </Button>
        </div>
      </div>

      <div className="telemetry-bar telemetry-bar-cols-3 mb-5">
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("hub.page.metricRules")}</span>
            <span className="telemetry-value tabular-nums">{rules.length}</span>
          </div>
          <span className="telemetry-icon"><Radio className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("hub.page.metricWorkers")}</span>
            <span className="telemetry-value tabular-nums">{workers.length}</span>
          </div>
          <span className="telemetry-icon"><Server className="w-4 h-4" /></span>
        </div>
        <div className="telemetry-cell">
          <div className="flex flex-col gap-1.5 min-w-0">
            <span className="telemetry-label">{t("hub.page.metricActive")}</span>
            <span className="telemetry-value tabular-nums" style={{ color: activeRuns ? "var(--success-fg)" : "var(--muted-soft)" }}>
              {activeRuns}
            </span>
          </div>
          <span className="telemetry-icon" style={activeRuns ? { color: "var(--success-fg)" } : undefined}>
            <Activity className="w-4 h-4" />
          </span>
        </div>
      </div>

      {loaded && rules.length === 0 ? (
        <section className="empty-state">
          <Radio className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
          <div className="text-sm font-medium text-ink">{t("hub.page.noRules")}</div>
          <Button small onClick={() => setDialogOpen(true)}>{t("hub.page.newRule")}</Button>
        </section>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[288px_1fr] gap-6 items-start">
          {/* 左:房间列表。窄屏(<lg)未选中任何房间时才显示(选中后让位给详情,避免要滚过 14 个房间)。 */}
          <aside className={`lg:pr-2 ${explicitKey ? "hidden lg:block" : ""}`}>
            <div className="run-list-shell">
              <div className="px-3 py-2.5 border-b border-hairline flex items-center justify-between gap-3">
                <span className="section-label">{t("hub.page.roomsHeading")}</span>
                <span className="font-mono text-[11px] text-muted-soft">{rules.length}</span>
              </div>
              <div className="p-1.5 space-y-0.5">
                {!loaded &&
                  [0, 1, 2].map((i) => (
                    <div key={i} className="px-3 py-2.5" aria-hidden="true">
                      <span className="skeleton block h-4 w-28 max-w-full" />
                      <span className="skeleton block h-3 w-36 max-w-full mt-2" />
                    </div>
                  ))}
                {dnd.ordered.map((r) => {
                  const active = r.key === selectedKey;
                  return (
                    <button
                      key={r.key}
                      onClick={() => selectRoom(r)}
                      className={`rail-item ${active ? "rail-item-active" : ""} ${dnd.overKey === r.key && dnd.dragKey !== r.key ? "rail-item-drag-over" : ""}`}
                      style={{ opacity: (r.enabled ? 1 : 0.55) * (dnd.dragKey === r.key ? 0.5 : 1) }}
                      {...dnd.itemProps(r.key)}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="rail-grip" title={t("hub.common.dragTip")}><GripVertical className="w-3.5 h-3.5 shrink-0" /></span>
                          {r.anchorName ? (
                            <div className="font-medium text-ink truncate">{r.anchorName}</div>
                          ) : (
                            <div className="font-mono text-[13px] font-medium text-ink truncate">{roomId(r.room)}</div>
                          )}
                        </div>
                        {r.anchorName && (
                          <div className="font-mono text-[11px] text-muted-soft mt-0.5 truncate pl-5">{roomId(r.room)}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="dot" style={{ background: r.enabled ? "var(--success)" : "var(--muted-soft)" }} />
                        <LatestRunBadge run={latestRunOf(r)} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* 右:选中房间详情。窄屏未选中时隐藏(只显示列表)。 */}
          <section className={`min-w-0 ${explicitKey ? "" : "hidden lg:block"}`}>
            {/* 窄屏返回列表入口(宽屏不需要,列表一直在左)。 */}
            <button
              type="button"
              onClick={() => navigate("/hub")}
              className="lg:hidden inline-flex items-center gap-1.5 text-[13px] text-muted hover:text-ink mb-3 cursor-pointer"
            >
              <ChevronLeft className="w-4 h-4" />
              {t("hub.page.backToList")}
            </button>
            {selectedRule ? (
              <RoomDetail
                key={selectedRule.key}
                rule={selectedRule}
                onChanged={() => void refresh()}
                onDeleted={() => navigate("/hub")}
              />
            ) : (
              <div className="card p-12 text-center text-muted text-sm">{t("hub.page.selectRoomHint")}</div>
            )}
          </section>
        </div>
      )}

      <HubRuleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} rule={null} onSaved={() => void refresh()} />

      <WorkersPanel
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        workers={workers}
        status={workerStatus}
        onChanged={() => void refreshWorkers()}
      />
    </>
  );
}
