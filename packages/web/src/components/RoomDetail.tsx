import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { api, type HubJobDTO, type HubRuleDTO, type WorkerDTO } from "../api/client";
import { RunCard, JobLogDialog } from "./HubJobs";
import { Button, IconButton } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { Switch } from "./Switch";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { useT } from "../lib/i18n";
import type { FlowCfg } from "./flow-build";

const PAGE = 20;
type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** 产物 chips(plain 恒有;danmu/livechat 默认开,仅显式 false 才去掉)。 */
function outputChips(r: HubRuleDTO): string[] {
  const c = r.pipeline ?? {};
  const out = ["plain"];
  if (c.steps?.burnDanmu !== false) out.push("danmu");
  if (c.steps?.burnLivechat !== false) out.push("livechat");
  return out;
}
/** 上传模式 chip 文案。 */
function uploadChip(r: HubRuleDTO, t: TFunc): string {
  const c = r.pipeline ?? {};
  if (c.upload?.mode === "upload") return c.upload.private === false ? t("hub.detail.chipUploadPublic") : t("hub.detail.chipUploadPrivate");
  return t("hub.detail.chipStageOnly");
}

const chipCls = "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-mono";
const chipStyle = { background: "var(--surface-soft)", color: "var(--body)", border: "1px solid var(--hairline)" } as const;
/** 统一的分区小标签:muted + 大写 + 字距,替代粗黑标题,营造层次而非盒中盒。 */
const sectionLabel = "text-[11px] font-medium uppercase tracking-[0.07em] text-muted-soft";

/** 右详情 pane:某直播间的房间头 + 配置/worker chips + 最近(或选中)run 完整 PipelineFlow + 运行记录列表。 */
export function RoomDetail({
  rule,
  onChanged,
  onDeleted,
}: {
  rule: HubRuleDTO;
  onChanged: () => void;
  onDeleted: () => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [runs, setRuns] = useState<HubJobDTO[]>([]);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [pages, setPages] = useState(1);
  const [logKey, setLogKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = async (): Promise<void> => {
    try {
      setWorkers(await api.listWorkers());
    } catch {
      /* 忽略:workerName 回落展示 id */
    }
    try {
      const r = await api.listHubJobs({ room: rule.key, limit: pages * PAGE, offset: 0 });
      setRuns(r.jobs);
      setTotal(r.total);
    } catch {
      /* 轮询重试 */
    } finally {
      setLoaded(true);
    }
  };
  const anyActive = runs.some((j) => !["done", "failed", "needs_manual"].includes(j.state));
  // 有进行中的 run → 3s;空闲 5s(与原 HubDetailPage 一致,避免像「没实时更新」)。
  usePolling(() => void refresh(), anyActive ? 3000 : 5000);

  // 稳定引用(仅 workers 变化时才换):PipelineFlow memo 用它比较,防每帧新引用击穿 memo。
  const workerName = useCallback((id: string): string => workers.find((w) => w.id === id)?.name ?? id, [workers]);
  // 展开的 run:默认最近一次(runs[0])展开;点击行展开/收起该行自己的 PipelineFlow。
  // expandedKey===null → 用默认(首条);===""(哨兵)→ 全收起;其它 → 展开那条。
  const defaultKey = runs[0]?.streamKey;
  const isExpanded = (k: string): boolean => (expandedKey === null ? k === defaultKey : k === expandedKey);
  const toggleRun = (k: string): void =>
    setExpandedKey((prev) => ((prev === null ? defaultKey : prev) === k ? "" : k));

  const toggle = async (): Promise<void> => {
    try {
      await api.updateHubRule(rule.key, { enabled: !rule.enabled });
      onChanged();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };
  const doDelete = async (): Promise<void> => {
    setConfirmDelete(false);
    try {
      await api.deleteHubRule(rule.key);
      toast(t("hub.common.ruleDeleted"), "info");
      onDeleted();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  // 参与 worker:rule.workers 有值=选中的这些;缺省/空=全部节点。
  const participating = rule.workers && rule.workers.length > 0 ? rule.workers.map(workerName) : null;

  return (
    <>
      {/* 房间头 */}
      <div className="flex items-start justify-between gap-4 mb-6">
        <div className="min-w-0">
          <h2 className="headline text-[22px] sm:text-[24px] leading-tight truncate">
            {rule.anchorName ?? roomId(rule.room)}
          </h2>
          <p className="text-muted-soft text-[13px] mt-1 font-mono break-all">{rule.platform} · {roomId(rule.room)}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Switch checked={rule.enabled} onCheckedChange={() => void toggle()} name={`hub-detail-${rule.key}`} />
          <IconButton title={t("hub.common.edit")} onClick={() => setEditOpen(true)}>
            <Pencil className="w-4 h-4" />
          </IconButton>
          <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setConfirmDelete(true)}>
            <Trash2 className="w-4 h-4" />
          </IconButton>
        </div>
      </div>

      {/* 配置 + 参与 worker:并排 label+chips,无盒中盒 */}
      <div className="flex flex-wrap items-start gap-x-12 gap-y-4">
        <div>
          <div className={`${sectionLabel} mb-2`}>{t("hub.detail.pipelineConfig")}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {outputChips(rule).map((c) => (
              <span key={c} className={chipCls} style={chipStyle}>{c}</span>
            ))}
            <span className="text-muted-soft text-xs">→</span>
            <span className={chipCls} style={chipStyle}>{uploadChip(rule, t)}</span>
          </div>
        </div>
        <div>
          <div className={`${sectionLabel} mb-2`}>{t("hub.detail.workersLabel")}</div>
          <div className="flex flex-wrap items-center gap-1.5">
            {participating === null ? (
              <span className={chipCls} style={chipStyle}>{t("hub.detail.allWorkers")}</span>
            ) : (
              participating.map((n, i) => (
                <span key={i} className={chipCls} style={chipStyle}>{n}</span>
              ))
            )}
          </div>
        </div>
      </div>

      {/* 运行记录列表:每条 run 可展开显示它自己的完整 PipelineFlow(默认展开最近一次) */}
      <div className="mt-6 pt-6 border-t border-hairline flex items-baseline justify-between mb-3">
        <h3 className={sectionLabel}>{t("hub.detail.runsHeading")}</h3>
        <span className="text-[12px] text-muted-soft">{t("hub.detail.totalRuns", { count: total })}</span>
      </div>
      {!loaded ? (
        <div className="py-10 text-center text-muted">{t("hub.common.loading")}</div>
      ) : runs.length === 0 ? (
        <div className="py-10 text-center text-muted-soft text-sm">{t("hub.detail.noRuns")}</div>
      ) : (
        <div className="divide-y divide-hairline">
          {runs.map((j) => (
            <RunCard
              key={j.streamKey}
              job={j}
              onOpenLog={setLogKey}
              workerName={workerName}
              cfg={rule.pipeline as FlowCfg}
              expanded={isExpanded(j.streamKey)}
              onToggle={toggleRun}
            />
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

      <HubRuleDialog open={editOpen} onClose={() => setEditOpen(false)} rule={rule} onSaved={() => { onChanged(); void refresh(); }} />
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
