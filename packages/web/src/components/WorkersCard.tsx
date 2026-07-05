import { Pencil, Plus, Trash2, Wifi } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type WorkerDTO, type WorkerTestResult } from "../api/client";
import { Button, IconButton } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { WorkerDialog } from "../modals/WorkerDialog";
import { useT } from "../lib/i18n";

/** Hub 页顶部的 Workers 卡:录制节点列表(name/kind/host/连接状态)+ 增删改测。 */
export function WorkersCard(): ReactNode {
  const t = useT();
  const toast = useToast();
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [tests, setTests] = useState<Record<string, WorkerTestResult>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkerDTO | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      setWorkers(await api.listWorkers());
    } catch {
      /* 静默:轮询会重试 */
    } finally {
      setLoaded(true);
    }
  };
  usePolling(() => void refresh(), 3000);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (w: WorkerDTO): void => {
    setEditing(w);
    setDialogOpen(true);
  };

  const runTest = async (w: WorkerDTO): Promise<void> => {
    setTesting((t) => ({ ...t, [w.id]: true }));
    try {
      const result = await api.testWorker(w);
      setTests((t) => ({ ...t, [w.id]: result }));
    } catch (e) {
      setTests((t) => ({ ...t, [w.id]: { ok: false, reachable: false, dataRootExists: false, error: errMessage(e) } }));
    } finally {
      setTesting((t) => ({ ...t, [w.id]: false }));
    }
  };

  const doDelete = async (id: string): Promise<void> => {
    try {
      await api.deleteWorker(id);
      toast(t("hub.workers.deleted"), "info");
      await refresh();
    } catch (e) {
      toast(errMessage(e), "error");
    }
  };

  const dot = (w: WorkerDTO): string => {
    const r = tests[w.id];
    return !r ? "var(--muted-soft)" : r.ok ? "var(--success)" : "var(--error)";
  };

  return (
    <>
      <section className="card overflow-hidden mb-6">
        <div className="flex items-end justify-between gap-3 p-4 pb-2">
          <div>
            <h2 className="headline text-[18px] leading-tight">{t("hub.workers.title")}</h2>
            <p className="text-muted text-xs mt-1">{t("hub.workers.subtitle")}</p>
          </div>
          <Button small onClick={openCreate}>
            <Plus className="w-4 h-4" />
            {t("hub.workers.add")}
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th>{t("hub.workers.colName")}</th>
                <th>{t("hub.workers.colKind")}</th>
                <th>{t("hub.workers.colHost")}</th>
                <th>{t("hub.workers.colStatus")}</th>
                <th className="text-right">{t("hub.workers.colAction")}</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-8">{t("hub.common.loading")}</td>
                </tr>
              )}
              {loaded && workers.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-8">{t("hub.workers.empty")}</td>
                </tr>
              )}
              {loaded &&
                workers.map((w) => (
                  <tr key={w.id}>
                    <td>
                      <div className="font-medium text-ink">{w.name}</div>
                    </td>
                    <td>
                      <span className="font-mono text-xs text-muted">{w.kind}</span>
                    </td>
                    <td>
                      <span className="font-mono text-xs text-body">{w.host ?? "—"}</span>
                    </td>
                    <td>
                      <span className="dot" style={{ background: dot(w) }} />
                    </td>
                    <td className="text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2.5 justify-end">
                        <IconButton title={t("hub.workers.testConn")} onClick={() => void runTest(w)} disabled={testing[w.id]}>
                          <Wifi className="w-4 h-4" />
                        </IconButton>
                        <IconButton title={t("hub.common.edit")} onClick={() => openEdit(w)}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        {w.id !== "local" && (
                          <IconButton title={t("hub.common.delete")} style={{ color: "var(--error)" }} onClick={() => setPendingDelete(w.id)}>
                            <Trash2 className="w-4 h-4" />
                          </IconButton>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </section>

      <WorkerDialog open={dialogOpen} onClose={() => setDialogOpen(false)} worker={editing} onSaved={() => void refresh()} />

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
