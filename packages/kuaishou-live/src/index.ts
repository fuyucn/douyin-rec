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

/**
 * URL / 用户 id → 用户 id;已是 id 则原样。
 * 覆盖快手三种直播页路径(同 biliup):
 *   - `live.kuaishou.com/u/{id}`(标准)
 *   - `live.kuaishou.com/profile/{id}`(旧版个人主页路径)
 *   - `live.kuaishou.com/fw/live/{id}`(短链跳转后的落地路径)
 * 以及企业号域名 `*.m.chenzhongtech.com`。
 */
export function extractRoomSlug(url: string): string {
  const m =
    url.match(/(?:live|www|v)\.kuaishou\.com\/(?:u|profile|fw\/live)\/([\w-]+)/) ??
    url.match(/livev\.m\.chenzhongtech\.com\/(?:u|profile|fw\/live)\/([\w-]+)/);
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
  matchUrl: (url) =>
    /(?:live|www|v)\.kuaishou\.com\//.test(url) || /livev\.m\.chenzhongtech\.com\//.test(url),
  // 前端用它 new RegExp 判平台,必须与 matchUrl 同口径(否则快手任务落不到正确表单)。
  urlPattern: "(?:live|www|v)\\.kuaishou\\.com/|livev\\.m\\.chenzhongtech\\.com/",
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
  // 页面接口限流紧:30s 轮询约 40 次即「请求过快」。5 分钟一探,宁可晚发现开播也不被持续封。
  pollIntervalMs: 5 * 60_000,
};
