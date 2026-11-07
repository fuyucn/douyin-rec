/**
 * RoomEditor — `/rooms` create/edit sheet: four free-to-jump step tabs, no wizard.
 *
 * One dialog serves both modes (`room === null` = create): four steps as tabs (free to jump, nothing
 * is a wizard): 1 record (when / where / recorder options), 2 process (merge, versions, node
 * capabilities), 3 upload (archive vs submit to Bilibili, then timing and metadata while submitting),
 * 4 finish (cleanup, webhook). A flow summary sits below the tabs.
 * Desktop: centered card; phone: full-screen sheet with a pinned footer.
 *
 * Field dependencies come from room-form-rules (shared with the Hub dialog); mapping + validation
 * from room-editor-form ({@link submitPayload} is the one submit path for create and edit). Saving is
 * one `POST /api/rooms` (create, both halves at once) or one `PUT /api/rooms/:key` (edit; backend
 * rolls back halves). A worker (`nodeCaps().editPipeline === false`) only edits the recording half:
 * its steps are record + finish and the hub-rule fields (process / upload / cleanup / nodes) are not
 * rendered — the backend rejects them there anyway.
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useAtomValue } from "jotai";
import { Check, X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { OUTPUT_FORMATS, stageExt } from "@drec/output-format";
import { api, type PlatformDTO, type RoomDTO, type WorkerDTO } from "../api/client";
import { cookieStatusAtom, hubEnabledAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { ExperimentalBadge } from "../components/ExperimentalBadge";
import { ModeChoices } from "../components/ModeChoices";
import { ModeLogo } from "../components/ModeLogo";
import { Switch } from "../components/Switch";
import { CleanupSection } from "../components/room-form/CleanupSection";
import { SeasonSectionField } from "../components/room-form/SeasonSectionField";
import { RuleSwitch, ToggleRow } from "../components/room-form/parts";
import { nodeCaps } from "../lib/capabilities";
import { errMessage, usePlatformCookieStatuses, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform, qualityLabel } from "../lib/labels";
import { findExistingRoom } from "../lib/room-create";
import { blankForm, factsOf, formFromRoom, isValidPartSizeInput, isValidSeasonSectionIdInput, PART_SIZE_MIB_MAX, PART_SIZE_MIB_MIN, ruleFactsOf, submitPayload, type PayloadError, type RoomContext, type RoomForm } from "../lib/room-editor-form";
import { burnVersionsApply, deriveConstraints, flowSummary, settledMethod, shownOutputFormat, taskOutputFormatLock, type UploadMethod } from "../lib/room-form-rules";
import { accountToggleCopy, cookieReadyFor } from "../lib/room-form-rules";

interface Props {
  /** `null` = 新增房间(直播间地址变成必填输入);否则编辑该房间。 */
  room: RoomDTO | null;
  /** Task is hub-managed (remote copy): recording half is read-only on this node. */
  managed: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Omitted = no delete button (new rooms have nothing to delete yet; managed rooms are read-only).
   * A rule-only room (its task already gone) is deletable too. */
  onDelete?: () => void;
}

type StepId = "record" | "process" | "upload" | "finish";
const STEPS: readonly StepId[] = ["record", "process", "upload", "finish"];
/** A worker has no hub rule to configure: only the recording half and the webhook are real there. */
const WORKER_STEPS: readonly StepId[] = ["record", "finish"];

const METHODS: { id: UploadMethod; key: string; hint: string; icon: "merge" | "segment" | "node" }[] = [
  { id: "after", key: "room.editor.timingAfter", hint: "roomForm.method.afterHint", icon: "merge" },
  { id: "rolling", key: "room.editor.timingRolling", hint: "roomForm.method.rollingHint", icon: "segment" },
  { id: "nodeSide", key: "room.editor.timingNode", hint: "roomForm.method.nodeHint", icon: "node" },
];

/** Current value not among candidates (old config) → keep it selectable instead of blank. */
const withCurrent = (list: readonly string[], cur: string): string[] => [...new Set([...list, cur].filter(Boolean))];
const toggleIn = (list: string[], x: string): string[] => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

