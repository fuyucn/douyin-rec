import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { api, type PlatformDTO, type WorkerDTO } from "../api/client";
import { Button } from "../components/Button";
import { Switch } from "../components/Switch";
import { Dialog } from "../components/Dialog";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform } from "../lib/labels";
import { findCreatedRoom, findExistingRoom, newRoomTaskPayload, planNewRoomRule } from "../lib/room-create";
import { OUTPUT_FORMATS, stageExt, type OutputFormat } from "@drec/output-format";
import { Seg } from "./RoomEditor";

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  /** hub master 才下发节点与规则;worker 上只建录制任务。 */
  hubEnabled: boolean;
  workers: WorkerDTO[];
}

type Mode = "archive" | "upload";

const BLANK = {
  room: "", name: "", schedule: "", quality: "", engine: "", danmu: true, useCookie: true,
  outputFormat: "original" as OutputFormat, uploadPrivate: true, workers: [] as string[],
};

/**
 * Add-room dialog for `/rooms`. Same wording and controls as the room editor, but only the fields
 * that matter for a brand-new room; it creates the recording task and, on a hub master, the room's
 * hub rule (节点 + 存档/上传) in one go. The old task dialog stays untouched for the task pages.
 */
export function AddRoomDialog({ open, onClose, onSaved, hubEnabled, workers }: Props): ReactNode {
  const t = useT();
  const toast = useToast();
  const [form, setForm] = useState({ ...BLANK });
  const [mode, setMode] = useState<Mode>("archive");
  const [busy, setBusy] = useState(false);
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);

  useEffect(() => {
    if (!open) return;
    setForm({ ...BLANK });
    setMode("archive");
    let alive = true;
    void api.getPlatforms().then((r) => alive && setPlatforms(r.platforms)).catch(() => {});
    return () => { alive = false; };
  }, [open]);

  const plat = pickPlatform(form.room, platforms);
  // Platform defaults follow the room URL, so an untouched form still saves a valid quality/engine.
  useEffect(() => {
    if (!plat) return;
    setForm((f) => ({
      ...f,
      quality: plat.qualities.includes(f.quality) ? f.quality : plat.defaultQuality,
      engine: plat.engines.includes(f.engine) ? f.engine : plat.defaultEngine,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plat?.id, platforms.length]);

  const roomOk = form.room.trim().length > 0;

  function toggleWorker(id: string): void {
    setForm((f) => ({ ...f, workers: f.workers.includes(id) ? f.workers.filter((x) => x !== id) : [...f.workers, id] }));
  }

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    if (!roomOk) return;
    setBusy(true);
    let partial = false;
    try {
      if (plat) {
        const dup = findExistingRoom(await api.listRooms().catch(() => []), plat.id, form.room.trim());
        if (dup) { toast(t("room.addExists"), "error"); return; }
      }
      const payload = newRoomTaskPayload(
        { ...form, quality: form.quality || plat?.defaultQuality || "origin" },
        mode,
      );
      const task = await api.createTask(payload);
      if (hubEnabled && plat) {
        // The task API returns no slug, so resolve it from the room list (one extra read, only on create).
        // Match by task id; if it isn't found, tell the user instead of writing a rule under a guessed
        // key (a wrong key would silently never match the recording).
        const rooms = await api.listRooms().catch(() => []);
        const created = findCreatedRoom(rooms, task.id);
        if (created) {
          const plan = planNewRoomRule({
            taskId: task.id, mode, danmu: form.danmu, uploadPrivate: form.uploadPrivate,
            workers: form.workers, hasExistingRule: created.processing !== null && created.processing !== undefined,
          });
          try {
            if (plan.kind === "create") await api.createHubRule(plan.payload);
            else {
              // Never rewrite an existing rule: only point it at the task we just created.
              await api.updateHubRule(created.key, { recording: { sourceTaskId: plan.taskId } });
              toast(t("room.addBoundExisting"), "success");
            }
          } catch (err) {
            // Half-done: say so once. A following "added" toast would contradict the error.
            toast(t("room.addRuleFailed", { msg: errMessage(err) }), "error");
            partial = true;
          }
        } else {
          toast(t("room.addNoRule"), "error");
          partial = true;
        }
      }
      if (!partial) toast(t("room.added"), "success");
      onSaved();
    } catch (e) {
      toast(errMessage(e), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t("room.addTitle")} description={t("room.addSubtitle")}>
      <form onSubmit={submit} className="contents">
        <div className="rm-editor-body">
          <div>
            <span className="field-label">{t("room.addAfter")}</span>
            <Seg value={mode} onChange={setMode}
                 items={[{ id: "archive", label: t("room.archiveMode") }, { id: "upload", label: t("room.uploadMode") }]} />
          </div>

          <label className="rm-ctx">
            <span className="field-label !mb-0">{t("room.addRoom")}</span>
            <input className="input font-mono text-sm" placeholder={t("dialog.roomPlaceholder")}
                   value={form.room} onChange={(e) => setForm((f) => ({ ...f, room: e.target.value }))} autoFocus />
          </label>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="rm-ctx">
              <span className="field-label !mb-0">{t("room.addName")}</span>
              <input className="input text-sm" placeholder={t("room.addNamePlaceholder")}
                     value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
            </label>
            <label className="rm-ctx">
              <span className="field-label !mb-0">{t("room.addSchedule")}</span>
              <input className="input font-mono text-sm" placeholder={t("room.editor.whenPlaceholder")}
                     value={form.schedule} onChange={(e) => setForm((f) => ({ ...f, schedule: e.target.value }))} />
            </label>
          </div>

          {hubEnabled && (
            <div>
              <span className="field-label">{t("room.editor.where")}</span>
              <div className="flex flex-wrap gap-1.5">
                {workers.map((w) => (
                  <button key={w.id} type="button" aria-pressed={form.workers.includes(w.id)}
                          className={`chip rm-pick font-mono${form.workers.includes(w.id) ? " is-on" : ""}`}
                          onClick={() => toggleWorker(w.id)}>
                    {w.name || w.id}
                  </button>
                ))}
              </div>
              <p className="text-xs text-muted mt-1">{t("room.editor.whereHint")}</p>
            </div>
          )}

          {mode === "upload" ? (
            <div className="rm-ctx">
              <span className="field-label !mb-0">{t("room.addUpload")}</span>
              <p className="text-xs text-muted">{t("room.addUploadHint")}</p>
              <label className="flex items-center justify-between gap-3 cursor-pointer mt-2">
                <span className="text-sm text-ink">{t("room.editor.public")} <span className="text-xs text-muted">· {t("room.editor.publicHint")}</span></span>
                <Switch checked={!form.uploadPrivate} onCheckedChange={(x) => setForm((f) => ({ ...f, uploadPrivate: !x }))} />
              </label>
            </div>
          ) : (
            <label className="rm-ctx">
              <span className="field-label !mb-0">{t("rooms.outputFormat")}</span>
              <select className="select" value={form.outputFormat}
                      onChange={(e) => setForm((f) => ({ ...f, outputFormat: e.target.value as OutputFormat }))}>
                {OUTPUT_FORMATS.map((f) => (
                  <option key={f} value={f}>{f === "original" ? t("rooms.outputFormatOriginal") : stageExt(f).slice(1).toUpperCase()}</option>
                ))}
              </select>
            </label>
          )}

          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="text-sm text-ink">{t("rooms.danmu")} <span className="text-xs text-muted">· {t("rooms.danmuHint")}</span></span>
            <Switch checked={form.danmu} disabled={plat ? !plat.hasDanmu : false} onCheckedChange={(x) => setForm((f) => ({ ...f, danmu: x }))} />
          </label>
        </div>

        <div className="rm-editor-foot">
          <span className="flex-1 rm-foot-gap" />
          <Button type="button" variant="secondary" onClick={onClose}>{t("hub.common.cancel")}</Button>
          <Button type="submit" disabled={busy || !roomOk}>{busy ? t("rooms.saving") : t("room.addSubmit")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
