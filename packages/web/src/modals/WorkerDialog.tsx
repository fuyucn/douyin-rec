import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type WorkerDTO, type WorkerTestResult } from "../api/client";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";

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
  /** 逗号分隔的能力标签(存前 trim + 去重)。 */
  capabilities: string;
}

const BLANK: FormState = { name: "", kind: "ssh", host: "", dataRoot: "", capabilities: "" };
const KINDS = ["local", "ssh", "tailscale-ssh"] as const;

/** "a, b ,,c" → ["a","b","c"](trim + 去空 + 去重,保序)。 */
function parseCaps(s: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of s.split(",")) {
    const c = raw.trim();
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

/** Worker(录制节点)的创建/编辑弹窗:kind 决定要不要 host;存前可测试连接。 */
export function WorkerDialog({ open, onClose, worker, onSaved }: Props): ReactNode {
  const isEdit = worker !== null;
  const isLocal = worker?.id === "local";
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<WorkerTestResult | null>(null);

  useEffect(() => {
    if (open) {
      setForm(
        worker
          ? { name: worker.name ?? "", kind: worker.kind, host: worker.host ?? "", dataRoot: worker.dataRoot ?? "", capabilities: (worker.capabilities ?? []).join(", ") }
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
    // 显式传数组(空数组 = 清空能力):后端 updateWorker 用 `!= null` 判定「是否覆盖」。
    capabilities: parseCaps(form.capabilities),
  });

  async function runTest(): Promise<void> {
    setTesting(true);
    try {
      setTest(await api.testWorker(payload()));
    } catch (e) {
      setTest({ ok: false, error: errMessage(e) });
    } finally {
      setTesting(false);
    }
  }

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    setBusy(true);
    try {
      if (isEdit) await api.updateWorker(worker.id, payload());
      else {
        // 新建:优先用「测试连接」探测到的节点稳定 id(nodeId),替代后端自分配 worker-N。
        // 没测过 → 先探一次(拿不到身份也不阻断,后端回落自分配)。
        let id = test?.nodeId;
        if (!id) {
          const r = await api.testWorker(payload()).catch(() => null);
          if (r?.ok) { setTest(r); id = r.nodeId; }
        }
        await api.createWorker({ ...payload(), ...(id ? { id } : {}) });
      }
      onClose();
      toast(isEdit ? t("hub.workerDialog.updated") : t("hub.workerDialog.created"), "success");
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
      title={isEdit ? t("hub.workerDialog.editTitle") : t("hub.workerDialog.createTitle")}
      description={t("hub.workerDialog.desc")}
    >
      <form className="grid grid-cols-1 gap-4" onSubmit={submit}>
        {isEdit && (
          <div className="text-xs text-muted-soft font-mono break-all">{t("hub.workerDialog.idLabel", { id: worker.id })}</div>
        )}
        <div>
          <label className="field-label">{t("hub.workerDialog.nameLabel")}</label>
          <input
            className="input"
            placeholder={t("hub.workerDialog.namePlaceholder")}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>
        <div>
          <label className="field-label">{t("hub.workerDialog.kindLabel")}</label>
          <select className="input" value={form.kind} disabled={isLocal} onChange={(e) => set("kind", e.target.value)}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          {isLocal && <div className="text-xs text-muted mt-1">{t("hub.workerDialog.localKindHint")}</div>}
        </div>
        {needsHost && (
          <div>
            <label className="field-label">
              {t("hub.workerDialog.hostLabel")}<span className="text-error-fg">*</span>
            </label>
            <input
              required
              className="input"
              placeholder={t("hub.workerDialog.hostPlaceholder")}
              value={form.host}
              onChange={(e) => set("host", e.target.value)}
            />
          </div>
        )}
        <div>
          <label className="field-label">
            {t("hub.workerDialog.dataRootLabel")}<span className="text-error-fg">*</span>
          </label>
          <input
            required
            className="input"
            placeholder={t("hub.workerDialog.dataRootPlaceholder")}
            value={form.dataRoot}
            onChange={(e) => set("dataRoot", e.target.value)}
          />
        </div>
        <div>
          <label className="field-label">{t("hub.workerDialog.capsLabel")}</label>
          <input
            className="input"
            placeholder={t("hub.workerDialog.capsPlaceholder")}
            value={form.capabilities}
            onChange={(e) => set("capabilities", e.target.value)}
          />
          <div className="text-xs text-muted mt-1">{t("hub.workerDialog.capsHint")}</div>
        </div>
        {test && (
          <div
            className="status-strip text-sm"
            style={{ color: test.ok ? "var(--success-fg)" : "var(--error-fg)" }}
          >
            {test.ok ? t("hub.workerDialog.testOk") : t("hub.workerDialog.testFailed", { error: test.error ?? t("hub.workerDialog.unknownError") })}
            {test.ok && test.nodeId && (
              <div className="text-xs text-muted-soft font-mono mt-1 break-all">
                {t("hub.workerDialog.nodeIdLabel", { id: test.nodeId })}
                {test.hostname ? ` · ${test.hostname}` : ""}
              </div>
            )}
          </div>
        )}
        <div className="flex justify-between gap-3 mt-2">
          <Button type="button" variant="secondary" onClick={() => void runTest()} disabled={testing} loading={testing}>
            {t("hub.workers.testConn")}
          </Button>
          <div className="flex gap-3">
            <Button type="button" variant="secondary" onClick={onClose}>
              {t("hub.common.cancel")}
            </Button>
            <Button type="submit" disabled={busy} loading={busy}>
              {isEdit ? t("hub.common.save") : t("hub.common.create")}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
