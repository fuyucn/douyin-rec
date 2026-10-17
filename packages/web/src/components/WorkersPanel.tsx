import { GripVertical, Pencil, Plus, Trash2, X } from "lucide-react";
import { WarnGlyph } from "./WarnGlyph";
import { useEffect, useState, type ReactNode } from "react";
import { api, type WorkerDTO, type WorkerStatus } from "../api/client";
import { Button, IconButton } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { useDragReorder } from "../lib/dragReorder";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { WorkerDialog } from "../modals/WorkerDialog";

/** Workers 滑入浮层:录制节点列表(name/kind/host/实时状态点)+ 增删改。状态由父层轮询下发。 */
export function WorkersPanel({
  open,
  onClose,
  workers,
  status,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  workers: WorkerDTO[];
  status: Record<string, WorkerStatus>;
  onChanged: () => void;
}): ReactNode {
  const t = useT();
  const toast = useToast();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkerDTO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  /** master 自己的版本(T16 漂移对照的基准)。拉不到就不判漂移,不显示假告警。 */
  const [masterVersion, setMasterVersion] = useState<string>("");

  // T16:拿 master 版本作为对照基准。失败静默(没有基准就不判漂移)。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.getVersion()
      .then((r) => { if (alive) setMasterVersion(r.version.split("-")[0] ?? ""); })
      .catch(() => {});
    return () => { alive = false; };
  }, [open]);

  // Esc 关闭(仅 open 时挂监听)。
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (w: WorkerDTO): void => {
    setEditing(w);
    setDialogOpen(true);
  };
  const doDelete = async (id: string): Promise<void> => {
    try {
      await api.deleteWorker(id);
      toast(t("hub.workers.deleted"), "info");
      onChanged();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  // 三态:绿=ok / 红=fail / 灰=首次结果返回前(checking)。
  const dotColor = (w: WorkerDTO): string => {
    const s = status[w.id];
    return !s ? "var(--muted-soft)" : s.ok ? "var(--success)" : "var(--error)";
  };
  const dotTitle = (w: WorkerDTO): string => {
    const s = status[w.id];
    if (!s) return t("hub.workers.statusChecking");
    return s.ok ? t("hub.workers.statusOk") : (s.error ?? t("hub.workerDialog.unknownError"));
  };

  /**
   * 版本漂移提示(T16)。返回 null = 无告警。
   *
   * 两类漂移,严重度不同:
   *  - **bundle 版本不一致**(节点跑旧代码)→ 新字段/新语义在它上面不生效,是最危险的一类;
   *  - **期望版本未应用**(expected ≠ applied)→ 同步失败或滞后。
   * 只在能拿到数据时判断:拿不到(旧 bundle 没有 _node-status)就**不显示**,而不是报「未知」
   * —— 否则升级过程中满屏假告警。
   */
  const driftOf = (w: WorkerDTO): { text: string; warn: boolean } | null => {
    const s = status[w.id];
    if (!s?.ok) return null;
    if (!s.appVersion) return null;   // 旧 bundle 不回执 → 不判(避免假告警)
    if (masterVersion && s.appVersion.split("-")[0] !== masterVersion) {
      return { text: t("hub.workers.versionDrift", { node: s.appVersion, master: masterVersion }), warn: true };
    }
    if (s.expectedVersion != null && s.appliedVersion != null && s.expectedVersion !== s.appliedVersion) {
      return { text: t("hub.workers.syncLag", { applied: String(s.appliedVersion), expected: String(s.expectedVersion) }), warn: true };
    }
    return null;
  };

  // 拖拽排序:drop 后把完整 id 顺序 POST 回 hub.config.json(数组序 = 显示序)。
  const dnd = useDragReorder<WorkerDTO>({
    items: workers,
    keyOf: (w) => w.id,
    onCommit: async (ids) => {
      try {
        await api.reorderWorkers(ids);
        onChanged();
      } catch (e) {
        toast(errMessage(e), "error");
        onChanged();
      }
    },
  });

  return (
    <>
      {/* scrim:open 才可见/可点(点击关闭)。 */}
      <div
        className="modal-backdrop"
        style={{
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 0.18s ease",
        }}
        onClick={onClose}
      />
      {/* 右侧滑入面板 */}
      <aside
        className="fixed top-0 right-0 h-full w-[92vw] max-w-[420px] overflow-y-auto"
        style={{
          zIndex: 101,
          background: "var(--raised)",
          borderLeft: "1px solid var(--hairline)",
          boxShadow: "var(--shadow-slide)",
          transform: open ? "translateX(0)" : "translateX(100%)",
          transition: "transform 0.22s ease",
        }}
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div>
            <h2 className="headline text-[20px] leading-tight">{t("hub.workers.title")}</h2>
            <p className="text-muted text-xs mt-1 font-mono">{t("hub.workers.subtitle")}</p>
          </div>
          <IconButton title={t("hub.workers.close")} onClick={onClose}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        <div className="px-5 pb-3 flex items-center justify-between gap-3">
          <span className="section-label">{t("hub.workers.colName")}</span>
          <Button small onClick={openCreate}>
            <Plus className="w-4 h-4" />
            {t("hub.workers.add")}
          </Button>
        </div>

        <div className="px-3 pb-5 space-y-1">
          {workers.length === 0 && (
            <div className="text-center text-muted text-sm py-8 border border-dashed border-hairline" style={{ borderRadius: "var(--r-card)" }}>{t("hub.workers.empty")}</div>
          )}
          {dnd.ordered.map((w) => (
            <div
              key={w.id}
              className={`worker-row flex items-center gap-3 border border-transparent px-2 py-2.5 transition-colors hover:bg-surface-soft hover:border-hairline ${dnd.overKey === w.id && dnd.dragKey !== w.id ? "drag-over" : ""}`}
              style={{ borderRadius: "var(--r-card)", opacity: dnd.dragKey === w.id ? 0.5 : 1 }}
              {...dnd.itemProps(w.id)}
            >
              <span className="rail-grip" title={t("hub.common.dragTip")}><GripVertical className="w-3.5 h-3.5 shrink-0" /></span>
              <span className="dot shrink-0" style={{ background: dotColor(w) }} title={dotTitle(w)} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink truncate">{w.name}</div>
                <div className="font-mono text-[11px] text-muted-soft truncate">
                  {w.kind}{w.host ? ` · ${w.host}` : ""}
                  {/* T16:节点 bundle 版本。只有节点回了执才显示(旧 bundle 不回执 → 不显示,不造假信息)。 */}
                  {status[w.id]?.ok && status[w.id]?.appVersion ? ` · v${status[w.id]!.appVersion!.split("-")[0]}` : ""}
                </div>
                {(() => {
                  const d = driftOf(w);
                  if (!d) return null;
                  return (
                    <div className="text-[11px] mt-1" style={{ color: "var(--warning)" }} title={d.text}>
                      <WarnGlyph />{d.text}
                    </div>
                  );
                })()}
                {(() => {
                  // F2:磁盘剩余(旧 bundle/探测失败时没有该字段 → 不显示)。低于 master 水位标红。
                  const s = status[w.id];
                  if (!s?.ok || typeof s.diskFreeGB !== "number") return null;
                  const low = typeof s.diskMinGB === "number" && s.diskMinGB > 0 && s.diskFreeGB < s.diskMinGB;
                  return (
                    <div className="text-[11px] mt-1" style={{ color: low ? "var(--error-fg)" : "var(--muted-soft)" }}>
                      {low && <WarnGlyph />}{t("hub.workers.diskFree", { gb: s.diskFreeGB.toFixed(1) })}
                      {low ? ` · ${t("hub.workers.diskLow", { min: String(s.diskMinGB) })}` : ""}
                    </div>
                  );
                })()}
                {w.capabilities && w.capabilities.length > 0 && (
                  <div className="flex flex-wrap gap-1 mt-1">
                    {w.capabilities.map((c) => (
                      <span key={c} className="font-mono text-[10px] px-1.5 py-0.5 border border-hairline text-muted-soft" style={{ borderRadius: "var(--r-pill, 999px)" }}>{c}</span>
                    ))}
                  </div>
                )}
              </div>
              <div className="inline-flex items-center gap-2 shrink-0">
                <IconButton title={t("hub.common.edit")} onClick={() => openEdit(w)}>
                  <Pencil className="w-4 h-4" />
                </IconButton>
                {w.id !== "local" && (
                  <IconButton title={t("hub.common.delete")} style={{ color: "var(--error-fg)" }} onClick={() => setPendingDelete(w.id)}>
                    <Trash2 className="w-4 h-4" />
                  </IconButton>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>

      <WorkerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} worker={editing} onSaved={onChanged} />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={t("hub.workers.deleteConfirmTitle")}
        confirmLabel={t("hub.common.delete")}
        destructive
        onConfirm={() => {
          const id = pendingDelete;
          setPendingDelete(null);
          if (id !== null) void doDelete(id);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </>
  );
}
