/**
 * HubRuleDialog — Hub 规则的创建 / 编辑弹窗:绑定源任务 + 录制半边 + 节点 + 处理 / 上传 / 清理。
 * 分区与字段依赖与房间面板共用 components/room-form + lib/room-form-rules(issue #126)。
 */
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { api, type HubRuleDTO, type HubRulePayload, type PlatformDTO, type Task, type WorkerDTO } from "../api/client";
import { cookieStatusAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { CleanupSection, type CleanupValue } from "../components/room-form/CleanupSection";
import { FlowSummary } from "../components/room-form/FlowSummary";
import type { OutputFormat } from "@drec/output-format";
import { NodesSection } from "../components/room-form/NodesSection";
import { ProcessingSection, type ProcessingValue } from "../components/room-form/ProcessingSection";
import { RecordingSection, type RecordingValue } from "../components/room-form/RecordingSection";
import { RuleSwitch } from "../components/room-form/parts";
import { UploadSection, type UploadValue } from "../components/room-form/UploadSection";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform, scheduleInput, splitSchedule } from "../lib/labels";
import {
  deriveConstraints, flowSummary, keepArchiveFromStored, methodFromStored, outputFormatFromStored, settledMethod, shownOutputFormat, storedFromForm, type FormFacts,
} from "../lib/room-form-rules";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = create mode; a rule = edit that rule (roomSlug fixed). */
  rule: HubRuleDTO | null;
  onSaved: () => void;
}

type FormState = RecordingValue & ProcessingValue & UploadValue & CleanupValue & {
  /** 输出格式(源任务字段;缺省 original)。 */
  outputFormat: OutputFormat;
  /** 选中的 worker id;新建默认空(需选 ≥1);编辑无 workers 的老规则预勾全部当前 worker。 */
  workers: string[];
  /** 能力门控:与 workers 取交集。空 = 无要求。 */
  requires: string[];
  /** 绑定的 master 任务 id;null = 不下发录制。 */
  sourceTaskId: number | null;
  /**
   * 用户是否改过录制字段:阻止「tasks 迟到 / 换源任务 → 回显覆盖正在填的值」。表单草稿态,不提交。
   */
  recordingTouched: boolean;
};

type RecordingHalf = Omit<RecordingValue, "name"> & { outputFormat: OutputFormat };

/** 录制半边从「已绑定的 task」回显(rule 里没有画质/分段这些字段)。没有 task 时给保守默认。 */
function recordingFromTask(task: Task | null): RecordingHalf {
  if (!task) {
    return { recEnabled: true, quality: "", engine: "", danmu: true, useCookie: true, segmentSec: "1800", schedule: "", outputFormat: "original" };
  }
  return {
    recEnabled: task.enabled,
    quality: task.quality,
    engine: task.engine,
    danmu: !!task.danmu,
    useCookie: !!task.useCookie,
    segmentSec: String(task.segmentSec ?? 1800),
    outputFormat: outputFormatFromStored(task.outputFormat),
    schedule: scheduleInput(task),
  };
}

const BLANK: FormState = {
  ...recordingFromTask(null),
  name: "",
  procEnabled: true,
  mergeSegments: true,
  burnDanmu: true,
  burnLivechat: true,
  uploadOn: false,
  method: "after",
  tsDirect: false,
  uploadPrivate: true,
  tid: "21",
  tag: "",
  desc: "",
  titleTemplate: "",
  submissionTitleTemplate: "",
  partTitleTemplate: "",
  clStageSourceAfterMerge: false,
  clSourceAfterDone: false,
  clKeepArchive: true,
  workers: [],
  requires: [],
  sourceTaskId: null,
  recordingTouched: false,
};

