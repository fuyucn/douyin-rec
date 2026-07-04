import { ChevronLeft, Pencil, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { api, type HubJobDTO, type HubRuleDTO } from "../api/client";
import { RunCard, JobLogDialog } from "../components/HubJobs";
import { Button, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Switch } from "../components/Switch";
import { HubRuleDialog } from "../modals/HubRuleDialog";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";

const PAGE = 20;

/** 后处理配置摘要(与列表页一致)。 */
function summarize(r: HubRuleDTO): string {
  const c = r.pipeline ?? {};
  const out = ["plain"];
  if (c.steps?.burnDanmu !== false) out.push("danmu");
  if (c.steps?.burnLivechat !== false) out.push("livechat");
  const up = c.upload?.mode === "upload" ? (c.upload.private === false ? " → 上传(公开)" : " → 上传(私)") : " → 仅合成(stage)";
  return out.join(" + ") + up;
}

/**
 * hub 任务详情页(/hub/:key):某直播间的规则配置 + 历次 run。
 * 上半配置卡(pipeline 摘要 / 启用开关 / 编辑 / 删除),下半运行记录(分页,进行中 3s 轮询)。
 */
export function HubDetailPage(): ReactNode {
  const { key = "" } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [rule, setRule] = useState<HubRuleDTO | null>(null);
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
  usePolling(() => void refresh(), anyActive ? 3000 : 15000);

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
      toast("Hub 规则已删除", "info");
      navigate("/hub");
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const title = rule?.anchorName ?? (rule ? roomId(rule.room) : key);

  return (
    <>
      <div className="mb-6">
        <Link to="/hub" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-2">
          <ChevronLeft className="w-4 h-4" /> Hub 管理
        </Link>
        <h1 className="headline text-[26px] sm:text-[30px] leading-tight">{title}</h1>
        <p className="text-muted text-sm mt-1.5 font-mono break-all">{key}</p>
      </div>

      {/* 配置卡 */}
      {rule && (
        <section className="card p-5 mb-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-ink mb-2">后处理配置</h2>
              <div className="font-mono text-[13px] text-body break-all">{summarize(rule)}</div>
              <div className="flex items-center gap-1.5 text-[13px] mt-2">
                <span className="dot" style={{ background: rule.enabled ? "var(--success)" : "var(--muted-soft)" }} />
                <span style={{ color: rule.enabled ? "var(--success)" : "var(--muted)" }}>
                  {rule.enabled ? "启用中" : "已暂停"}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2.5 shrink-0">
              <Switch checked={rule.enabled} onCheckedChange={() => void toggle()} name={`hub-detail-${rule.key}`} />
              <IconButton title="编辑" onClick={() => setEditOpen(true)}>
                <Pencil className="w-4 h-4" />
              </IconButton>
              <IconButton title="删除" style={{ color: "var(--error)" }} onClick={() => setConfirmDelete(true)}>
                <Trash2 className="w-4 h-4" />
              </IconButton>
            </div>
          </div>
        </section>
      )}

      {/* 运行记录 */}
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-ink">运行记录</h2>
        <span className="text-[12px] text-muted-soft">共 {total} 次</span>
      </div>
      {!loaded ? (
        <div className="card p-10 text-center text-muted">加载中…</div>
      ) : runs.length === 0 ? (
        <div className="card p-10 text-center text-muted text-sm">
          该直播间还没有 hub 运行记录(录制并收播后自动产生)。
        </div>
      ) : (
        <div className="space-y-3">
          {runs.map((j) => (
            <RunCard key={j.streamKey} job={j} onOpenLog={setLogKey} />
          ))}
          {runs.length < total && (
            <div className="text-center pt-2">
              <Button small variant="secondary" onClick={() => setPages((p) => p + 1)}>
                加载更多（还有 {total - runs.length} 次）
              </Button>
            </div>
          )}
        </div>
      )}

      <HubRuleDialog open={editOpen} onClose={() => setEditOpen(false)} rule={rule} onSaved={() => void refresh()} />
      <JobLogDialog logKey={logKey} onClose={() => setLogKey(null)} />
      <ConfirmDialog
        open={confirmDelete}
        title="删除该 Hub 规则?"
        confirmLabel="删除"
        destructive
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
