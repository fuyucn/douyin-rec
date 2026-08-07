import { Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { api, type WorkerDTO, type WorkerStatus } from "../api/client";
import { Button, IconButton } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { errMessage, useToast } from "../lib/hooks";
import { WorkerDialog } from "../modals/WorkerDialog";
import { useT } from "../lib/i18n";

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
          {workers.map((w) => (
            <div key={w.id} className="flex items-center gap-3 border border-transparent px-2 py-2.5 transition-colors hover:bg-surface-soft hover:border-hairline" style={{ borderRadius: "var(--r-card)" }}>
              <span className="dot shrink-0" style={{ background: dotColor(w) }} title={dotTitle(w)} />
              <div className="min-w-0 flex-1">
                <div className="font-medium text-ink truncate">{w.name}</div>
                <div className="font-mono text-[11px] text-muted-soft truncate">
                  {w.kind}{w.host ? ` · ${w.host}` : ""}
                </div>
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
