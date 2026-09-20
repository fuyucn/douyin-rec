/**
 * @drec/kuaishou-live / stream — 快手直播取流(取流 = stream resolution)。
 *
 * 快手没有公开 JSON 直播 API,取流走直播间页 SSR 状态:
 *   fetch https://live.kuaishou.com/u/{userId} → 抠 <script>window.__INITIAL_STATE__=...</script>
 *   → liveroom.playList[0]{ liveStream{playUrls,hlsPlayUrl}, author{ name }, isLiving, errorType }。
 *   (参考 ihmily/DouyinLiveRecorder src/spider.py get_kuaishou_stream_data,一致方案。)
 *
 * 坑位:
 *   - __INITIAL_STATE__ 是 JS 对象字面量(可能含裸 `undefined`),不能直接 JSON.parse;
 *     先字符串配对的括号扫描抠出整块,再把 `undefined` 替换成 null 后解析。
 *   - 页面对匿名 IP 有风控:playList 可能为空数组 / liveStream 为 null(此时按未开播处理,不重试风暴)。
 *   - 画质档按 bitrate 阈值映射(参考实现同款):OD=最高 / BD≤4000 / UHD≤2000 / HD≤1000 / SD≤800 / LD≤600。
 *   - h264(codec 兼容)优先于 hevc;FLV 优先于 HLS playUrl。
 */
import type { PlatformStream } from "@drec/core";

/** 快手画质档(从高到低,映射 bitrate 阈值见 QUALITY_MAX_BITRATE)。 */
export const KUAISHOU_QUALITIES = ["OD", "BD", "UHD", "HD", "SD", "LD"] as const;

/** 档位 → 允许的最大码率(kbps);同档位内仍取码率最高的一条。 */
const QUALITY_MAX_BITRATE: Record<string, number> = {
  OD: Number.POSITIVE_INFINITY,
  BD: 4000,
  UHD: 2000,
  HD: 1000,
  SD: 800,
  LD: 600,
};

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** 录制拉流要带的头(yximgs CDN 宽松,带上 UA/Referer 更稳)。 */
export const STREAM_HEADERS: Record<string, string> = {
  Referer: "https://live.kuaishou.com/",
  "User-Agent": UA,
};

interface KsRep {
  bitrate?: number;
  qualityType?: string;
  level?: number;
  hidden?: boolean;
  url?: string;
}
interface KsPlayItem {
  isLiving?: boolean;
  errorType?: { title?: string; content?: string };
  author?: { id?: string; name?: string };
  liveStream?: {
    hlsPlayUrl?: string;
    playUrls?: Record<string, { adaptationSet?: { representation?: KsRep[] } } | undefined>;
  } | null;
  [k: string]: unknown;
}

/** fetch 直播间页 HTML。带 UA/语言头;cookies 可选(风控场景可带登录 Cookie)。 */
async function fetchRoomHtml(userId: string, cookies?: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: "https://live.kuaishou.com/",
  };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(`https://live.kuaishou.com/u/${encodeURIComponent(userId)}`, { headers });
  if (!res.ok) throw new Error(`kuaishou 页面 HTTP ${res.status}: ${userId}`);
  return res.text();
}

/**
 * 抠出并解析 window.__INITIAL_STATE__。
 * 状态是 JS 对象字面量:字符串内可能含括号(需字符串感知的括号扫描),值里可能有裸 undefined(替换为 null)。
 */
export function parseInitialState(html: string): Record<string, unknown> {
  const i = html.indexOf("__INITIAL_STATE__=");
  if (i < 0) throw new Error("kuaishou 页面无 __INITIAL_STATE__(可能风控/改版)");
  const start = html.indexOf("{", i);
  if (start < 0) throw new Error("kuaishou __INITIAL_STATE__ 起点缺失");
  let depth = 0;
  let j = start;
  let inStr = false;
  let quote = "";
  for (; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === quote && html[j - 1] !== "\\") inStr = false;
      continue;
    }
    if (c === "'" || c === '"') {
      inStr = true;
      quote = c;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        j++;
        break;
      }
    }
  }
  if (depth !== 0) throw new Error("kuaishou __INITIAL_STATE__ 括号不成对");
  const json = html.slice(start, j).replace(/(?<=[:\[,])undefined(?=[,}\]])/g, "null");
  return JSON.parse(json) as Record<string, unknown>;
}

