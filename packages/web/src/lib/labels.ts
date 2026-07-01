/** Shared display-label helpers (quality, schedule, clock formatting). */
import type { Task } from "../api/client";
import { fmtDateTimeInTz } from "./tz";

export const QUALITY_SHORT: Record<string, string> = {
  origin: "OD",
  uhd: "UHD",
  hd: "HD",
  sd: "SD",
  ld: "LD",
};

export const QUALITY_FULL: Record<string, string> = {
  // douyin 档位
  origin: "原画 OD",
  uhd: "超清 UHD",
  hd: "高清 HD",
  sd: "标清 SD",
  ld: "流畅 LD",
  // bilibili qn(从高到低)
  "10000": "原画",
  "400": "蓝光",
  "250": "超清",
  "150": "高清",
  "80": "流畅",
};

/** 画质 id → 友好标签(未知值原样显示)。 */
export function qualityLabel(q: string): string {
  return QUALITY_FULL[q] ?? q;
}

export const QUALITY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "origin", label: "原画 OD" },
  { value: "uhd", label: "超清 UHD" },
  { value: "hd", label: "高清 HD" },
  { value: "sd", label: "标清 SD" },
  { value: "ld", label: "流畅 LD" },
];

/** Danmu badge classification: 关闭 / 含礼物 / 匿名. */
export type DanmuKind = "off" | "gift" | "anon";
export function danmuKind(t: Pick<Task, "danmu" | "useCookie">): DanmuKind {
  if (!t.danmu) return "off";
  return t.useCookie ? "gift" : "anon";
}

export const DANMU_LABEL: Record<DanmuKind, string> = {
  off: "关闭",
  gift: "含礼物",
  anon: "匿名",
};

export const DANMU_BADGE_CLASS: Record<DanmuKind, string> = {
  off: "badge-muted",
  gift: "badge-violet",
  anon: "badge-emerald",
};

export function scheduleText(t: Pick<Task, "scheduleStart" | "scheduleEnd">): string | null {
  return t.scheduleStart && t.scheduleEnd ? `${t.scheduleStart}–${t.scheduleEnd}` : null;
}

/**
 * 房间号(web_rid):列表紧凑显示用。抖音 URL / 裸房间号 → 纯数字 id;无法识别 → 去 query 后原样。
 * 入库已归一化为 https://live.douyin.com/{id},这里抽回纯号显示。
 */
export function roomId(room: string): string {
  const m = room.match(/live\.douyin\.com\/(\d+)/);
  if (m) return m[1];
  const r = room.trim();
  if (/^\d+$/.test(r)) return r;
  const q = r.indexOf("?");
  return q >= 0 ? r.slice(0, q) : r;
}

/** 房间可点击链接(详情页「打开直播间」用):规范 https URL。 */
export function roomHref(room: string): string {
  if (/^https?:\/\//.test(room)) return room; // 已是 URL(入库已归一化、剥 query)
  const id = roomId(room);
  return /^\d+$/.test(id) ? `https://live.douyin.com/${id}` : room;
}

/** "HH:MM-HH:MM" string for the schedule input from a task. */
export function scheduleInput(t: Pick<Task, "scheduleStart" | "scheduleEnd">): string {
  return t.scheduleStart && t.scheduleEnd ? `${t.scheduleStart}-${t.scheduleEnd}` : "";
}

/** Format an elapsed duration (ms) as HH:MM:SS. */
export function fmtClock(ms: number | null | undefined): string {
  if (ms == null) return "—";
  const total = Math.floor(ms / 1000);
  const h = String(Math.floor(total / 3600)).padStart(2, "0");
  const m = String(Math.floor((total % 3600) / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/**
 * Format an epoch-ms instant as "YYYY-MM-DD HH:MM:SS" in `tz`(后端配置时区,GET /api/timezone 的
 * effective;空串则回落浏览器本地时区,见 lib/tz.ts)。
 */
export function fmtStartedAt(epochMs: number | null | undefined, tz: string): string {
  if (epochMs == null) return "—";
  return fmtDateTimeInTz(new Date(epochMs), tz);
}