function fromRule(r: HubRuleDTO): FormState {
  const c = r.pipeline ?? {};
  return {
    ...BLANK,
    procEnabled: r.enabled,
    // 显式列表回显;无 workers(老规则)先给空,加载 worker 列表后在 effect 里预勾全部。
    workers: r.workers ?? [],
    requires: r.requires ?? [],
    burnDanmu: c.steps?.burnDanmu !== false,
    burnLivechat: c.steps?.burnLivechat !== false,
    mergeSegments: c.steps?.mergeSegments !== false,
    tsDirect: c.steps?.tsDirect === true,
    ...methodFromStored(c.upload?.mode, c.steps?.nodeSideUpload === true),
    clStageSourceAfterMerge: c.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: c.cleanup?.sourceAfterDone === true,
    clKeepArchive: keepArchiveFromStored(c.cleanup?.stageAfterDone),
    uploadPrivate: c.upload?.private !== false,
    tag: c.upload?.tag ?? "",
    tid: String(c.upload?.tid ?? 21),
    desc: c.upload?.desc ?? "",
    titleTemplate: c.upload?.titleTemplate ?? "",
    submissionTitleTemplate: c.upload?.submissionTitleTemplate ?? "",
    partTitleTemplate: c.upload?.partTitleTemplate ?? "",
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

const RECORDING_KEYS = new Set<string>(["recEnabled", "quality", "engine", "danmu", "useCookie", "segmentSec", "schedule", "outputFormat"]);

export function HubRuleDialog({ open, onClose, rule, onSaved }: Props): ReactNode {
  const isEdit = rule !== null;
  const t = useT();
  const toast = useToast();
  const cookieReady = !!useAtomValue(cookieStatusAtom)?.hasSession;
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);
  const [workersError, setWorkersError] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [tasksError, setTasksError] = useState(false);
  /** 平台能力表(quality/engine 合法值):决定录制区块的下拉候选,避免手写一份平台清单。 */
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);

  // 打开时用「规则 + 它绑定的 task」初始化;tasks 迟到时由下面的 effect 补录制半边回显。
  useEffect(() => {
    if (!open) return;
    if (!rule) { setForm(BLANK); return; }
    const task = tasks.find((x) => x.id === rule.recording?.sourceTaskId) ?? null;
    setForm({ ...fromRule(rule), ...recordingFromTask(task) });
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

  // 平台清单:quality/engine 的合法值随平台而变(白嫖 Platform 注册表,不在前端硬编码)。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    api.getPlatforms()
      .then((r) => { if (alive) setPlatforms(r.platforms ?? []); })
      .catch(() => { if (alive) setPlatforms([]); });   // 拉不到就退化成自由输入,别让弹窗打不开
    return () => { alive = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setTasksError(false);
    api.listTasks()
      .then((ts) => {
        if (!alive) return;
        setTasks(ts);
        // 编辑模式下 tasks 是**后到**的:此刻才能把录制半边按真实 task 回显。
        // 只在「用户还没手动改过录制字段」时覆盖,否则会把用户正在填的值冲掉。
        if (rule) {
          setForm((f) => (f.recordingTouched
            ? f
            : { ...f, ...recordingFromTask(ts.find((x) => x.id === (rule.recording?.sourceTaskId ?? -1)) ?? null) }));
        }
      })
      .catch(() => { if (alive) setTasksError(true); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.key]);

  const selectedTask = tasks.find((task) => task.id === form.sourceTaskId) ?? null;
  // 画质/引擎候选 = 该房间所属平台的白名单(与任务弹窗共用 pickPlatform)。
  const plat = pickPlatform(selectedTask?.room ?? rule?.room ?? "", platforms);
  // 新建:任务决定房间,候选 = 全部任务;编辑:房间已固定,只允许同房间任务。
  const sourceCandidates = rule ? tasks.filter((task) => slugOfRoom(task.room) === rule.roomSlug) : tasks;
  const platformId = plat?.id ?? (rule?.key.split(".")[0] ?? "douyin");
  const factsOf = (f: FormState): FormFacts => ({
    ...f,
    danmuAvailable: plat ? plat.hasDanmu : true,
    cookieReady,
    cookieForStream: platformId !== "douyin",
    hasRule: true,
  });
  const facts = factsOf(form);
  const c = deriveConstraints(facts);
  const workersInvalid = form.workers.length === 0;

  // 每次改动后结算上传方式(失效即回落);动了录制字段就不再被迟到回显覆盖。
  const update = (patch: Partial<FormState>): void =>
    setForm((f) => {
      const next = { ...f, ...patch, ...(Object.keys(patch).some((k) => RECORDING_KEYS.has(k)) ? { recordingTouched: true } : {}) };
      return { ...next, method: settledMethod(factsOf(next)) };
    });
  // 换源任务:录制半边改按新任务回显(否则保存会把表单默认值写到该任务上)。
  const pickSource = (id: number | null): void => {
    const task = tasks.find((x) => x.id === id) ?? null;
    setForm((f) => ({ ...f, sourceTaskId: id, ...(f.recordingTouched ? {} : recordingFromTask(task)) }));
  };
  const toggleIn = (list: string[], x: string): string[] => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

  function buildPayload(): HubRulePayload {
    const stored = storedFromForm(facts);
    return {
      enabled: form.procEnabled,
      workers: form.workers,
      requires: form.requires,
      recording: { sourceTaskId: form.sourceTaskId },
      pipeline: {
        steps: {
          mergeSegments: form.mergeSegments, burnDanmu: stored.burnDanmu, burnLivechat: stored.burnLivechat,
          nodeSideUpload: stored.nodeSideUpload, tsDirect: form.tsDirect,
        },
        cleanup: {
          stageSourceAfterMerge: form.clStageSourceAfterMerge,
          sourceAfterDone: form.clSourceAfterDone,
          stageAfterDone: stored.stageAfterDone,
        },
        upload: {
          mode: stored.mode,
          private: form.uploadPrivate,
          tag: form.tag.trim() || undefined,
          tid: Number(form.tid) || 21,
          desc: form.desc.trim() || undefined,
          titleTemplate: form.titleTemplate.trim() || undefined,
          submissionTitleTemplate: form.submissionTitleTemplate.trim() || undefined,
          partTitleTemplate: form.partTitleTemplate.trim() || undefined,
        },
      },
    };
  }

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!isEdit && form.sourceTaskId === null) { toast(t("hub.ruleDialog.sourceTaskRequired"), "error"); return; }
    if (workersInvalid) { toast(t("hub.ruleDialog.workersRequired"), "error"); return; }
    const sched = splitSchedule(form.schedule);
    if (!sched) { toast(t("rooms.scheduleInvalid"), "error"); return; }
    const payload = buildPayload();
    // 定时窗口必须成对发 scheduleStart/End:后端不认单个 schedule 字段(此前在这里静默丢失)。
    const recording = form.sourceTaskId === null
      ? undefined
      : {
          enabled: form.recEnabled,
          ...(form.quality.trim() ? { quality: form.quality.trim() } : {}),
          ...(form.engine.trim() ? { engine: form.engine.trim() } : {}),
          danmu: form.danmu ? 1 : 0,
          useCookie: form.useCookie,
          ...(Number(form.segmentSec) > 0 ? { segmentSec: Number(form.segmentSec) } : {}),
          outputFormat: storedFromForm(facts).outputFormat,
          ...sched,
        };
    // 编辑时换了源任务 → 规则也要重新绑定(PUT rooms 的 processing 不含 sourceTaskId)。
    const sourceTaskChanged = isEdit && rule.recording?.sourceTaskId !== form.sourceTaskId;

    setBusy(true);
    try {
      if (isEdit) {
        // 一次 PUT 两半(后端第二步失败会回滚第一步,不留半成功)。enabled 属于 processing 内部。
        await api.updateRoom(rule.key, {
          processing: { enabled: payload.enabled, pipeline: payload.pipeline, workers: payload.workers, requires: payload.requires },
          ...(recording ? { recording } : {}),
        });
        if (sourceTaskChanged) {
          try {
            await api.updateHubRule(rule.key, { recording: { sourceTaskId: form.sourceTaskId } });
          } catch (e2) {
            toast(t("hub.ruleDialog.reboundFailed", { error: errMessage(e2) }), "error");
            onSaved();
            return;
          }
        }
        onClose();
        toast(t("hub.ruleDialog.updated"), "success");
        onSaved();
        return;
      }
      // 新建:先建规则拿到 key,再 PUT 录制半边 —— 两步;第二步失败要说清楚是哪半边。
      const created = await api.createHubRule(payload);
      if (recording) {
        try {
          await api.updateRoom(created.key, { recording });
        } catch (e2) {
          toast(t("hub.ruleDialog.createdButRecordingFailed", { error: errMessage(e2) }), "error");
          onSaved();
          return; // 保持弹窗打开:改完录制字段可直接再保存,不会重复建规则
        }
      }
      onClose();
      toast(t("hub.ruleDialog.created"), "success");
      onSaved();
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const roomText = isEdit ? rule.room : selectedTask?.room;
  const roomSlug = isEdit ? rule.roomSlug : selectedTask ? slugOfRoom(selectedTask.room) : "";

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-2xl"
      title={isEdit ? t("hub.ruleDialog.editTitle") : t("hub.ruleDialog.createTitle")}
      description={t("hub.ruleDialog.desc")}
    >
      <form className="space-y-7" onSubmit={submit}>
        <section className="space-y-2">
          <label className="field-label">
            {t("hub.ruleDialog.sourceTaskLabel")}{!isEdit && <span className="text-error-fg">*</span>}
          </label>
          {tasksError ? (
            <p className="text-xs text-error-fg">{t("hub.ruleDialog.tasksLoadFailed")}</p>
          ) : sourceCandidates.length === 0 ? (
            <p className="text-xs text-muted">{t("hub.ruleDialog.sourceTasksEmpty")}</p>
          ) : (
            <select className="input" value={form.sourceTaskId === null ? "" : String(form.sourceTaskId)}
                    onChange={(e) => pickSource(e.target.value === "" ? null : Number(e.target.value))}>
              <option value="">{isEdit ? t("hub.ruleDialog.sourceTaskNone") : t("hub.ruleDialog.sourceTaskChoose")}</option>
              {sourceCandidates.map((task) => (
                <option key={task.id} value={String(task.id)}>
                  #{task.id} · {task.name || task.anchorName || task.room}
                  {task.managedBy === "hub" ? ` · ${t("tasks.managed")}` : ""}
                </option>
              ))}
            </select>
          )}
          {roomText ? (
            <p className="font-mono text-xs text-muted break-all">
              {roomText}<span className="text-muted-soft ml-2">{t("hub.ruleDialog.roomSlugSuffix", { slug: roomSlug })}</span>
            </p>
          ) : (
            <p className="text-xs text-muted">{t("hub.ruleDialog.roomFromTaskHint")}</p>
          )}
        </section>

        <FlowSummary steps={flowSummary(facts, form.sourceTaskId !== null && form.recEnabled)} />
        <RuleSwitch checked={form.procEnabled} onChange={(procEnabled) => update({ procEnabled })} />
        {form.sourceTaskId !== null ? (
          <RecordingSection value={form} onChange={update} showEnabled
                            outputFormat={{ value: form.outputFormat, shown: shownOutputFormat(facts), lock: c.outputFormat, onChange: (outputFormat) => update({ outputFormat }) }}
                            qualities={plat?.qualities ?? []} engines={plat?.engines ?? []}
                            danmuAvailable={facts.danmuAvailable} cookie={c.cookie} cookieForStream={facts.cookieForStream} />
        ) : (
          <p className="text-xs text-muted">{t("hub.ruleDialog.recordingNoTask")}</p>
        )}
        <NodesSection workers={workers} selected={form.workers} requires={form.requires} loadError={workersError} requireOne
                      onToggle={(id) => update({ workers: toggleIn(form.workers, id) })}
                      onToggleRequire={(cap) => update({ requires: toggleIn(form.requires, cap) })} />
        <ProcessingSection value={form} onChange={update} burn={c.burn} />
        <UploadSection value={form} onChange={update} constraints={c} procEnabled={form.procEnabled}
                       anchorName={selectedTask?.name || rule?.anchorName || "主播名"} />
        <CleanupSection value={form} onChange={update} constraints={c} procEnabled={form.procEnabled} />

        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
          <Button type="submit" disabled={busy || workersInvalid} loading={busy}>
            {isEdit ? t("hub.common.save") : t("hub.common.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