export function RoomEditor({ room, managed, onClose, onSaved, onDelete }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const create = room === null;
  const caps = nodeCaps(useAtomValue(hubEnabledAtom));
  const douyinReady = !!useAtomValue(cookieStatusAtom)?.hasSession;
  const cookieStatuses = usePlatformCookieStatuses(true);
  const [initialForm] = useState<RoomForm | null>(() => (room ? formFromRoom(room) : null));
  const [form, setForm] = useState<RoomForm>(() => initialForm ? { ...initialForm } : blankForm());
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<StepId>("record");
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);

  useEffect(() => {
    let alive = true;
    void api.getPlatforms().then((r) => { if (alive) setPlatforms(r.platforms ?? []); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    let alive = true;
    if (caps.nodes) void api.listWorkers().then((ws) => { if (alive) setWorkers(ws); }).catch(() => {});
    return () => { alive = false; };
  }, [caps.nodes]);

  // New rooms derive the platform from the URL the user types; edit uses the stored one.
  const plat = pickPlatform(create ? form.room : room.room, platforms);
  // Platform defaults follow the typed URL, so an untouched create form still saves a valid quality/engine.
  // Edit never normalizes stored values (an old quality outside today's list stays selectable, see withCurrent).
  useEffect(() => {
    if (!create || !plat) return;
    setForm((f) => ({
      ...f,
      quality: plat.qualities.includes(f.quality) ? f.quality : plat.defaultQuality,
      engine: plat.engines.includes(f.engine) ? f.engine : plat.defaultEngine,
      // 无弹幕能力的平台(快手)→ 开关被锁,存的值也必须是关:显示与保存不能各说各话。
      danmu: plat.hasDanmu ? f.danmu : false,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plat?.id, platforms.length]);

  // Create always writes a recording half; managed tasks are read-only here → treat as "no half".
  const hasRecording = create || (!!room.recording && !managed);
  const platformId = create ? plat?.id : room.platform;
  const deliveryTouched = create || (initialForm !== null && (
    form.uploadOn !== initialForm.uploadOn
    || form.method !== initialForm.method
    || form.streamUpload !== initialForm.streamUpload
  ));
  const ctx: RoomContext = {
    hasRecording,
    // A rule existed when the editor opened only when the API returned a processing half.
    // This save writes one on the master (both create and edit); a worker creates the recording half only.
    hasRule: create ? caps.editPipeline : !!room.processing,
    writesRule: caps.editPipeline,
    deliveryTouched,
    danmuAvailable: plat ? plat.hasDanmu : true,
    cookieReady: cookieReadyFor(platformId, cookieStatuses, douyinReady),
    // Douyin streams anonymously; its cookie only serves danmu. Other platforms stream with it.
    cookieForStream: platformId !== "douyin",
  };
  const facts = ruleFactsOf(form, ctx);
  const c = deriveConstraints(facts);
  // Re-settle the upload method after every change: turning burn on / adding nodes can invalidate it.
  const update = (patch: Partial<RoomForm>): void =>
    setForm((f) => {
      const next = { ...f, ...patch };
      return { ...next, method: settledMethod(ruleFactsOf(next, ctx)) };
    });

  const steps = caps.editPipeline ? STEPS : WORKER_STEPS;
  // Arrow/Home/End move between tabs (roving tabindex).
  const onStepKey = (e: KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const at = steps.indexOf(step);
    const next = e.key === "Home" ? 0 : e.key === "End" ? steps.length - 1
      : (at + (e.key === "ArrowRight" ? 1 : -1) + steps.length) % steps.length;
    e.preventDefault();
    setStep(steps[next]);
    document.getElementById(`rm-step-${steps[next]}`)?.focus();
  };
  // A new room is created paused, so the flow starts at "not recording" (same as an off room).
  const flow = flowSummary(facts, create ? false : !!room.recording && room.recording.enabled);
  const capabilities = useMemo(() => [...new Set(workers.flatMap((w) => w.capabilities ?? []))], [workers]);
  const workerName = (id: string): string => workers.find((w) => w.id === id)?.name ?? id;
  const lockedMethods = METHODS.filter((m) => m.id !== "after" && (m.id === "rolling" ? c.rolling : c.nodeSide).locked);

  /** Payload validation failed: jump to the step that owns the field and say what is wrong. */
  const reportInvalid = (error: PayloadError): void => {
    if (error === "room") { setStep("record"); toast(t("room.editor.roomRequired"), "error"); return; }
    if (error === "schedule") { setStep("record"); toast(t("rooms.scheduleInvalid"), "error"); return; }
    setStep(caps.editPipeline ? "upload" : "record");
    toast(t("room.editor.fieldInvalid"), "error");
  };

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (managed) return;
    // Native min= validation only reaches inputs of the visible step, so re-check the numeric fields here.
    const bad: StepId | null = form.segmentSec.trim() !== "" && Number(form.segmentSec) < 0 ? "record"
      : form.uploadOn && form.tid.trim() !== "" && Number(form.tid) < 1 ? "upload"
      : form.uploadOn && !isValidSeasonSectionIdInput(form.seasonSectionId) ? "upload"
      : form.uploadOn && !isValidPartSizeInput(form.partSizeMiB) ? "upload" : null;
    if (bad) { setStep(bad); toast(t("room.editor.fieldInvalid"), "error"); return; }
    setBusy(true);
    // processing 只在主控存在:worker(或角色还没探测完 → nodeCaps 保守)上这些控件根本没渲染,
    // 用户不可能改过它们 → 整段不发,存量规则原样保留(漏发比误发安全;后端带 processing 也会 400)。
    const withProcessing = caps.editPipeline;
    // 新增与编辑走同一个 submitPayload(同一套校验/映射),入口/端点只是不同。
    try {
      if (room === null) {
        const r = submitPayload(form, ctx, { mode: "create", withProcessing });
        if (!r.ok) { reportInvalid(r.error); return; }
        // Duplicate check before writing anything (the create endpoint also returns 409).
        if (plat) {
          const dup = findExistingRoom(await api.listRooms().catch(() => []), plat.id, form.room.trim());
          if (dup) { toast(t("room.addExists"), "error"); return; }
        }
        await api.createRoom(r.payload);
        // Created paused: starting a recording is an explicit later action, never a side effect of
        // creating the room (no startTask call here — T-157).
        toast(t("room.addedPaused"), "success");
      } else {
        const r = submitPayload(form, ctx, { mode: "edit", withProcessing });
        if (!r.ok) { reportInvalid(r.error); return; }
        // No `recording.room` in the edit payload: writing the stored URL back would re-validate it.
        await api.updateRoom(room.key, r.payload);
        toast(t("rooms.saved"), "success");
      }
      onSaved();
    } catch (e) {
      // Backend says which half failed and whether it rolled back — show it verbatim.
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const name = room ? room.recording?.name || room.recording?.anchorName || room.roomSlug : "";
  // A new room needs the URL before anything can be sent; a worker's rule-only room has no half to edit.
  const canSubmit = create ? form.room.trim() !== "" : hasRecording || caps.editPipeline;

  /** Archive format, shared by the master's process tab and the worker's record tab. */
  // 锁判定「后端锁优先」:后端已明确不按所选格式处理(managedBy/规则/rolling/0 落盘)时,
  // 即便表单依赖(投稿)未锁也不给改 —— 改了会被后端忽略。后端未锁时回退表单依赖锁(投稿恒 mp4)。
  const backendFmtLock = taskOutputFormatLock({ outputFormatLock: form.outputFormatLock });
  const fmtLock = backendFmtLock.locked ? backendFmtLock : c.outputFormat;
  const outputFormatField = (
    <label className="rm-ctx">
      <span className="field-label !mb-0">{t("rooms.outputFormat")}</span>
      <select className="select" value={shownOutputFormat(facts)} disabled={!hasRecording || fmtLock.locked}
              onChange={(e) => update({ outputFormat: e.target.value as RoomForm["outputFormat"] })}>
        {OUTPUT_FORMATS.map((f) => (
          <option key={f} value={f}>{f === "original" ? t("rooms.outputFormatOriginal") : stageExt(f).slice(1).toUpperCase()}</option>
        ))}
      </select>
      {fmtLock.reasonKey && <span className="text-xs text-muted">{t(fmtLock.reasonKey)}</span>}
    </label>
  );

  return (
    <BaseDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="modal-backdrop" />
        <div className="modal-positioner rm-editor-pos">
          <BaseDialog.Popup className="modal-card rm-editor">
            <form onSubmit={submit} className="contents">
              <div className="rm-editor-head">
                <div className="min-w-0">
                  <BaseDialog.Title className="headline text-lg leading-snug truncate">{create ? t("room.addTitle") : name}</BaseDialog.Title>
                  <p className="font-mono text-[11px] text-muted mt-0.5 truncate" title={create ? form.room : room.room}>
                    {create ? t("room.addSubtitle") : `${room.platform} · ${room.room}`}
                  </p>
                </div>
                <IconButton type="button" aria-label={t("common.close")} onClick={onClose}><X className="w-4 h-4" /></IconButton>
              </div>

              <div className="rm-editor-body">
                {!create && !room.recording && <p className="status-strip">{t("room.editor.noTask")}</p>}
                {managed && <p className="status-strip">{t("room.editor.managed")}</p>}
                {/* Managed rooms are owned by the master: every control is read-only here and Save is off,
                    otherwise the processing half would still be written to this node's rule file. */}
                {/* Outside the fieldset: a managed room is read-only, but its steps must stay browsable. */}
                <div role="tablist" className="rm-steps" aria-label={t("room.editor.steps")} onKeyDown={onStepKey}>
                  {steps.map((sid, i) => {
                    return (
                      <button key={sid} type="button" role="tab" id={`rm-step-${sid}`} aria-selected={step === sid} aria-controls="rm-step-panel"
                              tabIndex={step === sid ? 0 : -1}
                              className={`rm-step${step === sid ? " is-active" : ""}`} onClick={() => setStep(sid)}>
                        <span className="rm-step-n">{i + 1}</span>
                        <span className="rm-step-t">{t(`room.editor.step.${sid}`)}</span>
                      </button>
                    );
                  })}
                </div>

                <fieldset disabled={managed} className="contents">

                {/* 流程摘要描述的是主控的流水线:worker 没有它,不渲染以免误导。 */}
                {caps.editPipeline && (
                  <p className="text-xs text-muted">
                    <span className="font-mono uppercase mr-2">{t("room.editor.flow")}</span>
                    {flow.map((s) => t(s.key, s.vars)).join(" → ")}
                  </p>
                )}

                <div role="tabpanel" id="rm-step-panel" aria-labelledby={`rm-step-${step}`} className="rm-panel">
                  {step === "record" && (
                    <>
                      {create && (
                        <label className="rm-ctx">
                          <span className="field-label !mb-0">{t("room.addRoom")}</span>
                          <input className="input font-mono text-sm" placeholder={t("dialog.roomPlaceholder")}
                                 value={form.room} autoFocus onChange={(e) => update({ room: e.target.value })} />
                        </label>
                      )}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="block min-w-0">
                          <span className="field-label">{t("room.editor.when")}</span>
                          <input className="input font-mono" placeholder={t("room.editor.whenPlaceholder")} value={form.schedule}
                                 disabled={!hasRecording} onChange={(e) => update({ schedule: e.target.value })} />
                        </label>
                        {/* Node selection is a hub-rule field: a worker only records locally and has no rule to write. */}
                        {caps.nodes ? (
                          <div className="min-w-0">
                            <span className="field-label">{t("room.editor.where")}</span>
                            <div className="flex flex-wrap gap-1.5 min-h-10 items-center">
                              {workers.map((w) => (
                                <button key={w.id} type="button" aria-pressed={form.workers.includes(w.id)}
                                        className={`chip rm-pick${form.workers.includes(w.id) ? " is-on" : ""}`}
                                        onClick={() => update({ workers: toggleIn(form.workers, w.id) })}>
                                  {w.name || w.id}
                                </button>
                              ))}
                              {form.workers.length === 0 && <span className="text-xs text-muted">{t("room.editor.whereHint")}</span>}
                            </div>
                          </div>
                        ) : (
                          <div className="min-w-0">
                            <span className="field-label">{t("room.editor.where")}</span>
                            <p className="text-xs text-muted mt-2">{t("room.editor.hubOnly")}</p>
                          </div>
                        )}
                      </div>
                      {hasRecording ? (
                        <section className="space-y-3">
                          <div className="grid grid-cols-2 gap-3">
                            <label className="block col-span-2">
                              <span className="field-label">{t("rooms.name")}</span>
                              <input className="input" value={form.name} onChange={(e) => update({ name: e.target.value })} />
                            </label>
                            <label className="block">
                              <span className="field-label">{t("rooms.quality")}</span>
                              <select className="select" value={form.quality} onChange={(e) => update({ quality: e.target.value })}>
                                {withCurrent(plat?.qualities ?? [], form.quality).map((q) => <option key={q} value={q}>{qualityLabel(q)}</option>)}
                              </select>
                            </label>
                            <label className="block">
                              <span className="field-label">{t("rooms.engine")}</span>
                              <select className="select" value={form.engine} onChange={(e) => update({ engine: e.target.value })}>
                                {withCurrent(plat?.engines ?? [], form.engine).map((x) => <option key={x} value={x}>{x}</option>)}
                              </select>
                            </label>
                            <label className="block col-span-2">
                              <span className="field-label">{t("rooms.segmentSec")}</span>
                              <input className="input" type="number" min={0} value={form.segmentSec} onChange={(e) => update({ segmentSec: e.target.value })} />
                            </label>
                          </div>
                          <ToggleRow label={t("rooms.danmu")} hint={ctx.danmuAvailable ? t("rooms.danmuHint") : t("dialog.danmuNone")}
                                     checked={form.danmu} onChange={(danmu) => update({ danmu })}
                                     lock={ctx.danmuAvailable ? undefined : { locked: true, reasonKey: "dialog.danmuNone" }} />
                          <ToggleRow label={t(accountToggleCopy(ctx).labelKey)}
                                     hint={t(accountToggleCopy(ctx).hintKey)}
                                     checked={form.useCookie} onChange={(useCookie) => update({ useCookie })} lock={c.cookie} />
                        </section>
                      ) : null}
                      {/* Live upload and archive format are task fields, so a worker keeps them. */}
                      {!caps.editPipeline && hasRecording && (
                        <ToggleRow
                          icon={<ModeLogo kind="zero-disk" className="w-[15px] h-[15px]" />}
                          label={t("room.editor.zeroDisk")}
                          hint={t("room.editor.zeroDiskHint")}
                          checked={form.streamUpload}
                          onChange={(streamUpload) => update({ streamUpload, ...(streamUpload ? { streamUploadSpool: true } : {}) })}
                          lock={ctx.hasRule && c.streamUpload.locked && !form.streamUpload ? c.streamUpload : undefined}
                          lockedChecked={false}
                          badge={<ExperimentalBadge id="stream-upload" />}
                        />
                      )}
                      {!caps.editPipeline && outputFormatField}
                      {!caps.editPipeline && (
                        <p className="text-xs text-muted">{t("room.editor.rollingByMaster")}</p>
                      )}
                    </>
                  )}

                  {caps.editPipeline && step === "process" && (
                    <>
                      <section className="space-y-3">
                        <RuleSwitch checked={form.procEnabled} onChange={(procEnabled) => update({ procEnabled })} />
                        <div>
                          <span className="field-label">{t("roomForm.output")}</span>
                          <ModeChoices
                            value={form.mergeSegments ? "merge" : "split"}
                            onChange={(v) => update({ mergeSegments: v === "merge" })}
                            items={[
                              { id: "merge", label: t("roomForm.mergeOne"), hint: t("roomForm.mergeOneHint"), icon: "merge" },
                              { id: "split", label: t("roomForm.mergeSplit"), hint: t("roomForm.mergeSplitHint"), icon: "split" },
                            ]}
                          />
                          <p className="text-xs text-muted mt-1">{t("roomForm.outputHint")}</p>
                        </div>
                        {form.uploadOn && (
                          <ToggleRow label={t("hub.ruleDialog.toggleTsDirectLabel")} hint={t("hub.ruleDialog.toggleTsDirectSub")}
                                     checked={form.tsDirect} onChange={(tsDirect) => update({ tsDirect })} lock={c.tsDirect} />
                        )}
                        {capabilities.length > 0 && (
                          <div>
                            <span className="field-label">{t("room.editor.caps")}</span>
                            <div className="flex flex-wrap gap-1.5">
                              {capabilities.map((cap) => (
                                <button key={cap} type="button" aria-pressed={form.requires.includes(cap)}
                                        className={`chip rm-pick${form.requires.includes(cap) ? " is-on" : ""}`}
                                        onClick={() => update({ requires: toggleIn(form.requires, cap) })}>{cap}</button>
                              ))}
                            </div>
                            {form.workers.some((id) => form.requires.some((r) => !(workers.find((w) => w.id === id)?.capabilities ?? []).includes(r))) && (
                              <p className="text-xs text-error-fg mt-1">
                                {t("hub.ruleDialog.capsFiltered", { workers: form.workers.filter((id) => form.requires.some((r) => !(workers.find((w) => w.id === id)?.capabilities ?? []).includes(r))).map(workerName).join("、") })}
                              </p>
                            )}
                          </div>
                        )}
                      </section>
                      {!form.uploadOn && outputFormatField}
                {burnVersionsApply(factsOf(form, ctx)) && (
                  <div>
                    <span className="field-label">{t("room.editor.versions")}</span>
                    <div className="flex flex-wrap gap-1.5">
                      <span className="chip rm-pick is-on" aria-disabled="true">{t("room.editor.original")}</span>
                      {(["burnDanmu", "burnLivechat"] as const).map((k) => (
                        <button key={k} type="button" disabled={c.burn.locked} aria-pressed={!c.burn.locked && form[k]}
                                title={c.burn.locked && c.burn.reasonKey ? t(c.burn.reasonKey) : undefined}
                                className={`chip rm-pick${!c.burn.locked && form[k] ? " is-on" : ""}`}
                                onClick={() => update({ [k]: !form[k] })}>
                          {t(k === "burnDanmu" ? "room.editor.danmuVer" : "room.editor.livechatVer")}
                        </button>
                      ))}
                    </div>
                    {c.burn.locked && c.burn.reasonKey && <p className="text-xs text-muted mt-1">{t(c.burn.reasonKey)}</p>}
                  </div>
                )}
                    </>
                  )}

                  {caps.editPipeline && step === "upload" && (
                    <>
                      <div>
                        <span className="field-label">{t("room.editor.after")}</span>
                        <ModeChoices
                          value={form.uploadOn ? "upload" : "archive"}
                          onChange={(v) => update({ uploadOn: v === "upload" })}
                          items={[
                            { id: "archive", label: t("room.archiveMode"), hint: t("room.editor.archiveHint"), icon: "archive" },
                            { id: "upload", label: t("room.uploadMode"), hint: t("room.editor.uploadHint"), icon: "bilibili" },
                          ]}
                        />
                        {!form.uploadOn && <p className="text-xs text-muted mt-1">{t("room.editor.uploadOffHint")}</p>}
                      </div>
                    {form.uploadOn && (
                    <>
                  <div className="rm-ctx">
                    <span className="field-label !mb-0">{t("room.editor.timing")}</span>
                    <ModeChoices
                      small
                      columns={3}
                      value={form.method}
                      onChange={(method) => update({ method })}
                      items={METHODS.map((m) => ({
                        id: m.id,
                        label: t(m.key),
                        hint: t(m.hint),
                        icon: m.icon,
                        disabled: m.id !== "after" && (m.id === "rolling" ? c.rolling : c.nodeSide).locked,
                        disabledReason: (() => {
                          const reason = (m.id === "rolling" ? c.rolling : c.nodeSide).reasonKey;
                          return reason ? t(reason) : undefined;
                        })(),
                      }))}
                    />
                    {lockedMethods.length > 0 && (
                      <div className="text-xs text-muted-soft space-y-0.5">
                        {lockedMethods.map((m) => {
                          const reason = (m.id === "rolling" ? c.rolling : c.nodeSide).reasonKey;
                          return reason ? <p key={m.id}>{t(m.key)}: {t(reason)}</p> : null;
                        })}
                      </div>
                    )}
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span className="text-sm text-ink">{t("room.editor.public")} <span className="text-xs text-muted">· {t("room.editor.publicHint")}</span></span>
                      <Switch checked={!form.uploadPrivate} onCheckedChange={(x) => update({ uploadPrivate: !x })} />
                    </label>
                    {form.method === "rolling" && (
                      <>
                        <ToggleRow
                          nested
                          icon={<ModeLogo kind="zero-disk" className="w-[15px] h-[15px]" />}
                          label={t("room.editor.zeroDisk")}
                          hint={t("room.editor.zeroDiskHint")}
                          checked={form.streamUpload}
                          onChange={(streamUpload) => update({ streamUpload })}
                          lock={c.streamUpload}
                          lockedChecked={false}
                          badge={<ExperimentalBadge id="stream-upload" />}
                        />
                        {form.streamUpload && (
                          <div className="flex items-start gap-2 rounded-lg border border-line px-3 py-2 text-sm text-ink">
                            <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                            <div>
                              <div>{t("room.editor.zeroDiskSpool")}</div>
                              <div className="text-xs text-muted">{t("room.editor.zeroDiskSpoolHint")}</div>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                      <section className="space-y-3">
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="field-label">{t("room.editor.tid")}</span>
                            <input className="input" type="number" min={1} value={form.tid} onChange={(e) => update({ tid: e.target.value })} />
                          </label>
                          <label className="block">
                            <span className="field-label">{t("room.editor.tag")}</span>
                            <input className="input" placeholder={t("hub.ruleDialog.tagPlaceholder")} value={form.tag} onChange={(e) => update({ tag: e.target.value })} />
                          </label>
                          <SeasonSectionField value={form.seasonSectionId} onChange={(seasonSectionId) => update({ seasonSectionId })} />
                          {form.streamUpload && (
                            <label className="block sm:col-span-2">
                              <span className="field-label">{t("room.editor.partSize")}</span>
                              <input type="number" min={PART_SIZE_MIB_MIN} max={PART_SIZE_MIB_MAX} className="input font-mono text-sm"
                                     placeholder={t("room.editor.partSizePlaceholder")}
                                     value={form.partSizeMiB} onChange={(e) => update({ partSizeMiB: e.target.value })} />
                              <p className="text-[11px] text-muted-soft mt-1">{t("room.editor.partSizeHint", { min: PART_SIZE_MIB_MIN, max: PART_SIZE_MIB_MAX })}</p>
                            </label>
                          )}
                          {([
                            ["titleTemplate", "room.editor.titleTemplate", "{name}_{date}"],
                            ["submissionTitleTemplate", "room.editor.submissionTitle", t("hub.ruleDialog.submissionTitleTemplatePlaceholder")],
                            ["partTitleTemplate", "room.editor.partTitle", t("hub.ruleDialog.partTitleTemplatePlaceholder")],
                          ] as const).map(([k, label, ph]) => (
                            <label key={k} className="block col-span-2">
                              <span className="field-label">{t(label)}</span>
                              <input className="input font-mono text-sm" placeholder={ph} value={form[k]} onChange={(e) => update({ [k]: e.target.value })} />
                            </label>
                          ))}
                          <label className="block col-span-2">
                            <span className="field-label">{t("room.editor.desc")}</span>
                            <textarea className="textarea font-mono text-sm" rows={3} placeholder={t("hub.ruleDialog.descPlaceholder")}
                                      value={form.desc} onChange={(e) => update({ desc: e.target.value })} />
                          </label>
                        </div>
                      </section>
                    </>
                    )}
                    </>
                  )}

                  {step === "finish" && (
                    <>
                    {/* Cleanup is a master-side stage/source action: a worker creates no rule to run it. */}
                    {caps.editPipeline && <CleanupSection value={form} onChange={update} constraints={c} procEnabled={form.procEnabled} />}

                    {hasRecording && (
                      <label className="block">
                        <span className="field-label">{t("room.editor.webhook")}</span>
                        <input className="input font-mono text-sm" value={form.webhook} disabled={form.webhookClear}
                               placeholder={form.hasWebhook && !form.webhookClear ? t("dialog.webhookPlaceholderSet") : t("dialog.webhookPlaceholder")}
                               onChange={(e) => update({ webhook: e.target.value })} />
                        {form.hasWebhook && (
                          <label className="flex items-center gap-2 text-xs mt-1">
                            <input type="checkbox" checked={form.webhookClear} onChange={(e) => update({ webhookClear: e.target.checked })} />
                            {t("dialog.webhookClear")}
                          </label>
                        )}
                      </label>
                    )}
                    </>
                  )}
                </div>
                </fieldset>
              </div>

              <div className="rm-editor-foot">
                {!create && onDelete && (
                  <Button type="button" variant="secondary" className="rm-del" onClick={onDelete}>{t("room.editor.delete")}</Button>
                )}
                <span className="flex-1 rm-foot-gap" />
                <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
                <Button type="submit" disabled={busy || managed || !canSubmit}>
                  {busy ? t("rooms.saving") : create ? t("room.addSubmit") : t("rooms.save")}
                </Button>
              </div>
            </form>
          </BaseDialog.Popup>
        </div>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
