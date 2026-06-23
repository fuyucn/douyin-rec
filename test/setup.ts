/**
 * vitest 全局 setup — 注册一个**假抖音平台**到 @drec/core 注册表。
 *
 * 生产由 cli/providers-register 注册真 douyinPlatform(它依赖 douyin-live 的 sm-crypto,
 * vitest 无法 import)。测试里 store.addTask / cli-task / anchor 都要 platformForRoom(),
 * 故在此注册一个纯函数假平台(URL/slug/默认与抖音一致;网络方法返 null,测试不需要真请求)。
 */
import { registerPlatform, _resetPlatforms, type Platform, type DanmuSource } from "@drec/core";

/** 极简弹幕源 mock(假平台 connectDanmu 返回它)。start/stop 为 no-op,够 session 测试断言「起没起」。 */
class MockDanmuSource implements DanmuSource {
  readonly name = "mock-danmu";
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

const fakeDouyin: Platform = {
  id: "douyin",
  matchUrl: (url) => /(?:live|v)\.douyin\.com\//.test(url),
  roomToUrl: (room) => (/^https?:\/\//.test(room) ? room : `https://live.douyin.com/${room}`),
  extractRoomSlug: (url) => {
    const m = url.match(/live\.douyin\.com\/(\d+)/);
    return m ? m[1] : url;
  },
  resolveShortUrl: async () => null,
  fetchAnchorName: async () => null,
  getStream: async () => ({ living: false }),
  getLiving: async () => false,
  connectDanmu: () => new MockDanmuSource(), // 抖音有弹幕能力(mock)
  defaultQuality: "origin",
  defaultEngine: "ffmpeg",
  qualities: ["origin", "uhd", "hd", "sd", "ld"],
  engines: ["ffmpeg", "mesio"],
};

// 假 bilibili 平台(镜像真 bilibiliPlatform 的取值)—— 用于跨平台逻辑测试(如 updateTask 改 room 换平台)。
const fakeBilibili: Platform = {
  id: "bilibili",
  matchUrl: (url) => /live\.bilibili\.com\//.test(url),
  roomToUrl: (room) => (/^https?:\/\//.test(room) ? room : `https://live.bilibili.com/${room}`),
  extractRoomSlug: (url) => {
    const m = url.match(/live\.bilibili\.com\/(\d+)/);
    return m ? m[1] : url;
  },
  fetchAnchorName: async () => null,
  getStream: async () => ({ living: false }),
  getLiving: async () => false,
  // bilibili 无弹幕能力(connectDanmu 省略 → 返 null 语义)。
  defaultQuality: "10000",
  defaultEngine: "ffmpeg",
  qualities: ["10000", "400", "250", "150", "80"],
  engines: ["ffmpeg", "mesio"],
};

_resetPlatforms();
registerPlatform(fakeDouyin, { default: true });
registerPlatform(fakeBilibili);
