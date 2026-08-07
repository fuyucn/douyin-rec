import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type HubRuleDTO, type HubRulePayload, type Task, type WorkerDTO } from "../api/client";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Switch } from "../components/Switch";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = create mode; a rule = edit that rule (roomSlug fixed). */
  rule: HubRuleDTO | null;
  onSaved: () => void;
}

interface FormState {
  room: string;
  enabled: boolean;
  /** 选中的 worker id 列表;新建默认空(需用户选 ≥1);编辑无 workers 的老规则预勾全部当前 worker。 */
  workers: string[];
  burnDanmu: boolean;
  burnLivechat: boolean;
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clStageAfterDone: boolean;
  clIncludeXmlAss: boolean;
  uploadMode: string; // "stage" | "upload"
  uploadPrivate: boolean; // 仅 upload 有意义:true=仅自己可见,false=公开
  uploadTag: string;
  uploadTid: string;
  uploadDesc: string;
  /** 绑定的 master 任务 id;null = 不下发录制。 */
  sourceTaskId: number | null;
}

const BLANK: FormState = {
  room: "",
  enabled: true,
  workers: [],
  burnDanmu: true,
  burnLivechat: true,
  clStageSourceAfterMerge: false,
  clSourceAfterDone: false,
  clStageAfterDone: false,
  clIncludeXmlAss: false,
  uploadMode: "stage",
  uploadPrivate: true,
  uploadTag: "",
  uploadTid: "21",
  uploadDesc: "",
  sourceTaskId: null,
};

function fromRule(r: HubRuleDTO): FormState {
  const c = r.pipeline ?? {};
  return {
    room: r.room ?? "",
    enabled: r.enabled,
    // 显式列表回显;无 workers(老规则)先给空,加载 worker 列表后在 effect 里预勾全部。
    workers: r.workers ?? [],
    burnDanmu: c.steps?.burnDanmu !== false,
    burnLivechat: c.steps?.burnLivechat !== false,
    clStageSourceAfterMerge: c.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: c.cleanup?.sourceAfterDone === true,
    clStageAfterDone: c.cleanup?.stageAfterDone === true,
    clIncludeXmlAss: c.cleanup?.includeXmlAss === true,
    uploadMode: c.upload?.mode === "upload" ? "upload" : "stage",
    uploadPrivate: c.upload?.private !== false,
    uploadTag: c.upload?.tag ?? "",
    uploadTid: String(c.upload?.tid ?? 21),
    uploadDesc: c.upload?.desc ?? "",
    sourceTaskId: r.recording?.sourceTaskId ?? null,
  };
}

/** 前端近似 platform.extractRoomSlug:URL 取纯数字 id,裸房间号原样;供 source task 下拉过滤。 */
function slugOfRoom(room: string): string {
  const m = room.match(/live\.[a-z0-9-]+\.com\/(\d+)/i);
  if (m) return m[1];
  const r = room.trim();
  if (/^\d+$/.test(r)) return r;
  const q = r.indexOf("?");
  return q >= 0 ? r.slice(0, q) : r;
}

