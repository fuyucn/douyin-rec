/**
 * notifications.ts — 站内事件 → toast。轮询 GET /api/events?since=cursor,新事件按类型 + 用户
 * 开关弹 toast。首轮只「播种」游标不回放历史(避免刷新时把旧事件全弹出来)。
 *
 * 每类提醒的开关存 localStorage(纯前端偏好,无需后端);默认全开。
 */
import { useEffect, useRef } from "react";
import { showToast } from "./hooks";
import { useT } from "./i18n";
import { api } from "../api/client";
import { describeEvent } from "./notification-text";
import type { NotifKey } from "@drec/contracts";

export type { NotifKey };
/** 设置面板里展示的顺序(文案走 i18n notif.<key>)。 */
export const NOTIF_KEYS: NotifKey[] = ["live", "recordEnd", "merge", "hub", "error"];

const STORAGE = "drec.notif.toggles";
const DEFAULTS: Record<NotifKey, boolean> = { live: true, recordEnd: true, merge: true, hub: true, error: true };

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
          const d = describeEvent(e, t);
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
