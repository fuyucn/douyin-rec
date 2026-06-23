/**
 * @drec/douyin-live — 抖音平台核心(与通用 @drec/core 分开)。
 *
 * 这里放**抖音专属**的东西:取流提取(a_bogus 签名 + getStream/getInfo/resolveShortURL,
 * vendored 自有副本,见 ./stream)+ 抖音画质档常量。未来 huya/douyu/bilibili 各有自己的
 * `@drec/<平台>-core`,通用契约仍在 @drec/core。
 *
 * 录制(通用 @drec/record-engine + ffmpeg/mesio 引擎,经 douyinPlatform.getStream 取流)、弹幕
 * (connectDanmu)、主播名解析(app/anchor)统一从这里取抖音提取能力 → 不依赖任何外部项目。
 */
import { createLogger, type Platform, type PlatformStream } from "@drec/core";
import { ListenerDanmuSource, type DanmaClientCtor } from "./danmaku/listener-base.js";

const log = createLogger("stream_processor");
import { getStream, getInfo, resolveShortURL } from "./stream/index.js";
export { getStream, getInfo, resolveShortURL } from "./stream/index.js";
export type { GetStreamResult, GetInfoResult, StreamProfile, SourceProfile } from "./stream/index.js";

/** 抖音画质档(从高到低)。通用层用 string;此处是抖音的具体取值。 */
export const DOUYIN_QUALITIES = ["origin", "uhd", "hd", "sd", "ld"] as const;
export type DouyinQuality = (typeof DOUYIN_QUALITIES)[number];

/** 抖音可用下载引擎(douyinPlatform.engines 的唯一真理源)。 */
export const DOUYIN_ENGINES = ["ffmpeg", "mesio"] as const;
export type DouyinEngine = (typeof DOUYIN_ENGINES)[number];

export { probeStream } from "./probe.js";
export type { StreamProbe, QualityInfo } from "./probe.js";

/** 房间 URL / 房间号 → web_rid(短链需先 resolveShortURL)。 */
export function extractRoomSlug(url: string): string {
  const m = url.match(/live\.douyin\.com\/(\d+)/);
  return m ? m[1] : url;
}

/** 房间号或 URL → 抖音规范直播 URL。 */
export function roomToUrl(room: string): string {
  if (/^https?:\/\//.test(room)) return room;
  return `https://live.douyin.com/${room}`;
}

/**
 * 解析「本场直播的 liveId」(抖音弹幕 WS 连接需要的 id,不是房间 web_rid/slug)。失败返 null。
 *
 * ⚠️ 用 api:"webHTML"(解析 live.douyin.com/{web_rid} 页 render_data 的 room.id_str)——默认
 * api:"web" 走 webcast/room/web/enter,会在开播切换瞬间返回**陈旧 liveId**(连上 WS 却整场 0 弹幕),
 * 且 enter API 地域受限 + 带 cookie 踢手机。HTML 页 id_str 始终是当前这场。仍匿名解析(liveId 公开)。
 *
 * 抖音弹幕专属;两个抖音弹幕 provider(vendored / npm)共用 → 调本函数。
 */
export async function resolveDouyinLiveId(roomUrl: string): Promise<string | null> {
  let slug = extractRoomSlug(roomUrl);
  if (/v\.douyin\.com\//.test(roomUrl)) {
    try {
      slug = String(await resolveShortURL(roomUrl));
    } catch (e) {
      log.error(`短链解析失败 (${roomUrl}):`, (e as Error)?.message ?? e);
    }
  }
  try {
    const info = await getInfo(slug, { api: "webHTML" });
    return String(info?.liveId ?? "") || null;
  } catch (e) {
    log.error(`解析 liveId 失败 room=${slug}:`, (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * DouyinDanmuSource — 抖音弹幕源(原 @drec/douyin-danmaku-recorder 的 DouyinDanmakuRecorder,
 * 已并入 douyin-live)。用我们自己的 `./danmaku/client.ts`(DouYinDanmaClient,参考
 * douyin-danma-listener 重写;签名 webmssdk.js + schema proto.js 仍 vendored,已打 uid 稳定化补丁)。
 * 抓取/归一化 + cookie 白名单过滤等逻辑在同目录 ./danmaku/listener-base 的 ListenerDanmuSource 基类;
 * 本类只指定 name + 加载 client 构造器 + 抖音 liveId 解析。抓弹幕+礼物+入场,带 cookie 也不踢
 * (见 docs/douyin-kick-investigation.md)。
 */
export class DouyinDanmuSource extends ListenerDanmuSource {
  readonly name = "douyin-danmaku";

  protected async loadClientCtor(): Promise<DanmaClientCtor> {
    const { default: Ctor } = await import("./danmaku/client.js");
    return Ctor as unknown as DanmaClientCtor;
  }

  /** 抖音 liveId 解析(平台专属 → 在此调本地 resolveDouyinLiveId)。 */
  protected async resolveLiveId(roomUrl: string): Promise<string | null> {
    return resolveDouyinLiveId(roomUrl);
  }
}

/**
 * 抖音平台实现(@drec/core 的 Platform 契约)。把抖音专属的 URL/身份/默认 provider 收于一处;
 * 注册在 CLI 入口(providers-register)。主播名解析必须【匿名】(不传 cookie),否则异地登录踢手机
 * 主号(见 docs/douyin-kick-investigation.md)。
 */
export const douyinPlatform: Platform = {
  id: "douyin",
  matchUrl: (url) => /(?:live|v)\.douyin\.com\//.test(url),
  urlPattern: "(?:live|v)\\.douyin\\.com\\/",
  roomToUrl,
  extractRoomSlug,
  async resolveShortUrl(url) {
    const id = await resolveShortURL(url);
    return id ? String(id) : null;
  },
  async fetchAnchorName(room) {
    const owner = String((await getInfo(extractRoomSlug(room), {})).owner ?? "").trim();
    return owner || null;
  },
  async getStream(channelId, quality, _cookies): Promise<PlatformStream> {
    // 抖音**故意忽略** cookie 参数 → 始终匿名取流:其内部 webcast/room/web/enter 鉴权传会话 cookie
    // 会异地登录踢手机主号(见 docs/douyin-kick-investigation.md)。cookie 只用于弹幕(connectDanmu)。
    void _cookies;
    const res = await getStream({ channelId, quality, formatPriorities: ["flv", "hls"] } as Parameters<typeof getStream>[0]);
    return {
      living: !!res?.living,
      url: res?.currentStream?.url,
      owner: res?.owner != null ? String(res.owner) : undefined,
      title: res?.title != null ? String(res.title) : undefined,
      raw: res, // 完整结果留给录制器子类(logStreamMeta 等)
    };
  },
  async getLiving(channelId) {
    return !!(await getInfo(channelId, {})).living;
  },
  // 弹幕收进平台:返回未 start 的 DouyinDanmuSource(manager 在 onLive 才 start)。
  connectDanmu: () => new DouyinDanmuSource(),
  // 录制前流探测(CLI probe 命令经 Platform.probe 接口走,不再硬编码抖音)。
  async probe(channelId) {
    const { probeStream } = await import("./probe.js");
    return probeStream(roomToUrl(channelId));
  },
  defaultQuality: DOUYIN_QUALITIES[0],
  defaultEngine: DOUYIN_ENGINES[0],
  qualities: [...DOUYIN_QUALITIES],
  engines: [...DOUYIN_ENGINES],
};
