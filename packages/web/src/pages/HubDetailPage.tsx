import { ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type HubJobDTO, type HubRuleDTO, type WorkerDTO } from "../api/client";
import { RunCard, JobLogDialog } from "../components/HubJobs";
import { Button, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Switch } from "../components/Switch";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { useT } from "../lib/i18n";

const PAGE = 20;

type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 后处理配置摘要(与列表页一致)。 */
function summarize(r: HubRuleDTO, t: TFunc): string {
  const c = r.pipeline ?? {};
  const out = ["plain"];
  if (c.steps?.burnDanmu !== false) out.push("danmu");
  if (c.steps?.burnLivechat !== false) out.push("livechat");
  const up = c.upload?.mode === "upload" ? (c.upload.private === false ? t("hub.common.uploadPublicSuffix") : t("hub.common.uploadPrivateSuffix")) : t("hub.common.stageOnlySuffix");
  return out.join(" + ") + up;
}

/**
 * hub 任务详情页(/hub/:key):某直播间的规则配置 + 历次 run。
 * 上半配置卡(pipeline 摘要 / 启用开关 / 编辑 / 删除),下半运行记录(分页,进行中 3s 轮询)。
 */
export function HubDetailPage(): ReactNode {
  const t = useT();
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [rule, setRule] = useState<HubRuleDTO | null>(null);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [runs, setRuns] = useState<HubJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      const rules = await api.listHubRules();
      setRule(rules.find((r) => r.key === key) ?? null);
    } catch {
      /* 轮询重试 */
    }
    try {
      setWorkers(await api.listWorkers());
    } catch {
      /* 忽略:workerName 回落展示 id */
    }
    try {
      const r = await api.listHubJobs({ room: key, limit: pages * PAGE, offset: 0 });
      setRuns(r.jobs);
      setTotal(r.total);
    } catch {
      /* 忽略 */
    } finally {
      setLoaded(true);
    }
  };
  const anyActive = runs.some((j) => !["done", "failed", "needs_manual"].includes(j.state));
  // 有进行中的 run → 3s;空闲也保持 5s(否则新 run 出现/首步进度最多滞后 15s,像「没实时更新」)。
  usePolling(() => void refresh(), anyActive ? 3000 : 5000);

  const toggle = async (): Promise<void> => {
    if (!rule) return;
    try {
      await api.updateHubRule(rule.key, { enabled: !rule.enabled });
      await refresh();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const doDelete = async (): Promise<void> => {
    setConfirmDelete(false);
    try {
      await api.deleteHubRule(key);
      toast(t("hub.common.ruleDeleted"), "info");
      navigate("/hub");
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const title = rule?.anchorName ?? (rule ? roomId(rule.room) : key);
  const workerName = (id: string): string => workers.find((w) => w.id === id)?.name ?? id;

  return (
    <>
      <div className="mb-6">
        <Link to="/hub" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-2">
          <ChevronLeft className="w-4 h-4" /> {t("hub.page.title")}
        </Link>
        <h1 className="headline text-[26px] sm:text-[30px] leading-tight">{title}</h1>
        <p className="text-muted text-sm mt-1.5 font-mono break-all">{key}</p>
      </div>

      {/* 配置卡 */}
      {rule && (
        <section className="card p-5 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink mb-2">{t("hub.detail.pipelineConfig")}</h2>
              <div className="font-mono text-[13px] text-body break-all">{summarize(rule, t)}</div>
              <div className="flex items-center gap-1.5 text-[13px] mt-2">
                <span className="dot" style={{ background: rule.enabled ? "var(--success)" : "var(--muted-soft)" }} />
                <span style={{ color: rule.enabled ? "var(--success)" : "var(--muted)" }}>
                  {rule.enabled ? t("hub.common.enabledState") : t("hub.common.disabledState")}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Switch checked={rule.enabled} onCheckedChange={() => void toggle()} name={`hub-detail-${rule.key}`} />
              <IconButton title={t("hub.common.edit")} onClick={() => setEditOpen(true)}>
                <Pencil className="w-4 h-4" />
              </IconButton>
              <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
        </section>
      )}

      {/* 运行记录 */}
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">{t("hub.detail.runsHeading")}</h2>
        <span className="text-[12px] text-muted-soft">{t("hub.detail.totalRuns", { count: total })}</span>
      </div>
      {!loaded ? (
        <div className="card p-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : runs.length === 0 ? (
        <div className="card p-10 text-center text-muted text-sm">
          {t("hub.detail.noRuns")}
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((j) => (
            <RunCard key={j.streamKey} job={j} onOpenLog={setLogKey} workerName={workerName} />
          ))}
          {runs.length < total && (
            <div className="text-center pt-2">
              <Button small variant="secondary" onClick={() => setPages((p) => p + 1)}>
                {t("hub.detail.loadMore", { count: total - runs.length })}
              </Button>
            </div>
          )}
        </div>
      )}

      <HubRuleDialog open={editOpen} onClose={() => setEditOpen(false)} rule={rule} onSaved={() => void refresh()} />
      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
      <ConfirmDialog
        open={confirmDelete}
        title={t("hub.common.deleteRuleConfirmTitle")}
        confirmLabel={t("hub.common.delete")}
        destructive
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
