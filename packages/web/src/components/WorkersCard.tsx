import { Pencil, Plus, Trash2, Wifi } from "lucide-react";
import { useState, type ReactNode } from "react";
import { api, type WorkerDTO, type WorkerTestResult } from "../api/client";
import { Button, IconButton } from "./Button";
import { ConfirmDialog } from "./ConfirmDialog";
import { errMessage, useToast, usePolling } from "../lib/hooks";
import { WorkerDialog } from "../modals/WorkerDialog";

/** Hub 页顶部的 Workers 卡:录制节点列表(name/kind/host/连接状态)+ 增删改测。 */
export function WorkersCard(): ReactNode {
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
      toast("Worker 已删除", "info");
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
            <h2 className="headline text-[18px] leading-tight">Workers / 录制节点</h2>
            <p className="text-muted text-xs mt-1">选优合并的数据来源,local = master 自身。</p>
          </div>
          <Button small onClick={openCreate}>
            <Plus className="w-4 h-4" />
            添加 Worker
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="tasks">
            <thead>
              <tr>
                <th>名称</th>
                <th>类型</th>
                <th>host</th>
                <th>状态</th>
                <th className="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-8">加载中…</td>
                </tr>
              )}
              {loaded && workers.length === 0 && (
                <tr>
                  <td colSpan={5} className="text-center text-muted py-8">还没有 Worker</td>
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
                        <IconButton title="测试连接" onClick={() => void runTest(w)} disabled={testing[w.id]}>
                          <Wifi className="w-4 h-4" />
                        </IconButton>
                        <IconButton title="编辑" onClick={() => openEdit(w)}>
                          <Pencil className="w-4 h-4" />
                        </IconButton>
                        {w.id !== "local" && (
                          <IconButton title="删除" style={{ color: "var(--error)" }} onClick={() => setPendingDelete(w.id)}>
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
        title="删除该 Worker?"
        confirmLabel="删除"
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
