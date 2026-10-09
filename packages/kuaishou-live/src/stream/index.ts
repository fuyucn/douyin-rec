/**
 * @drec/kuaishou-live / stream — 快手直播取流(取流 = stream resolution)。
 *
 * 取流路径,**页面优先、API 兜底**(2026-10-08 修正:此前是「API 优先」,方向反了):
 *   1. 直播间页 SSR(主):`fetch /u/{userId}` → 抠 `window.__INITIAL_STATE__`
 *      → `liveroom.playList[0]{ liveStream{playUrls,hlsPlayUrl}, author{name}, isLiving, errorType }`。
 *      与浏览器同源,是唯一能稳定拿到真实流的路径(实测未被限流的出口返回完整 playUrls)。
 *   2. `GET /live_api/liveroom/livedetail?principalId={userId}`(仅兜底):该接口**已被平台下线** ——
 *      2026-10-08 实测对**任意** principalId(真房间号 / 主播 id / 不存在的乱码 / 空)都返回同一份
 *      634 字节桩数据(`result:2` / `author.living:false` / `playUrls:{h264:{},hevc:{}}`),与是否在播
 *      无关。故它**不可作判活/未开播依据**(旧代码正是被它误导:在播也报 living:false 且不回退页面);
 *      只在页面请求**本身失败**时试一次,拿不到可播流就抛错(不静默)。
 *
 * 坑位:
 *   - 两条路径都要先访问首页预热 + 随机 3~4s(同 biliup warmup):真实用户进直播间必然先过首页,
 *     直接请求 /u/{id} 在行为特征上更像爬虫,更容易被风控盯上。
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

/**
 * `/live_api/liveroom/livedetail` 响应(只声明我们用到的字段)。
 *
 * ⚠️ **该接口已于 2026-10-08 实测下线**:对任意 principalId 都返回同一桩数据
 * (`result:2` / `author.living:false` / `playUrls` 全空),与是否在播无关。
 * 因此 `result`/`author.living` **不可作为判活依据**(旧代码正因此全节点漏录);
 * 本类型仅用于「万一接口恢复」时读取可播流,详见 getStreamViaApi 的注释。
 */
interface KsLiveDetail {
  data?: {
    result?: number;
    liveStream?: {
      caption?: string | null;
      coverUrl?: string | null;
      hlsPlayUrl?: string | null;
      playUrls?: Record<string, { adaptationSet?: { representation?: KsRep[] } | undefined } | undefined>;
    } | null;
    author?: { living?: boolean; name?: string } | null;
  };
}

const KS_HOME = "https://live.kuaishou.com";

/**
 * 随机 3~4s:与 biliup warmup 同款,避免固定节奏被识别为爬虫。
 * 测试通过全局 `__KS_WARMUP_DELAY_MS__` 置 0 跳过等待(见 stream/index.test.ts)。
 */
function randomWarmupDelayMs(): number {
  const override = (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__;
  if (typeof override === "number") return override;
  return 3000 + Math.floor(Math.random() * 1000);
}

/**
 * 取流前置「预热」:先访问快手首页再等 3~4s,让请求序列贴近真实用户进直播间。
 * 失败不致命(首页偶尔 4xx/超时不该阻断录制)—— 只影响反爬姿态,不影响功能。
 */
async function warmup(cookies?: string): Promise<void> {
  try {
    const headers: Record<string, string> = { "User-Agent": UA, Referer: `${KS_HOME}/` };
    if (cookies) headers.Cookie = cookies;
    await fetch(`${KS_HOME}/`, { headers, signal: AbortSignal.timeout(10_000) });
  } catch {
    /* 预热失败不阻断取流 */
  }
  await new Promise((r) => setTimeout(r, randomWarmupDelayMs()));
}

/** 拉 livedetail JSON。返回 null = 网络/解析失败(调用方回退页面刮取)。 */
async function fetchLiveDetail(userId: string, cookies?: string): Promise<KsLiveDetail | null> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: `${KS_HOME}/`,
  };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(
    `${KS_HOME}/live_api/liveroom/livedetail?principalId=${encodeURIComponent(userId)}`,
    { headers, signal: AbortSignal.timeout(15_000) },
  );
  if (!res.ok) return null;
  return (await res.json()) as KsLiveDetail;
}

