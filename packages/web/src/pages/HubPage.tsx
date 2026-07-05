import { ChevronRight, ListChecks, Network, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { useAtomValue } from "jotai";
import { api, type HubRuleDTO, type HubJobDTO } from "../api/client";
import { hubEnabledAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Switch } from "../components/Switch";
import { LatestRunBadge } from "../components/HubJobs";
import { WorkersCard } from "../components/WorkersCard";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { useT } from "../lib/i18n";

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 后处理 step 摘要(产哪些 + 上传模式),给列表一眼看清。 */
function summarize(r: HubRuleDTO, t: TFunc): string {
  const c = r.pipeline ?? {};
  const out: string[] = ["plain"];
  if (c.steps?.burnDanmu !== false) out.push("danmu");
  if (c.steps?.burnLivechat !== false) out.push("livechat");
  const up = c.upload?.mode === "upload" ? (c.upload.private === false ? t("hub.common.uploadPublicSuffix") : t("hub.common.uploadPrivateSuffix")) : "";
  return out.join(" + ") + up;
}

/** Hub 管理页(/hub):全局管理器,按直播间配置多节点后处理规则(独立于录制任务)。 */
export function HubPage(): ReactNode {
  const t = useT();
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const toast = useToast();
  const [rules, setRules] = useState<HubRuleDTO[]>([]);
  const [jobs, setJobs] = useState<HubJobDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<HubRuleDTO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setRules(await api.listHubRules());
    } catch {
      /* 静默:轮询会重试 */
    } finally {
      setLoaded(true);
    }
    // hub 任务(运行态)单独拉,失败静默(不阻塞规则展示)。
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

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (r: HubRuleDTO): void => {
    setEditing(r);
    setDialogOpen(true);
  };

  const toggle = async (r: HubRuleDTO): Promise<void> => {
    try {
      await api.updateHubRule(r.key, { enabled: !r.enabled });
      await refresh();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const doDelete = async (slug: string): Promise<void> => {
    try {
      await api.deleteHubRule(slug);
      toast(t("hub.common.ruleDeleted"), "info");
      await refresh();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  // 本节点不是 master(未启用 hub)→ 不显示规则管理,提示这是 child node。
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

  return (
    <>
      <div className="flex items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">{t("hub.page.title")}</h1>
          <p className="text-muted text-sm mt-1.5">{t("hub.page.subtitle")}</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4" />
          {t("hub.page.newRule")}
        </Button>
      </div>

      <WorkersCard />

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th>{t("hub.page.colRoom")}</th>
                <th>{t("hub.page.colOutput")}</th>
                <th>{t("hub.page.colLastRun")}</th>
                <th>{t("hub.page.colStatus")}</th>
                <th className="text-right">{t("hub.page.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-12">{t("hub.common.loading")}</td>
                </tr>
              )}
              {loaded && rules.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-16">
                    <div className="flex flex-col items-center gap-4 text-muted">
                      <Radio className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
                      <div className="text-sm font-medium text-ink">{t("hub.page.noRules")}</div>
                      <Button small onClick={openCreate}>{t("hub.page.newRule")}</Button>
                    </div>
                  </td>
                </tr>
              )}
              {loaded &&
                rules.map((r) => (
                  <tr key={r.key}>
                    <td>
                      <Link to={`/hub/${encodeURIComponent(r.key)}`} className="hover:opacity-70">
                        {r.anchorName ? (
                          <>
                            <div className="font-medium text-ink">{r.anchorName}</div>
                            <div className="font-mono text-xs text-muted mt-0.5 break-all">{roomId(r.room)}</div>
                          </>
                        ) : (
                          <div className="font-mono text-[13px] font-medium text-ink break-all">{roomId(r.room)}</div>
                        )}
                      </Link>
                    </td>
                    <td>
                      <span className="font-mono text-[13px] text-body">{summarize(r, t)}</span>
                    </td>
                    <td>
                      {(() => {
                        const runs = runsOf(r);
                        return (
                          <Link
                            to={`/hub/${encodeURIComponent(r.key)}`}
                            className="inline-flex items-center gap-1.5 hover:opacity-70"
                            title={t("hub.page.viewRuns")}
                          >
                            <LatestRunBadge run={runs[0]} />
                            {runs.length > 0 && (
                              <span className="inline-flex items-center gap-0.5 text-[11px] text-muted-soft">
                                <ListChecks className="w-3 h-3" />
                                {runs.length}
                              </span>
                            )}
                            <ChevronRight className="w-3.5 h-3.5 text-muted-soft" />
                          </Link>
                        );
                      })()}
                    </td>
                    <td>
                      {/* 只读状态显示(不再点击切换,避免误操作)。 */}
                      <span className="inline-flex items-center gap-1.5 text-[13px]">
                        <span className="dot" style={{ background: r.enabled ? "var(--success)" : "var(--muted-soft)" }} />
                        <span style={{ color: r.enabled ? "var(--success)" : "var(--muted)" }}>
                          {r.enabled ? t("hub.common.enabledState") : t("hub.common.disabledState")}
                        </span>
                      </span>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2.5 justify-end">
                        {/* 启用/暂停:专门的开关控件(刻意操作,不与状态显示混淆)。 */}
                        <Switch checked={r.enabled} onCheckedChange={() => void toggle(r)} name={`hub-${r.key}`} />
                        <IconButton title={t("hub.common.edit")} onClick={() => openEdit(r)}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setPendingDelete(r.key)}>
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

      <HubRuleDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        rule={editing}
        onSaved={() => void refresh()}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("hub.common.deleteRuleConfirmTitle")}
        confirmLabel={t("hub.common.delete")}
        destructive
        onConfirm={() => {
          const slug = pendingDelete;
          setPendingDelete(null);
          if (slug !== null) void doDelete(slug);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
