import { Plus, Radio } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useAtomValue } from "jotai";
import { api, type HubRuleDTO, type HubJobDTO } from "../api/client";
import { hubEnabledAtom } from "../atoms";
import { Button } from "../components/Button";
import { LatestRunBadge } from "../components/HubJobs";
import { RoomDetail } from "../components/RoomDetail";
import { WorkersCard } from "../components/WorkersCard";
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

  return (
    <>
      <div className="flex items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("hub.page.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("hub.page.subtitle")}</p>
        </div>
        <Button onClick={() => setDialogOpen(true)}>
          <Plus className="w-4 h-4" />
          {t("hub.page.newRule")}
        </Button>
      </div>

      {/* Task 2 会把 WorkersCard 移入浮层;本任务先原样保留,保功能不断。 */}
      <WorkersCard />

      {loaded && rules.length === 0 ? (
        <section className="card p-16">
          <div className="flex flex-col items-center gap-4 text-muted">
            <Radio className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
            <div className="text-sm font-medium text-ink">{t("hub.page.noRules")}</div>
            <Button small onClick={() => setDialogOpen(true)}>{t("hub.page.newRule")}</Button>
          </div>
        </section>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-[288px_1fr] gap-6 items-start">
          {/* 左:房间列表 */}
          <aside className="card p-2 space-y-1">
            <div className="px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-soft">
              {t("hub.page.roomsHeading")}
            </div>
            {!loaded && <div className="px-2 py-3 text-sm text-muted">{t("hub.common.loading")}</div>}
            {rules.map((r) => {
              const active = r.key === selectedKey;
              return (
                <button
                  key={r.key}
                  onClick={() => selectRoom(r)}
                  className="w-full text-left rounded-lg px-3 py-2.5 flex flex-col gap-1 transition-colors"
                  style={{
                    borderLeft: `3px solid ${active ? "var(--ink)" : "transparent"}`,
                    background: active ? "var(--surface-soft)" : "transparent",
                    opacity: r.enabled ? 1 : 0.55,
                  }}
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
              <div className="card p-16 text-center text-muted text-sm">{t("hub.page.selectRoomHint")}</div>
            )}
          </section>
        </div>
      )}

      <HubRuleDialog open={dialogOpen} onClose={() => setDialogOpen(false)} rule={null} onSaved={() => void refresh()} />
    </>
  );
}