/** fetch 直播间页 HTML。带 UA/语言头;cookies 可选(风控场景可带登录 Cookie)。 */
async function fetchRoomHtml(userId: string, cookies?: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    "Accept-Language": "zh-CN,zh;q=0.9",
    Referer: "https://live.kuaishou.com/",
  };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(`${KS_HOME}/u/${encodeURIComponent(userId)}`, {
    headers,
    signal: AbortSignal.timeout(15_000),
  });
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
  /** 风控/结构性错误(如「请求过快」):此时 living=false 不代表主播真下播,调用方应按「未知」处理。 */
  throttled?: string;
}

/**
 * 页面里出现这些文案 = 被风控(不是「未开播」)。用于 `__INITIAL_STATE__` 解析失败时兜底判定:
 * 强风控会直接返回验证码/提示页,连 `__INITIAL_STATE__` 都没有。
 */
const THROTTLE_MARKERS = ["请求过快", "稍后重试", "操作太快", "访问过于频繁"];

function detectThrottleInHtml(html: string): string | null {
  for (const m of THROTTLE_MARKERS) {
    if (html.includes(m)) return m;
  }
  return null;
}

/** 拉页解析出的房间信息(主播名 + 是否在播);风控时附 throttled 让调用方区分「未开播」与「未知」,fetch 失败抛错。 */
export async function getRoomInfo(userId: string, cookies?: string): Promise<KsRoomInfo> {
  const html = await fetchRoomHtml(userId, cookies);
  let item: KsPlayItem | null;
  try {
    item = findPlayItem(parseInitialState(html));
  } catch (e) {
    // 没有 __INITIAL_STATE__(强风控页/改版):含限流文案 → 报风控;否则原样抛出(未知)。
    const throttle = detectThrottleInHtml(html);
    if (throttle) return { living: false, name: null, throttled: throttle };
    throw e;
  }
  if (!item) return { living: false, name: null };
  const name = item.author?.name?.trim() || null;
  const ls = item.liveStream;
  if (item.errorType) return { living: false, name, throttled: item.errorType.title || item.errorType.content || "未知风控" };
  if (!ls) return { living: false, name }; // 未开播
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
 * 从 livedetail 的 liveStream 里按档位选一条流(与页面版共用 pickRep / h264 优先)。
 * 返回 undefined = 没取到可播流(未开播,或平台没给 representation)。
 */
function pickFromLiveStream(
  ls: NonNullable<KsLiveDetail["data"]>["liveStream"],
  quality: string,
): string | undefined {
  if (!ls) return undefined;
  const playUrls = ls.playUrls ?? {};
  // h264 优先(录制兼容),其次 hevc;与页面版同一套优先级。
  for (const codec of ["h264", "hevc"]) {
    const reps = playUrls[codec]?.adaptationSet?.representation ?? [];
    const rep = pickRep(reps, quality);
    if (rep?.url) return rep.url;
  }
  return ls.hlsPlayUrl || undefined;
}

/**
 * API 兜底路径(`/live_api/liveroom/livedetail`)。**该接口已下线**(见文件头说明):
 * 2026-10-08 实测对任意 principalId 都返回同一桩数据,拿不到 representation。
 *
 * 因此这里**只认「拿到可播流 URL」这一种结果**:
 *   - 有可播 URL → `{ living:true, url }`(接口万一恢复则能派上用场);
 *   - 其余一律 `null`(= 不可用)——**绝不返回 `{living:false}`**,否则「接口下线的桩」会被
 *     误当成「主播未开播」这一权威结论(旧代码正是这么漏录的)。
 */
async function getStreamViaApi(
  userId: string,
  quality: string,
  cookies?: string,
): Promise<PlatformStream | null> {
  let detail: KsLiveDetail | null;
  try {
    detail = await fetchLiveDetail(userId, cookies);
  } catch {
    return null; // 网络异常 → 不可用
  }
  if (!detail?.data) return null;

  const { liveStream: ls, author } = detail.data;
  const owner = author?.name?.trim() || undefined;
  // 标题(caption)带进产物命名,比纯 {name}_{date} 信息量大。
  const title = ls?.caption?.trim() || undefined;
  const url = pickFromLiveStream(ls ?? null, quality);
  // 无 representation(下线的桩:playUrls 全空 + url 是 ".../live/undefined")→ 不可用。
  if (!url) return null;
  return { living: true, url, owner, title, headers: STREAM_HEADERS, raw: detail };
}

/**
 * 页面 SSR 主路径:`fetch /u/{userId}` → 抠 `__INITIAL_STATE__` → 解析 playList[0]。
 *
 * 语义:
 *   - 页面正常解析 → `{living:true,url}` 或 `{living:false}`(权威「未开播」);被限流时带
 *     `throttledReason`(让录制器降频 + 告警,而非伪装成未开播)。
 *   - 页面请求**本身失败**(网络/HTTP/无 `__INITIAL_STATE__`/改版)→ **抛错** = 未知,交给
 *     调用方决定(兜底 API / 告警),绝不静默返回 `living:false`。
 */
async function getStreamViaPage(userId: string, quality: string, cookies?: string): Promise<PlatformStream> {
  const html = await fetchRoomHtml(userId, cookies); // 请求失败 → 抛错(未知)
  let item: KsPlayItem | null;
  try {
    item = findPlayItem(parseInitialState(html));
  } catch (e) {
    // 页面没有 __INITIAL_STATE__(强风控/验证码页/改版):HTML 里若含限流文案 → 当风控上报;
    // 否则原样抛出(未知,交给兜底/告警),不伪装成「未开播」。
    const throttle = detectThrottleInHtml(html);
    if (throttle) return { living: false, raw: null, throttledReason: throttle };
    throw e;
  }
  const raw = item ?? null;
  if (!item) return { living: false, raw };
  const owner = item.author?.name?.trim() || undefined;
  const ls = item.liveStream;
  // 风控(errorType.type=2,如「请求过快」)→ 显式带 throttledReason,录制器降频轮询+告警;封禁等结构性错误同样上报。
  if (item.errorType) return { living: false, owner, raw, throttledReason: item.errorType.title || item.errorType.content };
  if (!ls) return { living: false, owner, raw };

  // FLV 档:h264 优先(录制兼容),其次 hevc;HLS 保底。
  const playUrls = ls.playUrls ?? {};
  let rep: KsRep | undefined;
  for (const codec of ["h264", "hevc"]) {
    const reps = playUrls[codec]?.adaptationSet?.representation ?? [];
    rep = pickRep(reps, quality);
    if (rep) break;
  }
  const url = rep?.url ?? ls.hlsPlayUrl;
  // **以「拿到可播流 URL」为唯一在播依据**(与 biliup / DouyinLiveRecorder 一致,不依赖 isLiving 字段):
  // 有 URL 就能录;离线样本实测 playUrls 全空(自然 url 为空)→ 判未开播,与 isLiving:false 一致。
  if (!url) return { living: false, owner, raw };
  return { living: true, url, owner, headers: STREAM_HEADERS, raw };
}

/**
 * 取流:userId → 可录制流(living/url/owner/headers)。
 *
 * **页面优先、API 兜底**(2026-10-08 修正):页面是唯一能稳定拿到真实流的路径(livedetail 已下线)。
 * 仅当页面请求**本身失败**时才试一次 API(万一接口恢复);两者都拿不到就**抛错**(未知),
 * 由录制器的失败告警路径处理 —— 绝不把「查不到」静默成「未开播」。
 *
 * `cookies` 可选:带上以登录态防风控;不带匿名取(默认)。
 */
export async function getStream(userId: string, quality: string, cookies?: string): Promise<PlatformStream> {
  await warmup(cookies);
  try {
    return await getStreamViaPage(userId, quality, cookies);
  } catch (pageErr) {
    // 页面路径失败(网络/HTTP/改版)→ API 兜底一次;仍拿不到可播流 → 抛原错(未知,不静默)。
    const viaApi = await getStreamViaApi(userId, quality, cookies).catch(() => null);
    if (viaApi) return viaApi;
    throw pageErr;
  }
}

/**
 * 判活:userId → 是否直播中。
 * 风控/接口异常时**抛错**(= 未知),而不是返回 false —— 否则录制器会把「请求过快」误判成
 * 「主播已下播」而提前收尾/漏录(见 docs/kuaishou-rate-limit.md)。
 */
export async function getLiving(userId: string): Promise<boolean> {
  let page: PlatformStream;
  try {
    page = await getStreamViaPage(userId, "OD");
  } catch (pageErr) {
    // 页面失败 → API 兜底(仅信任「拿到可播流」);否则抛原错 = 未知。
    const viaApi = await getStreamViaApi(userId, "OD").catch(() => null);
    if (viaApi) return viaApi.living;
    throw pageErr;
  }
  if (page.throttledReason) throw new Error(`kuaishou 风控/接口异常: ${page.throttledReason}`);
  return page.living;
}
