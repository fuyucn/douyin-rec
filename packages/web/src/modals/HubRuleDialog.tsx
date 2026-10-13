import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type HubRuleDTO, type HubRulePayload, type PlatformDTO, type Task, type WorkerDTO } from "../api/client";
import { pickPlatform, qualityLabel, scheduleInput } from "../lib/labels";
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
  /** 能力门控:本房间需要的 worker 能力标签(与 workers 取交集)。空 = 无要求。 */
  requires: string[];
  burnDanmu: boolean;
  burnLivechat: boolean;
  /** 合并分段成一片(默认 true);false = 不合并,按录制分段逐个上传(每段一个分 P)。 */
  mergeSegments: boolean;
  /** (实验)节点侧上传:不烧录时 winner 节点本地 remux + 上传,省掉录像回传。默认 false。 */
  nodeSideUpload: boolean;
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clStageAfterDone: boolean;
  uploadMode: string; // "stage" | "upload" | "rolling"
  uploadPrivate: boolean; // 仅 upload 有意义:true=仅自己可见,false=公开
  uploadTag: string;
  uploadTid: string;
  uploadDesc: string;
  uploadTitle: string;
  uploadSubmissionTitle: string;
  uploadPartTitle: string;
  /** 绑定的 master 任务 id;null = 不下发录制。 */
  sourceTaskId: number | null;
  // ── 录制半边(T10:与处理半边在同一个弹窗里一次保存)────────────────────────────
  /** 录制开关 = 「这个房间录不录」;与上面的 enabled(处理开关「录完做什么」)是两件事。 */
  recEnabled: boolean;
  quality: string;
  engine: string;
  danmu: boolean;
  useCookie: boolean;
  segmentSec: string;
  /** 录制窗口 "HH:MM-HH:MM";空 = 全天。 */
  schedule: string;
  /**
   * 用户是否已手动改过录制字段。用来阻止「tasks 迟到 → 回显覆盖用户正在填的值」。
   * 这是**表单草稿态**,不参与提交 payload(自审:第一版没有这个标记,tasks 晚到就会冲掉输入)。
   */
  recordingTouched: boolean;
}

const BLANK: FormState = {
  room: "",
  enabled: true,
  workers: [],
  requires: [],
  burnDanmu: true,
  burnLivechat: true,
  mergeSegments: true,
  nodeSideUpload: false,
  clStageSourceAfterMerge: false,
  clSourceAfterDone: false,
  clStageAfterDone: false,
  uploadMode: "stage",
  uploadPrivate: true,
  uploadTag: "",
  uploadTid: "21",
  uploadDesc: "",
  uploadTitle: "",
  uploadSubmissionTitle: "",
  uploadPartTitle: "",
  sourceTaskId: null,
  recEnabled: true,
  quality: "",
  engine: "",
  danmu: true,
  useCookie: true,
  segmentSec: "1800",
  schedule: "",
  recordingTouched: false,
};

/** 录制半边从「已绑定的 task」回显(T10)。没有 task 时给一个保守默认,不改全局默认。 */
function recordingFromTask(task: Task | null): Pick<FormState, "recEnabled" | "quality" | "engine" | "danmu" | "useCookie" | "segmentSec" | "schedule"> {
  if (!task) {
    return { recEnabled: true, quality: "", engine: "", danmu: true, useCookie: true, segmentSec: "1800", schedule: "" };
  }
  return {
    recEnabled: task.enabled,
    quality: task.quality,
    engine: task.engine,
    danmu: !!task.danmu,
    useCookie: !!task.useCookie,
    segmentSec: String(task.segmentSec ?? 1800),
    schedule: scheduleInput(task),
  };
}

