import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type WorkerDTO, type WorkerTestResult } from "../api/client";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { errMessage, useToast } from "../lib/hooks";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = create mode; a worker = edit that worker (id fixed). */
  worker: WorkerDTO | null;
  onSaved: () => void;
}

interface FormState {
  name: string;
  kind: string;
  host: string;
  dataRoot: string;
}

const BLANK: FormState = { name: "", kind: "ssh", host: "", dataRoot: "" };
const KINDS = ["local", "ssh", "tailscale-ssh"] as const;

/** Worker(录制节点)的创建/编辑弹窗:kind 决定要不要 host;存前可测试连接。 */
export function WorkerDialog({ open, onClose, worker, onSaved }: Props): ReactNode {
  const isEdit = worker !== null;
  const isLocal = worker?.id === "local";
  const toast = useToast();
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<WorkerTestResult | null>(null);

  useEffect(() => {
    if (open) {
      setForm(
        worker
          ? { name: worker.name ?? "", kind: worker.kind, host: worker.host ?? "", dataRoot: worker.dataRoot ?? "" }
          : BLANK,
      );
      setTest(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, worker?.id]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]): void => setForm((f) => ({ ...f, [k]: v }));
  const needsHost = form.kind === "ssh" || form.kind === "tailscale-ssh";
  const payload = (): Partial<WorkerDTO> => ({
    name: form.name.trim() || undefined,
    kind: form.kind,
    host: needsHost ? form.host.trim() : undefined,
    dataRoot: form.dataRoot.trim(),
  });

  async function runTest(): Promise<void> {
    setTesting(true);
    try {
      setTest(await api.testWorker(payload()));
    } catch (e) {
      setTest({ ok: false, reachable: false, dataRootExists: false, error: errMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setBusy(true);
    try {
      if (isEdit) await api.updateWorker(worker.id, payload());
      else await api.createWorker(payload());
      onClose();
      toast(isEdit ? "Worker 已更新" : "Worker 已创建", "success");
      onSaved();
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-lg"
      title={isEdit ? "编辑 Worker" : "新建 Worker"}
      description="录制节点(选优合并的数据来源)"
    >
      <form className="grid grid-cols-1 gap-4" onSubmit={submit}>
        {isEdit && (
          <div className="text-xs text-muted-soft font-mono break-all">id: {worker.id}</div>
        )}
        <div>
          <label className="field-label">名称 / name</label>
          <input
            className="input"
            placeholder="友好名(留空则用 host)"
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div>
          <label className="field-label">类型 / kind</label>
          <select className="input" value={form.kind} disabled={isLocal} onChange={(e) => set("kind", e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {isLocal && <div className="text-xs text-muted mt-1">master 自身,类型不可改</div>}
        </div>
        {needsHost && (
          <div>
            <label className="field-label">
              host<span style={{ color: "var(--error)" }}>*</span>
            </label>
            <input
              required
              className="input"
              placeholder="100.x.y.z 或 host.ts.net"
              value={form.host}
              onChange={(e) => set("host", e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="field-label">
            dataRoot<span style={{ color: "var(--error)" }}>*</span>
          </label>
          <input
            required
            className="input"
            placeholder="/home/ubuntu/drec 或 /data"
            value={form.dataRoot}
            onChange={(e) => set("dataRoot", e.target.value)}
          />
        </div>
        {test && (
          <div
            className="text-sm rounded-lg border border-hairline px-3 py-2"
            style={{ color: test.ok ? "var(--success)" : "var(--error)" }}
          >
            {test.ok ? `连接成功 · 可见 ${test.recordingCount ?? 0} 场录制` : `连接失败:${test.error ?? "未知错误"}`}
          </div>
        )}
        <div className="flex justify-between gap-3 mt-2">
          <Button type="button" variant="secondary" onClick={() => void runTest()} disabled={testing} loading={testing}>
            测试连接
          </Button>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onClose}>
              取消
            </Button>
            <Button type="submit" disabled={busy} loading={busy}>
              {isEdit ? "保存" : "创建"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
