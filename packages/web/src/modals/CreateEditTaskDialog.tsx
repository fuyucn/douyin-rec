import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { api, type Task, type TaskPayload, type PlatformDTO } from "../api/client";
import { cookieStatusAtom, serverTimezoneAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Switch } from "../components/Switch";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { qualityLabel, scheduleInput } from "../lib/labels";
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
  webhook: string;
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
  webhook: "",
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
    webhook: t.webhook ?? "",
  };
}

/**
 * 按直播间地址判平台(客户端,最简单):http(s) URL 用各平台 urlPattern 匹配;裸房间号或无命中
 * → 回落 platforms[0](默认平台,与后端 platformForRoom 一致)。平台决定画质/录制器/弹幕选项。
 */
function pickPlatform(room: string, platforms: PlatformDTO[]): PlatformDTO | undefined {
  if (!platforms.length) return undefined;
  if (/^https?:\/\//.test(room)) {
    for (const p of platforms) {
      if (!p.urlPattern) continue;
      try {
        if (new RegExp(p.urlPattern).test(room)) return p;
      } catch {
        /* 坏 pattern 跳过 */
      }
    }
  }
  return platforms[0];
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
  const cookieReady = !!cookieStatus?.hasSession;

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

  // 选项列表:平台清单 + 当前值(确保当前值始终可见,即便平台未加载完)。
  const opts = (list: readonly string[] | undefined, current: string): string[] =>
    [...new Set([...(list ?? []), current].filter(Boolean))];
  const danmuAvailable = plat ? plat.hasDanmu : true;

  async function submit(ev: FormEvent): Promise<void> {
    ev.preventDefault();
    const payload: TaskPayload = {
      room: form.room.trim(),
      name: form.name.trim() || null,
      quality: form.quality,
      engine: form.engine || undefined,
      segmentSec: Number(form.segmentSec) || 0,
      danmu: form.danmu ? 1 : 0,
      // 顶部统一管理全局 cookie；此开关决定本任务是否带 cookie 抓弹幕。
      useCookie: cookieReady && form.useCookie,
      schedule: form.schedule.trim() || null,
      webhook: form.webhook.trim() || null,
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
        <p className="text-sm mb-4" style={{ color: "var(--warning)" }}>
          {t("dialog.runningWarn")}
        </p>
      )}

      <form className="grid grid-cols-1 sm:grid-cols-2 gap-4" onSubmit={submit}>
        <div className="sm:col-span-2">
          <label className="field-label">
            {t("dialog.room")}<span style={{ color: "var(--error)" }}>*</span>
          </label>
          <input
            required
            className="input"
            placeholder={t("dialog.roomPlaceholder")}
            value={form.room}
            onChange={(e) => set("room", e.target.value)}
          />
          {plat && <p className="mt-1 text-[12px] text-muted-soft">{`平台 / platform: ${plat.id}`}</p>}
        </div>

        <div>
          <label className="field-label">{t("dialog.name")}</label>
          <input
            className="input"
            placeholder={t("dialog.namePlaceholder")}
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
          />
        </div>

        <div>
          <label className="field-label">{t("dialog.quality")}</label>
          <select className="select" value={form.quality} onChange={(e) => set("quality", e.target.value)}>
            {opts(plat?.qualities, form.quality).map((q) => (
              <option key={q} value={q}>
                {qualityLabel(q)}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label">{t("dialog.recorder")}</label>
          <select className="select" value={form.engine} onChange={(e) => set("engine", e.target.value)}>
            {opts(plat?.engines, form.engine).map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label">{t("dialog.segment")}</label>
          <input
            type="number"
            min={0}
            className="input"
            value={form.segmentSec}
            onChange={(e) => set("segmentSec", e.target.value)}
          />
        </div>

        <div>
          <label className="field-label">{t("dialog.scheduleWindow")}</label>
          <input
            className="input"
            placeholder={t("dialog.schedulePlaceholder")}
            value={form.schedule}
            onChange={(e) => set("schedule", e.target.value)}
          />
          <p
            className="mt-1 text-[12px] text-muted-soft cursor-help"
            title={localTimeTooltip(new Date(), serverTz, (local) => t("common.localTimeTooltip", { local }))}
          >
            {t("dialog.schedHint", { now: fmtTimeInTz(new Date(), serverTz), tz: schedTzLabel(serverTz) })}
          </p>
        </div>

        <div className="sm:col-span-2">
          <label className="field-label">{t("dialog.webhook")}</label>
          <input
            className="input"
            placeholder={t("dialog.webhookPlaceholder")}
            value={form.webhook}
            onChange={(e) => set("webhook", e.target.value)}
          />
          <p className="mt-1 text-[12px] text-muted-soft">{t("dialog.webhookHint")}</p>
        </div>

        <div className="sm:col-span-2 grid grid-cols-1 sm:grid-cols-2 gap-3 mt-1">
          <label
            className={`flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 ${danmuAvailable ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
          >
            <span className="flex flex-col">
              <span className="text-sm font-medium text-ink">{t("dialog.recDanmu")}</span>
              <span className="text-xs text-muted mt-0.5">
                {danmuAvailable ? (form.danmu ? t("common.on") : t("common.off")) : t("dialog.danmuNone")}
              </span>
            </span>
            <Switch checked={danmuAvailable && form.danmu} onCheckedChange={(v) => set("danmu", v)} name="danmu" disabled={!danmuAvailable} />
          </label>
          <label
            className={`flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 ${cookieReady && danmuAvailable ? "cursor-pointer" : "opacity-60 cursor-not-allowed"}`}
          >
            <span className="flex flex-col">
              <span className="text-sm font-medium text-ink">{t("dialog.danmuGift")}</span>
              <span className="text-xs text-muted mt-0.5">
                {!cookieReady ? t("dialog.giftNeedCookie") : form.useCookie ? t("dialog.giftOn") : t("dialog.giftOff")}
              </span>
            </span>
            <Switch
              checked={cookieReady && danmuAvailable && form.useCookie}
              onCheckedChange={(v) => set("useCookie", v)}
              name="useCookie"
              disabled={!cookieReady || !danmuAvailable}
            />
          </label>
        </div>

        <div className="sm:col-span-2 flex justify-end gap-3 mt-3">
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
