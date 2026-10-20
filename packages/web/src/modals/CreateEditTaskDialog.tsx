import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { api, type Task, type TaskPayload, type PlatformDTO } from "../api/client";
import { cookieStatusAtom, serverTimezoneAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { NotifySection } from "../components/room-form/NotifySection";
import { webhookPatch } from "../lib/room-editor-form";
import { RecordingSection } from "../components/room-form/RecordingSection";
import { ToggleRow } from "../components/room-form/parts";
import { ExperimentalBadge } from "../components/ExperimentalBadge";
import { Tooltip } from "../components/Tooltip";
import { errMessage, usePlatformCookieStatuses, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { pickPlatform, scheduleInput } from "../lib/labels";
import { cookieLock, cookieReadyFor, outputFormatFromStored, taskOutputFormatLock } from "../lib/room-form-rules";
import type { OutputFormat } from "@drec/output-format";
import { fmtTimeInTz, localTimeTooltip } from "../lib/tz";

interface Props {
  open: boolean;
  onClose: () => void;
  /** null = create mode; a task = edit that task. */
  task: Task | null;
  /** Called after a successful create/update so the caller can refresh. */
  onSaved: () => void;
}

interface FormState {
  room: string;
  name: string;
  quality: string;
  engine: string;
  segmentSec: string;
  schedule: string;
  danmu: boolean;
  useCookie: boolean;
  outputFormat: OutputFormat;
  /** New webhook typed by the user; the stored one is never sent to the client (see webhookPatch). */
  webhook: string;
  hasWebhook: boolean;
  webhookClear: boolean;
  /** 0 落盘流式直传(plans/039):源录像不落盘,边录边传 B 站。 */
  streamUpload: boolean;
  /** 真 0 落盘 = 连 spool 都不写;代价是分 P 上传失败时没有本地回退源。 */
  streamUploadSpool: boolean;
}

const BLANK: FormState = {
  room: "",
  name: "",
  quality: "",
  engine: "",
  segmentSec: "1800",
  schedule: "",
  danmu: true,
  useCookie: true,
  outputFormat: "original",
  webhook: "",
  hasWebhook: false,
  webhookClear: false,
  streamUpload: false,
  streamUploadSpool: true,
};

function fromTask(t: Task): FormState {
  return {
    room: t.room ?? "",
    name: t.name ?? "",
    quality: t.quality ?? "",
    engine: t.engine ?? "",
    segmentSec: String(t.segmentSec ?? 0),
    schedule: scheduleInput(t),
    danmu: !!t.danmu,
    useCookie: !!t.useCookie,
    outputFormat: outputFormatFromStored(t.outputFormat),
    webhook: "",
    hasWebhook: t.hasWebhook === true,
    webhookClear: false,
    // 旧后端不下发该字段 → undefined → false(行为同改前)。
    streamUpload: t.streamUpload === true,
    streamUploadSpool: t.streamUploadSpool !== false,
  };
}

/** 时区后缀(" · Asia/Shanghai"),{tz} 插值。 */
function schedTzLabel(tz: string): string {
  return tz ? " · " + tz : "";
}

/** Shared create + edit task modal (Base UI Dialog). */
export function CreateEditTaskDialog({ open, onClose, task, onSaved }: Props): ReactNode {
  const t = useT();
  const isEdit = task !== null;
  const toast = useToast();
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);
  const serverTz = useAtomValue(serverTimezoneAtom);
  // 含礼物需要已登录的全局 cookie；没有则禁用「弹幕含礼物」开关（拿不到礼物）。
  const cookieStatus = useAtomValue(cookieStatusAtom);
  const cookieStatuses = usePlatformCookieStatuses(open);

  // 平台清单(画质/录制器/弹幕选项的来源)。打开时拉一次,失败静默(选项退化为当前值)。
  useEffect(() => {
    if (!open) return;
    let alive = true;
    void api.getPlatforms().then((r) => alive && setPlatforms(r.platforms)).catch(() => {});
    return () => {
      alive = false;
    };
  }, [open]);

  // 仅在「打开」或「切换到不同任务」时 seed 表单。**故意只依赖 task?.id 而非 task 对象**:
  // 详情页每 2s 轮询会返回新 task 对象(引用变),依赖整对象会周期性把编辑中的表单重置回库值。
  useEffect(() => {
    if (open) setForm(task ? fromTask(task) : BLANK);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, task?.id]);

  const plat = pickPlatform(form.room, platforms);

  // 平台确定/切换时:把 quality/recorder **复校到该平台合法值**(非法→平台默认)。
  // 既给空白表单填默认,也在「改 room 换平台」时纠正旧平台的残留值。合法值保留(无副作用)。
  useEffect(() => {
    if (!plat) return;
    setForm((f) => {
      const quality = plat.qualities.includes(f.quality) ? f.quality : plat.defaultQuality;
      const engine = plat.engines.includes(f.engine) ? f.engine : plat.defaultEngine;
      if (quality === f.quality && engine === f.engine) return f;
      return { ...f, quality, engine };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plat?.id, platforms.length]);

  function set<K extends keyof FormState>(key: K, value: FormState[K]): void {
    setForm((f) => ({ ...f, [key]: value }));
  }

  // 输出格式只对无后处理的任务生效(节点侧原地替换);后端判定不适用(受管 / 有规则 / 边录边传)→ 锁定,不随保存提交(避免改掉规则侧的存档格式)。
  const formatLock = taskOutputFormatLock({ outputFormatLock: task?.outputFormatLock });
  const danmuAvailable = plat ? plat.hasDanmu : true;
  // 抖音取流恒匿名,Cookie 只服务弹幕;B站/快手用它取流(锁定口径见 room-form-rules)。
  const cookieForStream = plat ? plat.id !== "douyin" : false;
  const cookieReady = cookieReadyFor(plat?.id, cookieStatuses, !!cookieStatus?.hasSession);
  // Zero-disk is configured on the room editor (rolling sub-option); the task dialog only
  // shows the legacy switch for tasks that already carry it. New/changed zero-disk settings
  // must go through the room editor so the rule and task are written together.
  const zeroDiskManaged = isEdit && task?.streamUpload === true;

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    const payload: TaskPayload = {
      room: form.room.trim(),
      name: form.name.trim() || null,
      quality: form.quality,
      engine: form.engine || undefined,
      segmentSec: Number(form.segmentSec) || 0,
      danmu: form.danmu ? 1 : 0,
      // 原值提交:未登录时开关只是锁定显示,不能借保存把任务的 Cookie 设置改掉(与房间面板 / 规则弹窗同口径)。
      useCookie: form.useCookie,
      schedule: form.schedule.trim() || null,
      ...webhookPatch(form.webhook, form.webhookClear),
      // Preserve the stored zero-disk fields; the room editor is the only writer.
      ...(zeroDiskManaged ? { streamUpload: form.streamUpload, streamUploadSpool: form.streamUploadSpool } : {}),
      ...(formatLock.locked ? {} : { outputFormat: form.outputFormat }),
    };
    setBusy(true);
    try {
      if (isEdit) await api.updateTask(task.id, payload);
      else await api.createTask(payload);
      onClose();
      toast(isEdit ? t("dialog.updated") : t("dialog.created"), "success");
      onSaved();
    } catch (e) {
      toast(isEdit ? t("dialog.updateFailed", { msg: errMessage(e) }) : t("dialog.createFailed", { msg: errMessage(e) }), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      widthClass="max-w-2xl"
      title={isEdit ? t("dialog.editTitle") : t("dialog.createTitle")}
      description={t("dialog.desc")}
    >
      {isEdit && task?.running && (
        <p className="text-sm mb-4 text-warning-fg">
          {t("dialog.runningWarn")}
        </p>
      )}

      <form className="space-y-7" onSubmit={submit}>
        <RecordingSection
          value={{ ...form, recEnabled: true }}
          onChange={(patch) => setForm((f) => ({ ...f, ...patch }))}
          showName
          outputFormat={{
            value: form.outputFormat,
            shown: form.outputFormat,
            lock: formatLock,
            hintKey: "dialog.outputFormatHint",
            onChange: (outputFormat) => set("outputFormat", outputFormat),
          }}
          qualities={plat?.qualities ?? []}
          engines={plat?.engines ?? []}
          danmuAvailable={danmuAvailable}
          cookie={cookieLock({ danmu: form.danmu, danmuAvailable, cookieReady, cookieForStream })}
          cookieForStream={cookieForStream}
          scheduleHint={
            <Tooltip
              content={localTimeTooltip(new Date(), serverTz, (tz, local) =>
                t("common.localTimeTooltip", { serverTz: tz, local }),
              )}
            >
              <span>{t("dialog.schedHint", { now: fmtTimeInTz(new Date(), serverTz), tz: schedTzLabel(serverTz) })}</span>
            </Tooltip>
          }
        >
          <div>
            <label className="field-label">
              {t("dialog.room")}<span className="text-error-fg">*</span>
            </label>
            <input
              required
              className="input"
              placeholder={t("dialog.roomPlaceholder")}
              value={form.room}
              onChange={(e) => set("room", e.target.value)}
            />
            {plat && <p className="mt-1 text-xs text-muted-soft">{t("dialog.platform", { id: plat.id })}</p>}
          </div>
        </RecordingSection>
        <NotifySection webhook={form.webhook} onChange={(v) => set("webhook", v)}
                       hasStored={form.hasWebhook} clear={form.webhookClear} onClearChange={(v) => set("webhookClear", v)} />
        {/* 边录边传已迁到 hub 规则(上传方式 = 边录边传,issue #40);task 只保留录制参数。
            旧开关为 true 的任务只读提示一下,不可在此修改。 */}
        {isEdit && task?.rollingUpload === true && <p className="text-xs text-muted">{t("rooms.rollingLegacyNote")}</p>}
        {/* Zero-disk moved under the room editor's rolling sub-option. Keep the legacy
            read-only switch visible so an existing task is not silently changed here. */}
        {zeroDiskManaged && (
          <ToggleRow
            label={t("dialog.streamUpload")}
            hint={t("dialog.streamUploadMoved")}
            checked={form.streamUpload}
            onChange={() => {}}
            lock={{ locked: true }}
            lockedChecked
            badge={<ExperimentalBadge id="stream-upload" />}
          />
        )}

        <div className="flex justify-end gap-3">
          <Button type="button" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" disabled={busy} loading={busy}>
            {isEdit ? t("dialog.saveEdit") : t("dialog.create")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
