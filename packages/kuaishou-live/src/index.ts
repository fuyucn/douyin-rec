/**
 * @drec/kuaishou-live — 快手直播平台核心(@drec/core 的 Platform 实现)。
 *
 * 结构与 @drec/bilibili-live 平级,但更薄:
 *   - ./stream 取流 = 拉直播间页抠 __INITIAL_STATE__(快手没有公开 JSON 直播 API)。
 *   - 弹幕:暂无 connectDanmu(Playwright/登录态链路不稳定,保持纯录制)。
 *     前端按 hasDanmu=false 隐藏弹幕开关。
 *
 * 注册一行(cli/providers-register)即接入,通用层不动。
 */
import type { Platform, PlatformStream } from "@drec/core";
import { getStream, getLiving, getRoomInfo, KUAISHOU_QUALITIES } from "./stream/index.js";

export { KUAISHOU_QUALITIES, STREAM_HEADERS } from "./stream/index.js";

/** URL / 用户 id → 用户 id(live.kuaishou.com/u/{userId});已是 id 则原样。 */
export function extractRoomSlug(url: string): string {
  const m = url.match(/live\.kuaishou\.com\/u\/([\w-]+)/);
  if (m) return m[1];
  const plain = url.trim().replace(/[?#].*$/, "");
  return /^[\w-]+$/.test(plain) ? plain : url;
}

/** 用户 id 或 URL → 规范直播 URL。 */
export function roomToUrl(room: string): string {
  if (/^https?:\/\//.test(room)) return room;
  return `https://live.kuaishou.com/u/${room}`;
}

export const kuaishouPlatform: Platform = {
  id: "kuaishou",
  matchUrl: (url) => /live\.kuaishou\.com\//.test(url),
  urlPattern: "live\\.kuaishou\\.com\\/",
  roomToUrl,
  extractRoomSlug,
  async fetchAnchorName(room) {
    try {
      return (await getRoomInfo(extractRoomSlug(room))).name;
    } catch {
      return null; // 主播名拿不到不致命 → 回落房间号显示
    }
  },
  getStream: (channelId, quality, cookies): Promise<PlatformStream> =>
    getStream(channelId, quality, cookies),
  getLiving: (channelId) => getLiving(channelId),
  // connectDanmu 省略:快手弹幕需 Playwright 抓 WS + 登录态,当前匿名场景不稳定;保持纯录制。
  defaultQuality: "OD",
  defaultEngine: "ffmpeg",
  qualities: [...KUAISHOU_QUALITIES],
  engines: ["ffmpeg", "mesio"],
};
