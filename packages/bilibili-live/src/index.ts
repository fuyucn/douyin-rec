/**
 * @drec/bilibili-live — 哔哩哔哩直播平台核心(@drec/core 的 Platform 实现)。
 *
 * 与 douyin-live 平级,同构内部结构 `src/{stream/, danmaku/, index.ts}`:
 *   - ./stream  取流:URL/房间号互转辅助之外的取流逻辑(get_info / getRoomPlayInfo / Master.info),
 *               导出 getStream/getLiving/getRoomInfo/getUname/BILIBILI_QUALITIES。
 *   - ./danmaku 弹幕:bilibili 独立二进制 WS 协议(与抖音完全不同),BilibiliDanmuSource + ws-codec + wbi。
 *   - ./index   本文件,只做平台装配:URL 辅助(matchUrl/roomToUrl/extractRoomSlug)+ fetchAnchorName +
 *               把 stream/danmaku 拼成 `bilibiliPlatform`。
 *
 * 注册一行(cli/providers-register)即接入,录制/任务/校验代码不动 —— 这正是 Platform 抽象的目的。
 * 仅用 Node 内置(全局 WebSocket / node:zlib / node:crypto / fetch),无新依赖 → 可被 vitest import。
 */
import type { Platform, PlatformStream, DanmuSource } from "@drec/core";
import { BilibiliDanmuSource } from "./danmaku/danmu.js";
import { getStream, getLiving, getRoomInfo, getUname, BILIBILI_QUALITIES } from "./stream/index.js";

export { BILIBILI_QUALITIES } from "./stream/index.js";

/** URL / 房间号 → 房间号(live.bilibili.com/{roomid});已是房间号则原样。 */
export function extractRoomSlug(url: string): string {
  const m = url.match(/live\.bilibili\.com\/(\d+)/);
  return m ? m[1] : url;
}

/** 房间号或 URL → bilibili 规范直播 URL。 */
export function roomToUrl(room: string): string {
  if (/^https?:\/\//.test(room)) return room;
  return `https://live.bilibili.com/${room}`;
}

export const bilibiliPlatform: Platform = {
  id: "bilibili",
  matchUrl: (url) => /live\.bilibili\.com\//.test(url),
  urlPattern: "live\\.bilibili\\.com\\/",
  roomToUrl,
  extractRoomSlug,
  // b23.tv 短链暂不处理(Platform.resolveShortUrl 可选,省略)。
  async fetchAnchorName(room) {
    try {
      const { uid } = await getRoomInfo(extractRoomSlug(room));
      return await getUname(uid);
    } catch {
      return null; // 主播名拿不到不致命 → 回落房间号显示
    }
  },
  // 取流/判活委托 ./stream(平台无关基类经此取流)。cookies 透传:带则登录态取高画质,不带匿名。
  getStream: (channelId, quality, cookies): Promise<PlatformStream> => getStream(channelId, quality, cookies),
  getLiving: (channelId) => getLiving(channelId),
  // 弹幕:返回未 start 的 BilibiliDanmuSource(manager 在 onLive 才 start)。注入 realRoomId 解析,
  // 复用 ./stream 的 getRoomInfo(短号→真实 room_id),避免在弹幕实现里重复 get_info。
  connectDanmu(): DanmuSource | null {
    return new BilibiliDanmuSource(async (channelId) => (await getRoomInfo(channelId)).realRoomId);
  },
  defaultQuality: BILIBILI_QUALITIES[0],
  defaultEngine: "ffmpeg",
  qualities: [...BILIBILI_QUALITIES],
  engines: ["ffmpeg", "mesio"],
};