/** 从初始状态找出本场直播信息:liveroom.playList[0](账号封禁/风控时可能是 null / errorType)。 */
export function findPlayItem(state: Record<string, unknown>): KsPlayItem | null {
  const liveroom = state.liveroom as { playList?: unknown } | undefined;
  const list = liveroom?.playList;
  if (!Array.isArray(list)) return null;
  const first = list[0];
  return first && typeof first === "object" ? (first as KsPlayItem) : null;
}

export interface KsRoomInfo {
  living: boolean;
  name: string | null;
}

/** 拉页解析出的房间信息(主播名 + 是否在播);页面拿不到/风控 → 安好的 null/未开播,fetch 失败抛错。 */
export async function getRoomInfo(userId: string, cookies?: string): Promise<KsRoomInfo> {
  const html = await fetchRoomHtml(userId, cookies);
  const item = findPlayItem(parseInitialState(html));
  if (!item) return { living: false, name: null };
  const name = item.author?.name?.trim() || null;
  const ls = item.liveStream;
  if (item.errorType || !ls) return { living: false, name }; // 封禁/风控/未开播
  const hasFlv = Object.values(ls.playUrls ?? {}).some(
    (c) => (c?.adaptationSet?.representation ?? []).some((r) => r.url),
  );
  const living = Boolean(item.isLiving) && (hasFlv || Boolean(ls.hlsPlayUrl));
  return { living, name };
}

/** 按档位从 representation 里挑一条流:码率降序,取第一条 bitrate ≤ 档位阈值;都没有取最低。 */
export function pickRep(reps: KsRep[], quality: string): KsRep | undefined {
  const usable = reps.filter((r) => r.url && !r.hidden).sort((a, b) => (b.bitrate ?? 0) - (a.bitrate ?? 0));
  if (usable.length === 0) return undefined;
  const max = QUALITY_MAX_BITRATE[quality.toUpperCase()] ?? Number.POSITIVE_INFINITY;
  return usable.find((r) => (r.bitrate ?? 0) <= max) ?? usable[usable.length - 1];
}

/**
 * 取流:userId → 可录制流(living/url/owner/headers)。未开播/风控 payload 缺失 → {living:false}。
 * `cookies` 可选:带上以登录态防风控;不带匿名取(默认)。
 */
export async function getStream(userId: string, quality: string, cookies?: string): Promise<PlatformStream> {
  const html = await fetchRoomHtml(userId, cookies);
  const item = findPlayItem(parseInitialState(html));
  const raw = item ?? null;
  if (!item) return { living: false, raw };
  const owner = item.author?.name?.trim() || undefined;
  const ls = item.liveStream;
  if (item.errorType || !ls) return { living: false, owner, raw };

  // FLV 档:h264 优先(录制兼容),其次 hevc;HLS 保底。
  const playUrls = ls.playUrls ?? {};
  let rep: KsRep | undefined;
  for (const codec of ["h264", "hevc"]) {
    const reps = playUrls[codec]?.adaptationSet?.representation ?? [];
    rep = pickRep(reps, quality);
    if (rep) break;
  }
  const url = rep?.url ?? ls.hlsPlayUrl;
  if (!url || !item.isLiving) return { living: false, owner, raw };
  return { living: true, url, owner, headers: STREAM_HEADERS, raw };
}

/** 判活:userId → 是否直播中;页面可达性失败抛错。 */
export async function getLiving(userId: string): Promise<boolean> {
  return (await getRoomInfo(userId)).living;
}
