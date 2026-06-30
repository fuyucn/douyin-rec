import { Network, Pencil, Plus, Radio, Trash2 } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { api, type HubRuleDTO } from "../api/client";
import { hubEnabledAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { roomId } from "../lib/labels";
import { HubRuleDialog } from "../modals/HubRuleDialog";

/** 后处理 step 摘要(产哪些 + 上传模式),给列表一眼看清。 */
function summarize(r: HubRuleDTO): string {
  const c = r.pipeline ?? {};
  const out: string[] = ["plain"];
  if (c.steps?.burnDanmu !== false) out.push("danmu");
  if (c.steps?.burnLivechat !== false) out.push("livechat");
  const up = c.upload?.mode === "upload" ? (c.upload.private === false ? " → 上传(公开)" : " → 上传(私)") : "";
  return out.join(" + ") + up;
}

/** Hub 管理页(/hub):全局管理器,按直播间配置多节点后处理规则(独立于录制任务)。 */
export function HubPage(): ReactNode {
  const hubEnabled = useAtomValue(hubEnabledAtom);
  const toast = useToast();
  const [rules, setRules] = useState<HubRuleDTO[]>([]);
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
  };
  usePolling(() => void refresh(), 4000);

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
      toast("Hub 规则已删除", "info");
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
        <h1 className="headline text-[22px]">这是 child node(从节点)</h1>
        <p className="text-muted text-sm max-w-md">
          本节点未启用 hub(以 <code>task serve</code> 运行,无 <code>--hub</code>)。
          多节点选优合并 / 上传由 <b>master 节点</b>统一编排;Hub 规则只在 master 上配置与生效。
          本节点只负责录制 + 供 master 拉取。
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="flex items-end justify-between gap-3 mb-6">
        <div>
          <h1 className="headline text-[28px] sm:text-[32px] leading-tight">Hub 管理</h1>
          <p className="text-muted text-sm mt-1.5">多节点选优合并 → 烧录 → 上传。按直播间配置,独立于录制任务。</p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4" />
          新建规则
        </Button>
      </div>

      <section className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th>直播间</th>
                <th>产物 / 上传</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr>
                  <td colSpan={4} className="text-center text-muted py-12">加载中…</td>
                </tr>
              )}
              {loaded && rules.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-16">
                    <div className="flex flex-col items-center gap-4 text-muted">
                      <Radio className="w-10 h-10" style={{ color: "var(--muted-soft)" }} />
                      <div className="text-sm font-medium text-ink">还没有 Hub 规则</div>
                      <Button small onClick={openCreate}>新建规则</Button>
                    </div>
                  </td>
                </tr>
              )}
              {loaded &&
                rules.map((r) => (
                  <tr key={r.key}>
                    <td>
                      {r.anchorName ? (
                        <>
                          <div className="font-medium text-ink">{r.anchorName}</div>
                          <div className="font-mono text-xs text-muted mt-0.5 break-all">{roomId(r.room)}</div>
                        </>
                      ) : (
                        <div className="font-mono text-[13px] font-medium text-ink break-all">{roomId(r.room)}</div>
                      )}
                    </td>
                    <td>
                      <span className="font-mono text-[13px] text-body">{summarize(r)}</span>
                    </td>
                    <td>
                      <button
                        type="button"
                        className="badge"
                        style={{
                          background: r.enabled ? "var(--success-soft, var(--surface-soft))" : "var(--surface-soft)",
                          color: r.enabled ? "var(--success)" : "var(--muted)",
                          cursor: "pointer",
                        }}
                        onClick={() => void toggle(r)}
                        title="点击切换启用/暂停"
                      >
                        {r.enabled ? "启用中" : "已暂停"}
                      </button>
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5 justify-end">
                        <IconButton title="编辑" onClick={() => openEdit(r)}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        <IconButton title="删除" style={{ color: "var(--error)" }} onClick={() => setPendingDelete(r.key)}>
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
        title="删除该 Hub 规则?"
        confirmLabel="删除"
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
