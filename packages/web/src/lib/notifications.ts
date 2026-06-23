/**
 * notifications.ts — 站内事件 → toast。轮询 GET /api/events?since=cursor,新事件按类型 + 用户
 * 开关弹 toast。首轮只「播种」游标不回放历史(避免刷新时把旧事件全弹出来)。
 *
 * 每类提醒的开关存 localStorage(纯前端偏好,无需后端);默认全开。
 */
import { useEffect, useRef } from "react";
import { showToast, type ToastType } from "./hooks";
import { useT } from "./i18n";
import { api, type AppEventDTO } from "../api/client";

export type NotifKey = "live" | "recordEnd" | "merge" | "error";
/** 设置面板里展示的顺序(文案走 i18n notif.<key>)。 */
export const NOTIF_KEYS: NotifKey[] = ["live", "recordEnd", "merge", "error"];

const STORAGE = "drec.notif.toggles";
const DEFAULTS: Record<NotifKey, boolean> = { live: true, recordEnd: true, merge: true, error: true };

export function getToggles(): Record<NotifKey, boolean> {
  try {
    const raw = localStorage.getItem(STORAGE);
    if (raw) return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Record<NotifKey, boolean>>) };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function setToggle(key: NotifKey, on: boolean): void {
  const next = { ...getToggles(), [key]: on };
  try {
    localStorage.setItem(STORAGE, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** 取路径末段(显示用)。 */
function baseName(p?: string): string {
  if (!p) return "";
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** 事件 → { 开关键, 文案(经 i18n), toast 类型 };null = 不提醒此类。 */
function describe(e: AppEventDTO, t: T): { key: NotifKey; message: string; type: ToastType } | null {
  const ev = e.event as Record<string, unknown> & { kind: string };
  const s = (k: string): string => String(ev[k] ?? "");
  switch (ev.kind) {
    case "recordStart":
      return { key: "live", message: t("notif.evLive", { anchor: s("anchor") }), type: "info" };
    case "recordEnd":
      return { key: "recordEnd", message: t("notif.evRecordEnd", { anchor: s("anchor") }), type: "success" };
    case "mergeDone":
      return { key: "merge", message: t("notif.evMerge", { file: baseName(s("file")) }), type: "success" };
    case "burnDone":
      return { key: "merge", message: t("notif.evBurn", { file: baseName(s("file")) }), type: "success" };
    case "uploadDone":
      return { key: "merge", message: t("notif.evUpload", { bv: s("bv") }), type: "success" };
    case "error":
      return { key: "error", message: t("notif.evError", { stage: s("stage"), message: s("message") }), type: "error" };
    default:
      return null;
  }
}

/** 挂载一次(App 级):轮询站内事件流 → 按开关弹 toast。 */
export function useEventNotifications(): void {
  const t = useT();
  const cursor = useRef(0);
  const seeded = useRef(false);

  useEffect(() => {
    let alive = true;
    const tick = async (): Promise<void> => {
      try {
        const { events, cursor: next } = await api.getEvents(cursor.current);
        cursor.current = next;
        if (!seeded.current) {
          seeded.current = true; // 首轮只播种游标,不回放历史
          return;
        }
        if (!alive) return;
        const toggles = getToggles();
        for (const e of events) {
          const d = describe(e, t);
          if (d && toggles[d.key]) showToast(d.message, d.type);
        }
      } catch {
        /* 下次再试 */
      }
    };
    void tick();
    const h = setInterval(() => void tick(), 2500);
    return () => {
      alive = false;
      clearInterval(h);
    };
  }, [t]);
}