/** Hub 规则的创建/编辑弹窗:按房间(roomSlug)配置后处理 pipeline。 */
export function HubRuleDialog({ open, onClose, rule, onSaved }: Props): ReactNode {
  const isEdit = rule !== null;
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [workersError, setWorkersError] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksError, setTasksError] = useState(false);

  useEffect(() => {
    if (open) setForm(rule ? fromRule(rule) : BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.key]);

  // 打开时拉 worker 列表(name 显示 / id 存储)。失败给提示不崩。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setWorkersError(false);
    api.listWorkers()
      .then((ws) => {
        if (!alive) return;
        setWorkers(ws);
        // 编辑无 workers 的老规则(隐式 all)→ 预勾全部当前 worker,显性化让用户确认。
        if (rule && (rule.workers === undefined || rule.workers.length === 0)) {
          setForm((f) => ({ ...f, workers: ws.map((w) => w.id) }));
        }
      })
      .catch(() => { if (alive) setWorkersError(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.key]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTasksError(false);
    api.listTasks()
      .then((ts) => { if (alive) setTasks(ts); })
      .catch(() => { if (alive) setTasksError(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.key]);

  const toggleWorker = (id: string): void =>
    setForm((f) => ({
      ...f,
      workers: f.workers.includes(id) ? f.workers.filter((x) => x !== id) : [...f.workers, id],
    }));
  // 新建必须选 ≥1;编辑同理(编辑老规则已预勾全部,用户主动清空也要拦)。
  const workersInvalid = form.workers.length === 0;
  const selectedTask = tasks.find((task) => task.id === form.sourceTaskId) ?? null;
  // 新建:任务决定房间,候选 = 全部任务;编辑:房间已固定,只允许同房间任务。
  const sourceCandidates = rule
    ? tasks.filter((task) => slugOfRoom(task.room) === rule.roomSlug)
    : tasks;

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!isEdit && form.sourceTaskId === null) {
      toast(t("hub.ruleDialog.sourceTaskRequired"), "error");
      return;
    }
    if (workersInvalid) { toast(t("hub.ruleDialog.workersRequired"), "error"); return; }
    const payload: HubRulePayload = {
      enabled: form.enabled,
      workers: form.workers,
      recording: { sourceTaskId: form.sourceTaskId },
      pipeline: {
        steps: { burnDanmu: form.burnDanmu, burnLivechat: form.burnLivechat },
        cleanup: {
          stageSourceAfterMerge: form.clStageSourceAfterMerge,
          sourceAfterDone: form.clSourceAfterDone,
          stageAfterDone: form.clStageAfterDone,
          includeXmlAss: form.clIncludeXmlAss,
        },
        upload: {
          mode: form.uploadMode === "upload" ? "upload" : "stage",
          private: form.uploadPrivate,
          tag: form.uploadTag.trim() || undefined,
          tid: Number(form.uploadTid) || 21,
          desc: form.uploadDesc.trim() || undefined,
        },
      },
    };
    setBusy(true);
    try {
      if (isEdit) await api.updateHubRule(rule.key, payload);
      else await api.createHubRule(payload);
      onClose();
      toast(isEdit ? t("hub.ruleDialog.updated") : t("hub.ruleDialog.created"), "success");
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
      widthClass="max-w-2xl"
      title={isEdit ? t("hub.ruleDialog.editTitle") : t("hub.ruleDialog.createTitle")}
      description={t("hub.ruleDialog.desc")}
    >
      <form className="grid grid-cols-1 sm:grid-cols-2 gap-4" onSubmit={submit}>
        <div className="sm:col-span-2">
          <label className="field-label">{isEdit ? t("hub.ruleDialog.roomLabel") : t("hub.ruleDialog.roomFromTaskLabel")}</label>
          {isEdit ? (
            <div className="font-mono text-sm text-body break-all">
              {rule.room}
              <span className="text-muted-soft ml-2">{t("hub.ruleDialog.roomSlugSuffix", { slug: rule.roomSlug })}</span>
            </div>
          ) : selectedTask ? (
            <div className="font-mono text-sm text-body break-all">
              {selectedTask.room}
              <span className="text-muted-soft ml-2">{t("hub.ruleDialog.roomSlugSuffix", { slug: slugOfRoom(selectedTask.room) })}</span>
            </div>
          ) : (
            <p className="text-xs text-muted">{t("hub.ruleDialog.roomFromTaskHint")}</p>
          )}
        </div>

        <label className="sm:col-span-2 switch-row">
          <span className="flex flex-col">
            <span className="text-sm font-medium text-ink">{t("hub.ruleDialog.enabledLabel")}</span>
            <span className="text-xs text-muted mt-0.5">{t("hub.ruleDialog.enabledHint")}</span>
          </span>
          <Switch checked={form.enabled} onCheckedChange={(v) => set("enabled", v)} name="enabled" />
        </label>

        {/* ── Section: 参与 Worker(多选;硬过滤,至少 1)── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.workersSection")}</h3>
          <p className="text-xs text-muted mb-2">{t("hub.ruleDialog.workersHint")}</p>
          {workersError ? (
            <p className="text-xs text-error-fg">{t("hub.ruleDialog.workersLoadFailed")}</p>
          ) : workers.length === 0 ? (
            <p className="text-xs text-muted">{t("hub.ruleDialog.workersEmpty")}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {workers.map((w) => (
                <label key={w.id} className="switch-row">
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-ink">{w.name}</span>
                    <span className="text-xs text-muted mt-0.5 font-mono">{w.kind}{w.host ? ` · ${w.host}` : ""}</span>
                  </span>
                  <Switch checked={form.workers.includes(w.id)} onCheckedChange={() => toggleWorker(w.id)} name={`worker-${w.id}`} />
                </label>
              ))}
            </div>
          )}
          {workersInvalid && !workersError && workers.length > 0 && (
            <p className="text-xs mt-2 text-error-fg">{t("hub.ruleDialog.workersRequired")}</p>
          )}
        </div>

        {/* ── Section: 录制下发(绑定 master 任务 → 自动同步到勾选节点)── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.recordingSection")}</h3>
          <p className="text-xs text-muted mb-2">{t("hub.ruleDialog.recordingHint")}</p>
          <label className="field-label">
            {t("hub.ruleDialog.sourceTaskLabel")}{!isEdit && <span className="text-error-fg">*</span>}
          </label>
          {tasksError ? (
            <p className="text-xs text-error-fg">{t("hub.ruleDialog.tasksLoadFailed")}</p>
          ) : sourceCandidates.length === 0 ? (
            <p className="text-xs text-muted">{t("hub.ruleDialog.sourceTasksEmpty")}</p>
          ) : (
            <select
              className="input"
              value={form.sourceTaskId === null ? "" : String(form.sourceTaskId)}
              onChange={(e) => {
                const v = e.target.value;
                set("sourceTaskId", v === "" ? null : Number(v));
              }}
            >
              <option value="">{isEdit ? t("hub.ruleDialog.sourceTaskNone") : t("hub.ruleDialog.sourceTaskChoose")}</option>
              {sourceCandidates.map((task) => (
                <option key={task.id} value={String(task.id)}>
                  #{task.id} · {task.name || task.anchorName || task.room}
                  {task.managedBy === "hub" ? ` · ${t("tasks.managed")}` : ""}
                </option>
              ))}
            </select>
          )}
        </div>

        {/* ── Section: 流水线 pipeline(产出 + 清理)── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.pipelineSection")}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              ["burnDanmu", t("hub.ruleDialog.toggleBurnDanmuLabel"), t("hub.ruleDialog.toggleBurnDanmuSub")],
              ["burnLivechat", t("hub.ruleDialog.toggleBurnLivechatLabel"), t("hub.ruleDialog.toggleBurnLivechatSub")],
              ["clStageSourceAfterMerge", t("hub.ruleDialog.toggleClStageSourceAfterMergeLabel"), t("hub.ruleDialog.toggleClStageSourceAfterMergeSub")],
              ["clSourceAfterDone", t("hub.ruleDialog.toggleClSourceAfterDoneLabel"), t("hub.ruleDialog.toggleClSourceAfterDoneSub")],
              ["clStageAfterDone", t("hub.ruleDialog.toggleClStageAfterDoneLabel"), t("hub.ruleDialog.toggleClStageAfterDoneSub")],
              ["clIncludeXmlAss", t("hub.ruleDialog.toggleClIncludeXmlAssLabel"), t("hub.ruleDialog.toggleClIncludeXmlAssSub")],
            ] as const).map(([key, label, sub]) => (
              <label key={key} className="switch-row">
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">{label}</span>
                  <span className="text-xs text-muted mt-0.5">{sub}</span>
                </span>
                <Switch checked={form[key]} onCheckedChange={(v) => set(key, v)} name={key} />
              </label>
            ))}
          </div>
        </div>

        {/* ── Section: Bilibili 上传(总开关 + 开启后才显示投稿明细)── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.uploadSection")}</h3>
          {/* 上传 B站总开关:off=stage(只合成不传) on=upload(自动传) */}
          <label className="switch-row">
            <span className="flex flex-col">
              <span className="text-sm font-medium text-ink">{t("hub.ruleDialog.uploadToggleLabel")}</span>
              <span className="text-xs text-muted mt-0.5">{form.uploadMode === "upload" ? t("hub.ruleDialog.uploadOnHint") : t("hub.ruleDialog.uploadOffHint")}</span>
            </span>
            <Switch
              checked={form.uploadMode === "upload"}
              onCheckedChange={(v) => set("uploadMode", v ? "upload" : "stage")}
              name="uploadOn"
            />
          </label>

          {/* 只有开了上传才显示后面的投稿明细 */}
          {form.uploadMode === "upload" && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
              <label className="switch-row">
                <span className="flex flex-col">
                  <span className="text-sm font-medium text-ink">{t("hub.ruleDialog.publicLabel")}</span>
                  <span className="text-xs text-muted mt-0.5">{form.uploadPrivate ? t("hub.ruleDialog.privateHint") : t("hub.ruleDialog.publicHint")}</span>
                </span>
                <Switch checked={!form.uploadPrivate} onCheckedChange={(v) => set("uploadPrivate", !v)} name="uploadPublic" />
              </label>
              <div>
                <label className="field-label">{t("hub.ruleDialog.tidLabel")}</label>
                <input type="number" min={1} className="input" value={form.uploadTid} onChange={(e) => set("uploadTid", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">{t("hub.ruleDialog.tagLabel")}</label>
                <input className="input" placeholder={t("hub.ruleDialog.tagPlaceholder")} value={form.uploadTag} onChange={(e) => set("uploadTag", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">{t("hub.ruleDialog.descLabel")}</label>
                <textarea
                  className="textarea font-mono text-sm"
                  rows={4}
                  placeholder={t("hub.ruleDialog.descPlaceholder")}
                  value={form.uploadDesc}
                  onChange={(e) => set("uploadDesc", e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <div className="sm:col-span-2 flex justify-end gap-3 mt-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("hub.common.cancel")}
          </Button>
          <Button type="submit" disabled={busy || workersInvalid} loading={busy}>
            {isEdit ? t("hub.common.save") : t("hub.common.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
