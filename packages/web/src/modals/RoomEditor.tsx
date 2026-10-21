/**
 * RoomEditor — `/rooms` create/edit sheet: one screen, no wizard.
 *
 * Four steps as tabs (free to jump, nothing is a wizard): 1 record (when / where / recorder options),
 * 2 process (archive vs upload, merge, versions, node capabilities), 3 upload (timing, metadata; only while
 * upload is on), 4 finish (cleanup, webhook). A flow summary stays above the tabs.
 * Desktop: centered card; phone: full-screen sheet with a pinned footer.
 *
 * Field dependencies come from room-form-rules (shared with the Hub dialog); mapping to the
 * payload from room-editor-form. Saving is one `PUT /api/rooms/:key` (backend rolls back halves).
 */
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useAtomValue } from "jotai";
import { X } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { OUTPUT_FORMATS, stageExt } from "@drec/output-format";
import { api, type PlatformDTO, type RoomDTO, type WorkerDTO } from "../api/client";
import { cookieStatusAtom } from "../atoms";
import { Button, IconButton } from "../components/Button";
import { ExperimentalBadge } from "../components/ExperimentalBadge";
import { Switch } from "../components/Switch";
import { CleanupSection } from "../components/room-form/CleanupSection";
import { RuleSwitch, ToggleRow } from "../components/room-form/parts";
import { errMessage, usePlatformCookieStatuses, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform, qualityLabel } from "../lib/labels";
import { factsOf, formFromRoom, ruleFactsOf, payloadFromForm, type RoomContext, type RoomForm } from "../lib/room-editor-form";
import { burnVersionsApply, deriveConstraints, flowSummary, settledMethod, shownOutputFormat, type Lock, type UploadMethod } from "../lib/room-form-rules";
import { accountToggleCopy, cookieReadyFor } from "../lib/room-form-rules";

interface Props {
  room: RoomDTO;
  /** Task is hub-managed (remote copy): recording half is read-only on this node. */
  managed: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** Omitted = no delete button (rule-only / managed rooms). */
  onDelete?: () => void;
}

type StepId = "record" | "process" | "upload" | "finish";
const STEPS: readonly StepId[] = ["record", "process", "upload", "finish"];

const METHODS: { id: UploadMethod; key: string; hint: string }[] = [
  { id: "after", key: "room.editor.timingAfter", hint: "roomForm.method.afterHint" },
  { id: "rolling", key: "room.editor.timingRolling", hint: "rooms.rollingUploadHint" },
  { id: "nodeSide", key: "room.editor.timingNode", hint: "room.editor.timingNodeHint" },
];

/** Current value not among candidates (old config) → keep it selectable instead of blank. */
const withCurrent = (list: readonly string[], cur: string): string[] => [...new Set([...list, cur].filter(Boolean))];
const toggleIn = (list: string[], x: string): string[] => (list.includes(x) ? list.filter((y) => y !== x) : [...list, x]);

