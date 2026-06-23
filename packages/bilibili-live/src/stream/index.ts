/**
 * @drec/bilibili-live / stream — 哔哩哔哩取流(取流 = stream resolution)。
 *
 * 取流走 bilibili 公开 API(匿名可取基础画质,无需 a_bogus 之类签名,比抖音简单):
 *   - get_info:`api.live.bilibili.com/room/v1/Room/get_info?room_id=` → live_status / 真实 room_id / uid / title。
 *               live_status:0=未开播 1=直播中 2=轮播(非真直播,按未开播处理)。
 *   - getRoomPlayInfo:`xlive/web-room/v2/index/getRoomPlayInfo` → playurl_info 取 FLV(优先)/HLS URL。
 *   - Master/info:`live_user/v1/Master/info?uid=` → uname(主播名)。
 *
 * 平台层(../index.ts)的 Platform 方法只委托到这里导出的 getStream/getLiving/getRoomInfo/getUname。
 */
import type { PlatformStream } from "@drec/core";

/** bilibili 画质 qn(从高到低):10000 原画 / 400 蓝光 / 250 超清 / 150 高清 / 80 流畅。 */
export const BILIBILI_QUALITIES = ["10000", "400", "250", "150", "80"] as const;

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * GET bilibili API(带浏览器 UA + Referer,JSON 解析 + code 校验)。失败抛错(交基类判 API 可达性)。
 * `cookies` 可选:带上则以登录态请求(取大会员/高画质流);不带则匿名(基础画质)。
 */
export async function biliGet(url: string, cookies?: string): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    "User-Agent": UA,
    Referer: "https://live.bilibili.com/",
    Accept: "application/json",
  };
  if (cookies) headers.Cookie = cookies;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`bilibili API HTTP ${res.status}: ${url}`);
  const json = (await res.json()) as { code?: number; message?: string; data?: unknown };
  if (json.code !== 0) throw new Error(`bilibili API code=${json.code} (${json.message ?? ""}): ${url}`);
  return (json.data ?? {}) as Record<string, unknown>;
}

export interface RoomInfo {
  realRoomId: string;
  living: boolean; // live_status === 1(2=轮播按未开播)
  uid: string;
  title: string;
}

/** Room/get_info:解析短号→真实 room_id、开播状态、uid、标题。 */
export async function getRoomInfo(channelId: string): Promise<RoomInfo> {
  const d = await biliGet(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${encodeURIComponent(channelId)}`);
  return {
    realRoomId: String(d.room_id ?? channelId),
    living: Number(d.live_status) === 1,
    uid: String(d.uid ?? ""),
    title: String(d.title ?? ""),
  };
}

/** uid → 主播名(Master/info.info.uname)。 */
export async function getUname(uid: string): Promise<string | null> {
  if (!uid) return null;
  const d = await biliGet(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${encodeURIComponent(uid)}`);
  const info = d.info as { uname?: string } | undefined;
  return info?.uname ?? null;
}

// getRoomPlayInfo 响应的最小形状(只取拼 URL 需要的字段)。
interface UrlInfo { host?: string; extra?: string }
interface Codec { codec_name?: string; base_url?: string; url_info?: UrlInfo[]; current_qn?: number }
interface Format { format_name?: string; codec?: Codec[] }
interface StreamProto { protocol_name?: string; format?: Format[] }

/**
 * 从 playurl_info 选一条可用流 URL:优先 http_stream(FLV)+ flv 格式 + avc 编码,
 * 取不到再回落 http_hls / 任意格式。URL = url_info.host + codec.base_url + url_info.extra。
 */
export function pickStreamUrl(playInfo: Record<string, unknown>): string | undefined {
  const playurl = (playInfo.playurl as { stream?: StreamProto[] } | undefined)?.stream;
  if (!Array.isArray(playurl)) return undefined;

  type Cand = { url: string; protoFlv: boolean; fmtFlv: boolean; avc: boolean };
  const cands: Cand[] = [];
  for (const s of playurl) {
    const protoFlv = s.protocol_name === "http_stream";
    for (const f of s.format ?? []) {
      const fmtFlv = f.format_name === "flv";
      for (const c of f.codec ?? []) {
        const ui = c.url_info?.[0];
        if (!ui?.host || !c.base_url) continue;
        cands.push({
          url: `${ui.host}${c.base_url}${ui.extra ?? ""}`,
          protoFlv,
          fmtFlv,
          avc: c.codec_name === "avc",
        });
      }
    }
  }
  if (!cands.length) return undefined;
  // 评分:FLV 协议 > FLV 格式 > avc 编码。取最高。
  cands.sort(
    (a, b) =>
      Number(b.protoFlv) - Number(a.protoFlv) ||
      Number(b.fmtFlv) - Number(a.fmtFlv) ||
      Number(b.avc) - Number(a.avc),
  );
  return cands[0].url;
}

/**
 * 取流:房间号 → 可录制流(living/url/owner/title/headers/raw)。未开播/无流 → {living:false}。
 * `cookies` 可选(登录态):带上可取大会员/高画质流;不带则匿名取基础画质(当前默认)。
 */
export async function getStream(channelId: string, quality: string, cookies?: string): Promise<PlatformStream> {
  const info = await getRoomInfo(channelId);
  if (!info.living) return { living: false };
  const qn = /^\d+$/.test(quality) ? quality : BILIBILI_QUALITIES[0];
  const play = await biliGet(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${info.realRoomId}` +
      `&protocol=0,1&format=0,1,2&codec=0,1&qn=${qn}&platform=web&ptype=8&dolby=5&panorama=1`,
    cookies,
  );
  // 二次确认(getRoomPlayInfo 也带 live_status,避免 get_info 与取流之间下播的竞态)。
  if (Number(play.live_status) !== 1) return { living: false };
  const url = pickStreamUrl((play.playurl_info as Record<string, unknown>) ?? {});
  if (!url) return { living: false }; // 无可用流(可能刚下播/风控)→ 当未开播,基类继续轮询
  const owner = (await getUname(info.uid)) ?? "";
  // bilibili CDN(bilivideo.com)校验来路 → 录制器(ffmpeg/mesio)拉流必须带这些头,否则 403。
  const headers = { Referer: "https://live.bilibili.com/", "User-Agent": UA };
  return { living: true, url, owner, title: info.title, headers, raw: play };
}

/** 判活:房间号 → 是否直播中(权威 live_status)。 */
export async function getLiving(channelId: string): Promise<boolean> {
  return (await getRoomInfo(channelId)).living;
}
