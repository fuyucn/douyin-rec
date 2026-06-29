import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useAtomValue } from "jotai";
import { api, type Task, type TaskPayload, type PlatformDTO } from "../api/client";
import { cookieStatusAtom } from "../atoms";
import { Button } from "../components/Button";
import { Dialog } from "../components/Dialog";
import { Switch } from "../components/Switch";
import { errMessage, useToast } from "../lib/hooks";
import { useT } from "../lib/i18n";
import { qualityLabel, scheduleInput } from "../lib/labels";

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
  // 多节点 hub pipeline(per-task)。hubSync=总开关;其余在开启后生效。
  hubSync: boolean;
  burnDanmu: boolean;
  burnLivechat: boolean;
  clStageSourceAfterMerge: boolean;
  clSourceAfterDone: boolean;
  clStageAfterDone: boolean;
  clIncludeXmlAss: boolean;
  uploadMode: string; // "stage-only" | "auto-private"
  uploadTag: string;
  uploadTid: string;
  uploadDesc: string;
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
  hubSync: false,
  burnDanmu: true,
  burnLivechat: true,
  clStageSourceAfterMerge: false,
  clSourceAfterDone: false,
  clStageAfterDone: false,
  clIncludeXmlAss: false,
  uploadMode: "stage-only",
  uploadTag: "",
  uploadTid: "21",
  uploadDesc: "",
};

function fromTask(t: Task): FormState {
  const p = t.pipeline ?? null;
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
    hubSync: p?.sync === true,
    burnDanmu: p?.steps?.burnDanmu !== false,
    burnLivechat: p?.steps?.burnLivechat !== false,
    clStageSourceAfterMerge: p?.cleanup?.stageSourceAfterMerge === true,
    clSourceAfterDone: p?.cleanup?.sourceAfterDone === true,
    clStageAfterDone: p?.cleanup?.stageAfterDone === true,
    clIncludeXmlAss: p?.cleanup?.includeXmlAss === true,
    uploadMode: p?.upload?.mode ?? "stage-only",
    uploadTag: p?.upload?.tag ?? "",
    uploadTid: String(p?.upload?.tid ?? 21),
    uploadDesc: p?.upload?.desc ?? "",
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

/** 当前本地时间 HH:MM(schedule 提示的 {now} 插值)。 */
function schedNow(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
/** 时区后缀(" · Asia/Shanghai"),{tz} 插值。 */
function schedTz(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
    return tz ? " · " + tz : "";
  } catch {
    return "";
  }
}

/** Shared create + edit task modal (Base UI Dialog). */
export function CreateEditTaskDialog({ open, onClose, task, onSaved }: Props): ReactNode {
  const t = useT();
  const isEdit = task !== null;
  const toast = useToast();
  const [form, setForm] = useState<FormState>(BLANK);
  const [busy, setBusy] = useState(false);
  const [platforms, setPlatforms] = useState<PlatformDTO[]>([]);
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
      // 多节点 hub:开启时下发完整 per-task 配置;关闭时下发 {sync:false}(明确不 hub,可关掉旧配置)。
      pipeline: form.hubSync
        ? {
            sync: true,
            steps: { burnDanmu: form.burnDanmu, burnLivechat: form.burnLivechat },
            cleanup: {
              stageSourceAfterMerge: form.clStageSourceAfterMerge,
              sourceAfterDone: form.clSourceAfterDone,
              stageAfterDone: form.clStageAfterDone,
              includeXmlAss: form.clIncludeXmlAss,
            },
            upload: {
              mode: form.uploadMode === "auto-private" ? "auto-private" : "stage-only",
              tag: form.uploadTag.trim() || undefined,
              tid: Number(form.uploadTid) || 21,
              desc: form.uploadDesc.trim() || undefined,
            },
          }
        : { sync: false },
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
          <p className="mt-1 text-[12px] text-muted-soft">{t("dialog.schedHint", { now: schedNow(), tz: schedTz() })}</p>
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

        {/* 多节点 hub pipeline(per-task)。hubSync 总开关;开启后逐步配置。 */}
        <div className="sm:col-span-2 rounded-lg border border-hairline p-4 mt-1">
          <label className="flex items-center justify-between gap-3 cursor-pointer">
            <span className="flex flex-col">
              <span className="text-sm font-medium text-ink">多节点 hub 同步 / Multi-node hub sync</span>
              <span className="text-xs text-muted mt-0.5">开启 = 此房间由 hub 跨节点选优合并(否则只录,不 hub)</span>
            </span>
            <Switch checked={form.hubSync} onCheckedChange={(v) => set("hubSync", v)} name="hubSync" />
          </label>

          {form.hubSync && (
            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
              {([
                ["burnDanmu", "烧 danmu / 飞屏弹幕", "合成飞屏弹幕版"],
                ["burnLivechat", "烧 livechat / 聊天框", "合成聊天框版"],
                ["clStageSourceAfterMerge", "合并后删 stage 源 .ts", "留合成产物,删拉来的源片"],
                ["clSourceAfterDone", "完成后删源节点录制", "各节点原始 .ts(完成后)"],
                ["clStageAfterDone", "完成后删 stage 产物", "上传后删合成 mp4"],
                ["clIncludeXmlAss", "删除含 .xml/.ass", "默认只删 .ts/.mp4(守弹幕源)"],
              ] as const).map(([key, label, sub]) => (
                <label key={key} className="flex items-center justify-between gap-3 rounded-lg border border-hairline px-4 py-3 cursor-pointer">
                  <span className="flex flex-col">
                    <span className="text-sm font-medium text-ink">{label}</span>
                    <span className="text-xs text-muted mt-0.5">{sub}</span>
                  </span>
                  <Switch checked={form[key]} onCheckedChange={(v) => set(key, v)} name={key} />
                </label>
              ))}

              <div>
                <label className="field-label">上传 / upload mode</label>
                <select className="select" value={form.uploadMode} onChange={(e) => set("uploadMode", e.target.value)}>
                  <option value="stage-only">stage-only(只合成不上传)</option>
                  <option value="auto-private">auto-private(自动传 B站·仅自己可见)</option>
                </select>
              </div>
              <div>
                <label className="field-label">B站分区 tid</label>
                <input type="number" min={1} className="input" value={form.uploadTid} onChange={(e) => set("uploadTid", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">B站 tag(逗号分隔)</label>
                <input className="input" placeholder="直播,录像,…" value={form.uploadTag} onChange={(e) => set("uploadTag", e.target.value)} />
              </div>
              <div className="sm:col-span-2">
                <label className="field-label">B站简介 desc</label>
                <input className="input" placeholder="(可选)" value={form.uploadDesc} onChange={(e) => set("uploadDesc", e.target.value)} />
              </div>
            </div>
          )}
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