export function Seg<T extends string>({ items, value, onChange, small }: {
  items: { id: T; label: string; lock?: Lock }[];
  value: T;
  onChange: (v: T) => void;
  small?: boolean;
}): ReactNode {
  const t = useT();
  return (
    <div className={`seg-group rm-seg${small ? " rm-seg-sm" : ""}`} role="radiogroup">
      {items.map((it) => (
        <button key={it.id} type="button" role="radio" aria-checked={value === it.id}
                disabled={it.lock?.locked} title={it.lock?.locked && it.lock.reasonKey ? t(it.lock.reasonKey) : undefined}
                className={`seg-btn${value === it.id ? " is-active" : ""}`} onClick={() => onChange(it.id)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

export function RoomEditor({ room, managed, onClose, onSaved, onDelete }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const douyinReady = !!useAtomValue(cookieStatusAtom)?.hasSession;
  const cookieStatuses = usePlatformCookieStatuses(true);
  const [form, setForm] = useState<RoomForm>(() => formFromRoom(room));
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<StepId>("record");
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);
  const [workers, setWorkers] = useState<WorkerDTO[]>([]);

  useEffect(() => {
    let alive = true;
    void api.getPlatforms().then((r) => { if (alive) setPlatforms(r.platforms ?? []); }).catch(() => {});
    void api.listWorkers().then((ws) => { if (alive) setWorkers(ws); }).catch(() => {});
    return () => { alive = false; };
  }, []);

  const plat = pickPlatform(room.room, platforms);
  // Managed task: the backend 403s recording writes → treat as "no recording half" for the payload.
  const hasRecording = !!room.recording && !managed;
  const ctx: RoomContext = {
    hasRecording,
    // A rule exists only when the API returned a processing half; a task-only room has none.
    hasRule: !!room.processing,
    danmuAvailable: plat ? plat.hasDanmu : true,
    cookieReady: cookieReadyFor(room.platform, cookieStatuses, douyinReady),
    // Douyin streams anonymously; its cookie only serves danmu. Other platforms stream with it.
    cookieForStream: room.platform !== "douyin",
  };
  const facts = ruleFactsOf(form, ctx);
  const c = deriveConstraints(facts);
  // Re-settle the upload method after every change: turning burn on / adding nodes can invalidate it.
  const update = (patch: Partial<RoomForm>): void =>
    setForm((f) => {
      const next = { ...f, ...patch };
      return { ...next, method: settledMethod(ruleFactsOf(next, ctx)) };
    });

  // The upload step only exists while upload is on; fall back to processing if it was open when that changed.
  const curStep: StepId = step === "upload" && !form.uploadOn ? "process" : step;
  // Arrow/Home/End move between enabled tabs (roving tabindex), skipping the disabled Upload step.
  const onStepKey = (e: KeyboardEvent) => {
    const keys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!keys.includes(e.key)) return;
    const ids = STEPS.filter((sid) => !(sid === "upload" && !form.uploadOn));
    const at = ids.indexOf(curStep);
    const next = e.key === "Home" ? 0 : e.key === "End" ? ids.length - 1
      : (at + (e.key === "ArrowRight" ? 1 : -1) + ids.length) % ids.length;
    e.preventDefault();
    setStep(ids[next]);
    document.getElementById(`rm-step-${ids[next]}`)?.focus();
  };
  const flow = flowSummary(facts, !!room.recording && room.recording.enabled);
  const caps = useMemo(() => [...new Set(workers.flatMap((w) => w.capabilities ?? []))], [workers]);
  const workerName = (id: string): string => workers.find((w) => w.id === id)?.name ?? id;
  const methodHint = METHODS.find((m) => m.id === form.method)?.hint ?? "";
  // Locked methods are disabled buttons; tooltips don't exist on phones, so say why in text.
  const lockedMethods = METHODS.filter((m) => m.id !== "after" && (m.id === "rolling" ? c.rolling : c.nodeSide).locked);

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (managed) return;
    const r = payloadFromForm(form, ctx);
    if (!r.ok) { toast(t("rooms.scheduleInvalid"), "error"); return; }
    setBusy(true);
    try {
      await api.updateRoom(room.key, r.payload);
      toast(t("rooms.saved"), "success");
      onSaved();
    } catch (e) {
      // Backend says which half failed and whether it rolled back — show it verbatim.
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const name = room.recording?.name || room.recording?.anchorName || room.roomSlug;

  return (
    <BaseDialog.Root open onOpenChange={(o) => !o && onClose()}>
      <BaseDialog.Portal>
        <BaseDialog.Backdrop className="modal-backdrop" />
        <div className="modal-positioner rm-editor-pos">
          <BaseDialog.Popup className="modal-card rm-editor">
            <form onSubmit={submit} className="contents">
              <div className="rm-editor-head">
                <div className="min-w-0">
                  <BaseDialog.Title className="headline text-lg leading-snug truncate">{name}</BaseDialog.Title>
                  <p className="font-mono text-[11px] text-muted mt-0.5 truncate" title={room.room}>{room.platform} · {room.room}</p>
                </div>
                <IconButton type="button" aria-label={t("common.close")} onClick={onClose}><X className="w-4 h-4" /></IconButton>
              </div>

              <div className="rm-editor-body">
                {!room.recording && <p className="status-strip">{t("room.editor.noTask")}</p>}
                {managed && <p className="status-strip">{t("room.editor.managed")}</p>}
                {/* Managed rooms are owned by the master: every control is read-only here and Save is off,
                    otherwise the processing half would still be written to this node's rule file. */}
                {/* Outside the fieldset: a managed room is read-only, but its steps must stay browsable. */}
                <div role="tablist" className="rm-steps" aria-label={t("room.editor.steps")} onKeyDown={onStepKey}>
                  {STEPS.map((sid, i) => {
                    const off = sid === "upload" && !form.uploadOn;
                    return (
                      <button key={sid} type="button" role="tab" id={`rm-step-${sid}`} aria-selected={curStep === sid} aria-controls="rm-step-panel"
                              tabIndex={curStep === sid ? 0 : -1} disabled={off} title={off ? t("room.editor.stepUploadOff") : undefined}
                              className={`rm-step${curStep === sid ? " is-active" : ""}`} onClick={() => setStep(sid)}>
                        <span className="rm-step-n">{i + 1}</span>
                        <span className="rm-step-t">{t(`room.editor.step.${sid}`)}</span>
                      </button>
                    );
                  })}
                </div>

                <fieldset disabled={managed} className="contents">

                <p className="text-xs text-muted">
                  <span className="font-mono uppercase mr-2">{t("room.editor.flow")}</span>
                  {flow.map((s) => t(s.key, s.vars)).join(" → ")}
                </p>

                <div role="tabpanel" id="rm-step-panel" aria-labelledby={`rm-step-${curStep}`} className="rm-panel">
                  {curStep === "record" && (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <label className="block min-w-0">
                          <span className="field-label">{t("room.editor.when")}</span>
                          <input className="input font-mono" placeholder={t("room.editor.whenPlaceholder")} value={form.schedule}
                                 disabled={!hasRecording} onChange={(e) => update({ schedule: e.target.value })} />
                        </label>
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
                    </>
                  )}

                  {curStep === "process" && (
                    <>
                      <div>
                        <span className="field-label">{t("room.editor.after")}</span>
                        <Seg value={form.uploadOn ? "upload" : "archive"} onChange={(v) => update({ uploadOn: v === "upload" })}
                             items={[{ id: "archive", label: t("room.archiveMode") }, { id: "upload", label: t("room.uploadMode") }]} />
                        {!form.uploadOn && <p className="text-xs text-muted mt-1">{t("room.editor.uploadOffHint")}</p>}
                      </div>
                      <section className="space-y-3">
                        <RuleSwitch checked={form.procEnabled} onChange={(procEnabled) => update({ procEnabled })} />
                        <div>
                          <span className="field-label">{t("roomForm.output")}</span>
                          <Seg value={form.mergeSegments ? "merge" : "split"} onChange={(v) => update({ mergeSegments: v === "merge" })}
                               items={[{ id: "merge", label: t("roomForm.mergeOne") }, { id: "split", label: t("roomForm.mergeSplit") }]} />
                          <p className="text-xs text-muted mt-1">{t("roomForm.outputHint")}</p>
                        </div>
                        {form.uploadOn && (
                          <ToggleRow label={t("hub.ruleDialog.toggleTsDirectLabel")} hint={t("hub.ruleDialog.toggleTsDirectSub")}
                                     checked={form.tsDirect} onChange={(tsDirect) => update({ tsDirect })} lock={c.tsDirect} />
                        )}
                        {caps.length > 0 && (
                          <div>
                            <span className="field-label">{t("room.editor.caps")}</span>
                            <div className="flex flex-wrap gap-1.5">
                              {caps.map((cap) => (
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
                      {!form.uploadOn && (
                  <label className="rm-ctx">
                    <span className="field-label !mb-0">{t("rooms.outputFormat")}</span>
                    <select className="select" value={shownOutputFormat(facts)} disabled={!hasRecording || c.outputFormat.locked}
                            onChange={(e) => update({ outputFormat: e.target.value as RoomForm["outputFormat"] })}>
                      {OUTPUT_FORMATS.map((f) => (
                        <option key={f} value={f}>{f === "original" ? t("rooms.outputFormatOriginal") : stageExt(f).slice(1).toUpperCase()}</option>
                      ))}
                    </select>
                  </label>
                      )}
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

                  {curStep === "upload" && form.uploadOn && (
                    <>
                  <div className="rm-ctx">
                    <span className="field-label !mb-0">{t("room.editor.timing")}</span>
                    <Seg small value={form.method} onChange={(method) => update({ method })}
                         items={METHODS.map((m) => ({ id: m.id, label: t(m.key), lock: m.id === "after" ? undefined : m.id === "rolling" ? c.rolling : c.nodeSide }))} />
                    <p className="text-xs text-muted">
                      {t(methodHint)}
                      {lockedMethods.map((m) => {
                        const reason = (m.id === "rolling" ? c.rolling : c.nodeSide).reasonKey;
                        return reason ? <span key={m.id} className="block text-muted-soft mt-0.5">{t(m.key)}: {t(reason)}</span> : null;
                      })}
                    </p>
                    <label className="flex items-center justify-between gap-3 cursor-pointer">
                      <span className="text-sm text-ink">{t("room.editor.public")} <span className="text-xs text-muted">· {t("room.editor.publicHint")}</span></span>
                      <Switch checked={!form.uploadPrivate} onCheckedChange={(x) => update({ uploadPrivate: !x })} />
                    </label>
                    {form.method === "rolling" && (
                      <>
                        <ToggleRow
                          nested
                          label={t("room.editor.zeroDisk")}
                          hint={t("room.editor.zeroDiskHint")}
                          checked={form.streamUpload}
                          onChange={(streamUpload) => update({ streamUpload })}
                          lock={c.streamUpload}
                          lockedChecked={false}
                          badge={<ExperimentalBadge id="stream-upload" />}
                        />
                        {form.streamUpload && c.streamUpload.locked && (
                          <ToggleRow
                            nested
                            label={t("room.editor.zeroDiskSpool")}
                            hint={t("room.editor.zeroDiskSpoolHint")}
                            checked={form.streamUploadSpool}
                            onChange={(streamUploadSpool) => update({ streamUploadSpool })}
                            lock={c.streamUpload}
                          />
                        )}
                        {form.streamUpload && !c.streamUpload.locked && (
                          <ToggleRow
                            nested
                            label={t("room.editor.zeroDiskSpool")}
                            hint={t("room.editor.zeroDiskSpoolHint")}
                            checked={form.streamUploadSpool}
                            onChange={(streamUploadSpool) => update({ streamUploadSpool })}
                          />
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

                  {curStep === "finish" && (
                    <>
                    <CleanupSection value={form} onChange={update} constraints={c} procEnabled={form.procEnabled} />

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
                {onDelete && (
                  <Button type="button" variant="secondary" className="rm-del" onClick={onDelete}>{t("room.editor.delete")}</Button>
                )}
                <span className="flex-1 rm-foot-gap" />
                <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
                <Button type="submit" disabled={busy || managed}>{busy ? t("rooms.saving") : t("rooms.save")}</Button>
              </div>
            </form>
          </BaseDialog.Popup>
        </div>
      </BaseDialog.Portal>
    </BaseDialog.Root>
  );
}