function fromRule(r: HubRuleDTO): FormState {
  const c = r.pipeline ?? {};
  return {
    room: r.room ?? "",
    enabled: r.enabled,
    // 显式列表回显;无 workers(老规则)先给空,加载 worker 列表后在 effect 里预勾全部。
    workers: r.workers ?? [],
    requires: r.requires ?? [],
    burnDanmu: c.steps?.burnDanmu !== false,
    burnLivechat: c.steps?.burnLivechat !== false,
    mergeSegments: c.steps?.mergeSegments !== false,
    nodeSideUpload: c.steps?.nodeSideUpload === true,
    clStageSourceAfterMerge: c.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: c.cleanup?.sourceAfterDone === true,
    clStageAfterDone: c.cleanup?.stageAfterDone === true,
    uploadMode: c.upload?.mode === "upload" || c.upload?.mode === "rolling" ? c.upload.mode : "stage",
    uploadPrivate: c.upload?.private !== false,
    uploadTag: c.upload?.tag ?? "",
    uploadTid: String(c.upload?.tid ?? 21),
    uploadDesc: c.upload?.desc ?? "",
    uploadTitle: c.upload?.titleTemplate ?? "",
    uploadSubmissionTitle: c.upload?.submissionTitleTemplate ?? "",
    uploadPartTitle: c.upload?.partTitleTemplate ?? "",
    sourceTaskId: r.recording?.sourceTaskId ?? null,
    // 录制半边由调用方按绑定的 task 覆盖(recordingFromTask);这里给占位保证类型完整。
    recEnabled: true,
    quality: "",
    engine: "",
    danmu: true,
    useCookie: true,
    segmentSec: "1800",
    schedule: "",
    recordingTouched: false,
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


const TITLE_TOKEN_RE = /\{([A-Za-z]+)\}/g;
function previewTitle(template: string, name: string, partSample?: { part: string; parts: string; kind: string }): string {
  const t = template.trim() || "{name}_{date}";
  const parts: Record<string, string> = {
    name, user: name, owner: name,
    // 直播标题是主播自由输入,预览用一个像样的样例。
    title: "今晚直播标题",
    // 分P相关:未传样例(稿件名模板)时渲染成空,与后端一致。
    part: partSample?.part ?? "",
    parts: partSample?.parts ?? "",
    date: "2026-09-12",
    time: "14-30-05",
    datetime: "2026-09-12_14-30-05",
    yyyy: "2026", YYYY: "2026", year: "2026",
    MM: "09", month: "09",
    dd: "12", day: "12",
    HH: "14", hh: "14", hour: "14",
    mm: "30", min: "30",
    ss: "05", sec: "05",
    HHmm: "1430",
    HHmmss: "143005",
  };
  const base = t.replace(TITLE_TOKEN_RE, (raw, key: string) => parts[key] ?? raw);
  // 类型后缀由后端自动追加(plain 无 / _danmu / _livechat),预览同口径。
  const kind = partSample?.kind;
  const suffix = kind === "danmu" ? "_danmu" : kind === "livechat" ? "_livechat" : "";
  return `${base}${suffix}`;
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
  /** 平台能力表(quality/engine 合法值):决定录制区块的下拉候选,避免手写一份平台清单。 */
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);

  // 打开时用「规则 + 它绑定的 task」初始化整个表单(含 T10 新增的录制半边)。
  // 录制字段**从 task 回显**而不是从 rule 读 —— rule 里根本没有画质/分段这些字段,
  // 凭空造默认值会覆盖用户真实设置(自审发现:第一版只 fromRule(rule),录制区块全是空白默认)。
  useEffect(() => {
    if (!open) return;
    if (!rule) { setForm(BLANK); return; }
    setForm({ ...fromRule(rule), ...recordingFromTask(taskById(rule.recording?.sourceTaskId ?? null)), recordingTouched: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, rule?.key]);

  /** 按 id 取 task;tasks 尚未加载完时返回 null(稍后由下面的 effect 补回显)。 */
  function taskById(id: number | null): Task | null {
    if (id === null) return null;
    return tasks.find((x) => x.id === id) ?? null;
  }

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

  const toggleWorker = (id: string): void =>
    setForm((f) => ({
      ...f,
      workers: f.workers.includes(id) ? f.workers.filter((x) => x !== id) : [...f.workers, id],
    }));
  const toggleRequire = (cap: string): void =>
    setForm((f) => ({
      ...f,
      requires: f.requires.includes(cap) ? f.requires.filter((x) => x !== cap) : [...f.requires, cap],
    }));
  // 所有 worker 能力标签的并集(去重保序)→ 门控多选候选。
  const allCapabilities: string[] = (() => {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const w of workers) for (const c of w.capabilities ?? []) if (!seen.has(c)) { seen.add(c); out.push(c); }
    return out;
  })();
  // 已勾选、但缺少 requires 里某项能力的 worker → 会被门控排除,提前提示用户。
  const filteredOutWorkers = workers.filter(
    (w) => form.workers.includes(w.id) && form.requires.some((r) => !(w.capabilities ?? []).includes(r)),
  );
  // 新建必须选 ≥1;编辑同理(编辑老规则已预勾全部,用户主动清空也要拦)。
  const workersInvalid = form.workers.length === 0;
  const selectedTask = tasks.find((task) => task.id === form.sourceTaskId) ?? null;
  // 画质/引擎候选 = **该房间所属平台**的白名单(与任务编辑弹窗共用 pickPlatform,
  // 不在这里写第二份平台匹配逻辑)。
  const boundPlatform = pickPlatform(selectedTask?.room ?? "", platforms);
  const qualityOptions = boundPlatform?.qualities ?? [];
  const engineOptions = boundPlatform?.engines ?? [];
  // 新建:任务决定房间,候选 = 全部任务;编辑:房间已固定,只允许同房间任务。
  const sourceCandidates = rule
    ? tasks.filter((task) => slugOfRoom(task.room) === rule.roomSlug)
    : tasks;

  /** 录制半边的字段名(改动它们即视为「用户动过」,不再被迟到回显覆盖)。 */
  const RECORDING_KEYS = new Set<keyof FormState>([
    "recEnabled", "quality", "engine", "danmu", "useCookie", "segmentSec", "schedule",
  ]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({
      ...f,
      [key]: value,
      ...(RECORDING_KEYS.has(key) ? { recordingTouched: true } : {}),
      // 打开烧录 → 边录边传自动退回「合成并上传」(二者互斥,后端也会 400,issue #48)。
      ...((key === "burnDanmu" || key === "burnLivechat") && value === true && f.uploadMode === "rolling" ? { uploadMode: "upload" } : {}),
    }));
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
      requires: form.requires,
      recording: { sourceTaskId: form.sourceTaskId },
      pipeline: {
        steps: { mergeSegments: form.mergeSegments, burnDanmu: form.burnDanmu, burnLivechat: form.burnLivechat, nodeSideUpload: form.nodeSideUpload },
        cleanup: {
          stageSourceAfterMerge: form.clStageSourceAfterMerge,
          sourceAfterDone: form.clSourceAfterDone,
          stageAfterDone: form.clStageAfterDone,
        },
        upload: {
          mode: form.uploadMode === "rolling" && !(form.burnDanmu || form.burnLivechat) ? "rolling"
            : form.uploadMode === "upload" || form.uploadMode === "rolling" ? "upload" : "stage",
          private: form.uploadPrivate,
          tag: form.uploadTag.trim() || undefined,
          tid: Number(form.uploadTid) || 21,
          desc: form.uploadDesc.trim() || undefined,
          titleTemplate: form.uploadTitle.trim() || undefined,
          submissionTitleTemplate: form.uploadSubmissionTitle.trim() || undefined,
          partTitleTemplate: form.uploadPartTitle.trim() || undefined,
        },
      },
    };
    // T9 统一房间:编辑模式一次 PUT 两半(后端第二步失败会回滚第一步,不留半成功)。
    // 新建仍走 createHubRule —— 房间里还没有 task,统一房间 PUT 要求房间已存在。
    const recording = form.sourceTaskId === null
      ? undefined
      : {
          enabled: form.recEnabled,
          ...(form.quality.trim() ? { quality: form.quality.trim() } : {}),
          ...(form.engine.trim() ? { engine: form.engine.trim() } : {}),
          danmu: form.danmu ? 1 : 0,
          useCookie: form.useCookie,
          ...(Number(form.segmentSec) > 0 ? { segmentSec: Number(form.segmentSec) } : {}),
          ...(form.schedule.trim() ? { schedule: form.schedule.trim() } : {}),
        };

    // 编辑模式下换了源任务 → 规则也必须重新绑定,否则「换了任务,配置还挂在旧任务上」。
    // 第一版没处理:updateRoom 的 processing 不含 sourceTaskId,换下拉框看起来生效了
    // (录制字段写到了新任务),但规则仍绑着旧任务 → 两边对不上(自审发现)。
    const sourceTaskChanged = isEdit && rule.recording?.sourceTaskId !== form.sourceTaskId;

    setBusy(true);
    try {
      if (isEdit) {
        // 编辑:一次 PUT 两半(后端第二步失败会回滚第一步,不留半成功)。
        //
        // ⚠️ enabled 属于 **processing** 内部(不是顶层)。第一版我把它写在顶层并用
        // `as RoomPayload` 强转 —— 断言把「后端会忽略这个字段」这件事藏了起来,
        // 表现为「处理开关拨了没反应」。断言不是类型检查,别用它压掉真实错误。
        await api.updateRoom(rule.key, {
          processing: {
            enabled: payload.enabled,
            pipeline: payload.pipeline,
            workers: payload.workers,
            requires: payload.requires,
          },
          ...(recording ? { recording } : {}),
        });
        if (sourceTaskChanged) {
          // 换绑必须走规则端点(PUT rooms 的 processing 不含 sourceTaskId)。
          // 失败要说清楚:配置已改、但规则仍绑着旧任务。
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

      // 新建:先建规则(createHubRule 必须绑 sourceTaskId,拿不到房间就没有 key)。
      // 拿到 key 才能 PUT 录制半边 —— 所以这里是**两步**,与编辑的一次 PUT 不同。
      const created = await api.createHubRule(payload);
      if (recording) {
        try {
          await api.updateRoom(created.key, { recording });
        } catch (e2) {
          // 规则**已经建成了**,只有录制配置没写上。必须说清楚是哪半边失败,
          // 否则用户以为整个保存失败了、重试再建一条规则(自审发现)。
          toast(t("hub.ruleDialog.createdButRecordingFailed", { error: errMessage(e2) }), "error");
          onSaved();
          return;   // 保持弹窗打开:用户改完录制字段可以直接再保存,不会重复建规则
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

        {/* ── Section: 能力门控(requires;与上面的 workers 取交集)── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.capsSection")}</h3>
          <p className="text-xs text-muted mb-2">{t("hub.ruleDialog.capsHint")}</p>
          {allCapabilities.length === 0 ? (
            <p className="text-xs text-muted">{t("hub.ruleDialog.capsNone")}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {allCapabilities.map((c) => (
                <label key={c} className="inline-flex items-center gap-1.5 text-xs border border-hairline px-2 py-1 cursor-pointer" style={{ borderRadius: "var(--r-pill, 999px)" }}>
                  <input
                    type="checkbox"
                    checked={form.requires.includes(c)}
                    onChange={() => toggleRequire(c)}
                  />
                  <span className="font-mono text-muted-soft">{c}</span>
                </label>
              ))}
            </div>
          )}
          {/* 选中但会被能力门控排除的 worker → 提前警告(否则表现为「勾了却不录」)。 */}
          {filteredOutWorkers.length > 0 && (
            <p className="text-xs mt-2 text-error-fg">
              {t("hub.ruleDialog.capsFiltered", { workers: filteredOutWorkers.map((w) => w.name).join("、") })}
            </p>
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

        {/* ── Section: 录制配置(T10:与处理配置在同一个弹窗里一次保存)─────────────
            字段读写的是**绑定的 source task**,不是 hub 规则(规则文件里没有画质/分段)。
            上面的开关管「录完做什么」(处理),这里的开关管「这个房间录不录」(录制),两者独立。 */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.recordingConfigSection")}</h3>
          <p className="text-xs text-muted mb-2">{t("hub.ruleDialog.recordingConfigHint")}</p>
          {!form.sourceTaskId ? (
            <p className="text-xs text-muted">{t("hub.ruleDialog.recordingNoTask")}</p>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex items-center gap-2 sm:col-span-2">
                <Switch checked={form.recEnabled} onCheckedChange={(v: boolean) => set("recEnabled", v)} />
                <span className="text-sm">{t("hub.ruleDialog.recordingEnabled")}</span>
              </label>
              <div>
                <label className="field-label">{t("hub.ruleDialog.quality")}</label>
                {qualityOptions.length > 0 ? (
                  <select className="input" value={form.quality} onChange={(e) => set("quality", e.target.value)}>
                    {/* 当前值不在平台白名单里(老配置/平台改过)时补一个选项,否则 select 显示空白 */}
                    {!qualityOptions.includes(form.quality) && <option value={form.quality}>{form.quality || "-"}</option>}
                    {qualityOptions.map((q) => <option key={q} value={q}>{qualityLabel(q)}</option>)}
                  </select>
                ) : (
                  <input className="input" value={form.quality} onChange={(e) => set("quality", e.target.value)} />
                )}
              </div>
              <div>
                <label className="field-label">{t("hub.ruleDialog.engine")}</label>
                {engineOptions.length > 0 ? (
                  <select className="input" value={form.engine} onChange={(e) => set("engine", e.target.value)}>
                    {!engineOptions.includes(form.engine) && <option value={form.engine}>{form.engine || "-"}</option>}
                    {engineOptions.map((q) => <option key={q} value={q}>{q}</option>)}
                  </select>
                ) : (
                  <input className="input" value={form.engine} onChange={(e) => set("engine", e.target.value)} />
                )}
              </div>
              <div>
                <label className="field-label">{t("hub.ruleDialog.segmentSec")}</label>
                <input className="input" type="number" min={60} value={form.segmentSec}
                       onChange={(e) => set("segmentSec", e.target.value)} />
                <p className="text-xs text-muted mt-1">{t("hub.ruleDialog.segmentSecHint")}</p>
              </div>
              <div>
                <label className="field-label">{t("hub.ruleDialog.schedule")}</label>
                <input className="input" value={form.schedule} onChange={(e) => set("schedule", e.target.value)}
                       placeholder="HH:MM-HH:MM" />
                <p className="text-xs text-muted mt-1">{t("hub.ruleDialog.scheduleHint")}</p>
              </div>
              <label className="flex items-center gap-2">
                <Switch checked={form.danmu} onCheckedChange={(v: boolean) => set("danmu", v)} />
                <span className="text-sm">{t("hub.ruleDialog.danmu")}</span>
              </label>
              <label className="flex items-center gap-2">
                <Switch checked={form.useCookie} onCheckedChange={(v: boolean) => set("useCookie", v)} />
                <span className="text-sm">{t("hub.ruleDialog.useCookie")}</span>
              </label>
            </div>
          )}
        </div>

        {/* ── Section: 流水线 pipeline(产出 + 清理)── */}
        <div className="sm:col-span-2">
          <h3 className="form-section">{t("hub.ruleDialog.pipelineSection")}</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {([
              ["mergeSegments", t("hub.ruleDialog.toggleMergeSegmentsLabel"), t("hub.ruleDialog.toggleMergeSegmentsSub")],
              ["nodeSideUpload", t("hub.ruleDialog.toggleNodeSideUploadLabel"), t("hub.ruleDialog.toggleNodeSideUploadSub")],
              ["burnDanmu", t("hub.ruleDialog.toggleBurnDanmuLabel"), t("hub.ruleDialog.toggleBurnDanmuSub")],
              ["burnLivechat", t("hub.ruleDialog.toggleBurnLivechatLabel"), t("hub.ruleDialog.toggleBurnLivechatSub")],
              ["clStageSourceAfterMerge", t("hub.ruleDialog.toggleClStageSourceAfterMergeLabel"), t("hub.ruleDialog.toggleClStageSourceAfterMergeSub")],
              ["clSourceAfterDone", t("hub.ruleDialog.toggleClSourceAfterDoneLabel"), t("hub.ruleDialog.toggleClSourceAfterDoneSub")],
              ["clStageAfterDone", t("hub.ruleDialog.toggleClStageAfterDoneLabel"), t("hub.ruleDialog.toggleClStageAfterDoneSub")],
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
              <span className="text-xs text-muted mt-0.5">{form.uploadMode !== "stage" ? t("hub.ruleDialog.uploadOnHint") : t("hub.ruleDialog.uploadOffHint")}</span>
            </span>
            <Switch
              checked={form.uploadMode !== "stage"}
              onCheckedChange={(v) => set("uploadMode", v ? (form.uploadMode === "rolling" ? "rolling" : "upload") : "stage")}
              name="uploadOn"
            />
          </label>

          {/* 边录边传(issue #40):配置入口在 hub 规则 —— mode=rolling = 合成并上传 + 录制端每封口一段就传、
              确认后删该段源;仅当本规则恰好勾选 1 个节点时生效,否则回落整场管线(防重复投稿)。 */}
          {form.uploadMode !== "stage" && (
            <label className="switch-row mt-3" data-disabled={form.burnDanmu || form.burnLivechat ? "true" : undefined}>
              <span className="flex flex-col">
                <span className="text-sm font-medium text-ink">{t("rooms.rollingUpload")}</span>
                {/* 与烧录互斥(issue #48):开着烧录时禁用,并把说明换成禁用原因 */}
                <span className="text-xs text-muted mt-0.5">
                  {(form.burnDanmu || form.burnLivechat) ? t("rooms.rollingNeedsBurn") : t("rooms.rollingUploadHint")}
                </span>
              </span>
              <Switch
                checked={form.uploadMode === "rolling" && !(form.burnDanmu || form.burnLivechat)}
                onCheckedChange={(v) => set("uploadMode", v ? "rolling" : "upload")}
                disabled={form.burnDanmu || form.burnLivechat}
                name="uploadRolling"
              />
            </label>
          )}

          {/* 只有开了上传才显示后面的投稿明细 */}
          {form.uploadMode !== "stage" && (
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
                <label className="field-label">{t("hub.ruleDialog.titleTemplateLabel")}</label>
                <input
                  className="input font-mono text-sm"
                  placeholder="{name}_{date}"
                  value={form.uploadTitle}
                  onChange={(e) => set("uploadTitle", e.target.value)}
                />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {(["{name}_{date}", "{name}_{date}_{HH}-{mm}", "{name}_{date}_{HH}-{mm}-{ss}", "{name}_{title}_{date}"] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="text-[11px] font-mono px-2 py-0.5 rounded border border-hairline text-muted hover:text-ink"
                      onClick={() => set("uploadTitle", preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-soft mt-1">
                  {t("hub.ruleDialog.titleTemplateHint")}
                  <span className="font-mono text-body ml-1">{previewTitle(form.uploadTitle, selectedTask?.name || rule?.anchorName || "主播名")}</span>
                </p>
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">{t("hub.ruleDialog.submissionTitleTemplateLabel")}</label>
                <input
                  className="input font-mono text-sm"
                  placeholder={t("hub.ruleDialog.submissionTitleTemplatePlaceholder")}
                  value={form.uploadSubmissionTitle}
                  onChange={(e) => set("uploadSubmissionTitle", e.target.value)}
                />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {(["{name}_{date}", "{name}_{date} 直播回放", "{name}_{title}"] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="text-[11px] font-mono px-2 py-0.5 rounded border border-hairline text-muted hover:text-ink"
                      onClick={() => set("uploadSubmissionTitle", preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-soft mt-1">
                  {t("hub.ruleDialog.submissionTitleTemplateHint")}
                  <span className="font-mono text-body ml-1">
                    {previewTitle(form.uploadSubmissionTitle || form.uploadTitle, selectedTask?.name || rule?.anchorName || "主播名")}
                  </span>
                </p>
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">{t("hub.ruleDialog.partTitleTemplateLabel")}</label>
                <input
                  className="input font-mono text-sm"
                  placeholder={t("hub.ruleDialog.partTitleTemplatePlaceholder")}
                  value={form.uploadPartTitle}
                  onChange={(e) => set("uploadPartTitle", e.target.value)}
                />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {(["{name}_P{part}", "{name}_{date}_P{part}", "{name}_{date}"] as const).map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className="text-[11px] font-mono px-2 py-0.5 rounded border border-hairline text-muted hover:text-ink"
                      onClick={() => set("uploadPartTitle", preset)}
                    >
                      {preset}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] text-muted-soft mt-1">
                  {t("hub.ruleDialog.partTitleTemplateHint")}
                  {form.uploadPartTitle.trim() && (
                    <span className="font-mono text-body ml-1">
                      {([
                        { part: "1", kind: "plain" },
                        { part: "2", kind: "danmu" },
                        { part: "3", kind: "livechat" },
                      ] as const)
                        .map((s) => previewTitle(
                          form.uploadPartTitle,
                          selectedTask?.name || rule?.anchorName || "主播名",
                          { part: s.part, parts: "3", kind: s.kind },
                        ))
                        .join(" / ")}
                    </span>
                  )}
                </p>
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
