import { Activity, Plus, Radio, Server } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAtomValue } from "jotai";
import { api, type HubRuleDTO, type HubJobDTO, type WorkerDTO, type WorkerStatus } from "../api/client";
import { hubEnabledAtom } from "../atoms";
import { Button } from "../components/Button";
import { LatestRunBadge } from "../components/HubJobs";
import { RoomDetail } from "../components/RoomDetail";
import { WorkersPanel } from "../components/WorkersPanel";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { useT } from "../lib/i18n";
import { Network } from "lucide-react";

/** Hub 管理页(/hub 与 /hub/:key 共用):左房间列表 + 右详情(RoomDetail)。 */
export function HubPage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const { key } = useParams<{ key?: string }>();
  const navigate = useNavigate();
  const [rules, setRules] = useState<HubRuleDTO[]>([]);
  const [jobs, setJobs] = useState<HubJobDTO[]>([]);
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
    try {
      setJobs((await api.listHubJobs()).jobs);
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
  const runsOf = (r: HubRuleDTO): HubJobDTO[] => {
    const prefix = `${r.platform}:${r.roomSlug}:`;
    return jobs.filter((j) => j.streamKey.startsWith(prefix));
  };

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
  const selectedKey = key && rules.some((r) => r.key === key) ? key : rules[0]?.key;
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
  const activeRuns = jobs.filter((j) => !["done", "failed", "needs_manual"].includes(j.state)).length;

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
          {/* 左:房间列表 */}
          <aside className="lg:pr-2">
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
                {rules.map((r) => {
                  const active = r.key === selectedKey;
                  return (
                    <button
                      key={r.key}
                      onClick={() => selectRoom(r)}
                      className={`rail-item ${active ? "rail-item-active" : ""}`}
                      style={{ opacity: r.enabled ? 1 : 0.55 }}
                    >
                      <div className="min-w-0">
                        {r.anchorName ? (
                          <>
                            <div className="font-medium text-ink truncate">{r.anchorName}</div>
                            <div className="font-mono text-[11px] text-muted-soft mt-0.5 truncate">{roomId(r.room)}</div>
                          </>
                        ) : (
                          <div className="font-mono text-[13px] font-medium text-ink truncate">{roomId(r.room)}</div>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="dot" style={{ background: r.enabled ? "var(--success)" : "var(--muted-soft)" }} />
                        <LatestRunBadge run={runsOf(r)[0]} />
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          {/* 右:选中房间详情 */}
          <section className="min-w-0">
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
