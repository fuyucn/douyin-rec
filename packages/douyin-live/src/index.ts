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
import { getStream, getInfo, resolveShortURL, resolveWebRid } from "./stream/index.js";
export { getStream, getInfo, resolveShortURL, resolveWebRid } from "./stream/index.js";
export type { GetStreamResult, GetInfoResult, StreamProfile, SourceProfile } from "./stream/index.js";

// API 模式读取已提取到 ./api-mode.js(单一真理源;probe.ts 也用它,避免循环引用)。
import { resolveApiMode } from "./api-mode.js";
export { resolveApiMode } from "./api-mode.js";

/** 抖音画质档(从高到低)。通用层用 string;此处是抖音的具体取值。 */
export const DOUYIN_QUALITIES = ["origin", "uhd", "hd", "sd", "ld"] as const;
export type DouyinQuality = (typeof DOUYIN_QUALITIES)[number];

/** 抖音可用下载引擎(douyinPlatform.engines 的唯一真理源)。 */
export const DOUYIN_ENGINES = ["ffmpeg", "mesio"] as const;
export type DouyinEngine = (typeof DOUYIN_ENGINES)[number];

export { probeStream } from "./probe.js";
export type { StreamProbe, QualityInfo } from "./probe.js";

/** 房间 URL / 用户名 / web_rid → 直播间 slug(短链需先 resolveShortURL)。 */
export function extractRoomSlug(url: string): string {
  const trimmed = url.trim();
  const m = trimmed.match(/^https?:\/\/live\.douyin\.com\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : trimmed;
}

/** 房间号或 URL → 抖音规范直播 URL。 */
export function roomToUrl(room: string): string {
  if (/^https?:\/\//.test(room)) return room;
  return `https://live.douyin.com/${room}`;
}

/**
 * 用户名/短链 → 数字 web_rid。
 *
 * live.douyin.com 页面即使未开播也会保留最后一次 room.id_str 与主播 sec_uid；
 * mobile reflow/info 用这两个值可以反查 owner.web_rid。数字 web_rid 直接返回。
 */
export async function resolveDouyinWebRid(room: string): Promise<string | null> {
  let slug = extractRoomSlug(room);
  if (/^https?:\/\//.test(slug)) {
    if (!/v\.douyin\.com\//.test(room)) return null;
    try {
      slug = String(await resolveShortURL(room));
    } catch (e) {
      log.error(`短链解析失败 (${room}):`, (e as Error)?.message ?? e);
      return null;
    }
  }
  if (/^\d+$/.test(slug)) return slug;

  try {
    // 均衡模式:反查 web_rid 也要能在 webHTML 被拦的出口(VPS)拿到 id_str + sec_uid。
    const info = await getInfo(slug, { api: "balance" });
    const roomId = String(info?.liveId ?? "").trim();
    const secUid = String(info?.uid ?? "").trim();
    if (!roomId || !secUid) return null;
    return await resolveWebRid(roomId, secUid);
  } catch (e) {
    log.error(`解析 web_rid 失败 room=${slug}:`, (e as Error)?.message ?? e);
    return null;
  }
}

/**
 * 各 web_rid 最近一次解析到的 sec_uid。mobile 接口必须带 sec_user_id 才能用,而它自己
 * 不回传 sec_uid —— 只能靠 webHTML/web 顺带拿到的值缓存,供后续 mobile 回落使用。
 */
const secUidCache = new Map<string, string>();

/**
 * 解析「本场直播的 liveId」(抖音弹幕 WS 连接需要的 id,不是房间 web_rid/slug)。失败返 null。
 *
 * **均衡模式**(2026-10-07):走 `api:"balance"` → `APILoadBalancer` 自动挑 api type
 * (按 priority + 加权随机),失败端点自动禁用/自愈。为什么不再手写「webHTML→web→mobile」回落链:
 *   1. **webHTML 抓的是房间 HTML 页**,出口 IP 被 argus 判为机器人时返回「验证码中间页」(6KB,无
 *      render_data)。手写链把它排第一 → **每次都白试一次**,这本身就在给风控喂信号(我们上次被限流的成因)。
 *      均衡器则会在连续失败后**自动禁用它**。
 *   2. **mobile 需要 sec_uid**,手写链依赖「前面接口顺带缓存」,链条一断就跳过;均衡器里 mobile 无 uid
 *      会内部回落 web(`getRoomInfo` 的兼容逻辑),不需要外部喂。
 *
 * 实测(2026-10-07,同房间 `68133201791`):家宽 10/10、VPS1 10/10(自动摘掉被拦的 webHTML → 全程 web)、
 * VPS2 10/10,三者 liveId 一致。均衡模式在三环境都拿到当场 liveId。
 *
 * 仍全程匿名解析(liveId 公开);带会话 cookie 调 enter API 会异地登录踢手机,见
 * docs/douyin-kick-investigation.md。
 *
 * **兜底**:均衡器把端点全禁用(或全失败)时抛错 → 这里再手工试一次 `web`(最稳、不依赖 HTML 页),
 * 仍失败才返 null(上层按「解析失败」告警,不静默)。
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

  // 1) 按配置的 API 模式(默认 balance:自动挑 api type + 失败端点自愈)。带上缓存的 sec_uid(让 mobile 可用)。
  const mode = resolveApiMode();
  const cachedUid = secUidCache.get(slug);
  try {
    const info = await getInfo(slug, { api: mode, ...(cachedUid ? { uid: cachedUid } : {}) });
    const liveId = String(info?.liveId ?? "").trim();
    const uid = String(info?.uid ?? "").trim();
    if (uid) secUidCache.set(slug, uid);
    if (liveId) return liveId;
    log.warn(`api=${mode} 未解析到 liveId room=${slug},兜底试 web`);
  } catch (e) {
    log.warn(`api=${mode} 解析失败 room=${slug}: ${(e as Error)?.message ?? e},兜底试 web`);
  }

  // 2) 兜底:直接试 web(最稳,不依赖房间 HTML 页;也不经均衡器,避免「端点全被禁用」时无路可走)。
  try {
    const info = await getInfo(slug, { api: "web" });
    const liveId = String(info?.liveId ?? "").trim();
    const uid = String(info?.uid ?? "").trim();
    if (uid) secUidCache.set(slug, uid);
    if (liveId) {
      log.info(`liveId 经 web 兜底解析 room=${slug}`);
      return liveId;
    }
    log.warn(`web 兜底未解析到 liveId room=${slug}`);
  } catch (e) {
    log.error(`web 兜底解析失败 room=${slug}:`, (e as Error)?.message ?? e);
  }

  log.error(`解析 liveId 失败(balance + web 均未成功)room=${slug}`);
  return null;
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
    const id = await resolveDouyinWebRid(url);
    return id ? String(id) : null;
  },
  async fetchAnchorName(room) {
    // 用同一 API 模式:默认 balance 保证在 webHTML 被拦的出口(VPS)也能解析主播名。
    const owner = String((await getInfo(extractRoomSlug(room), { api: resolveApiMode() })).owner ?? "").trim();
    return owner || null;
  },
  async getStream(channelId, quality, _cookies): Promise<PlatformStream> {
    // 抖音**故意忽略** cookie 参数 → 始终匿名取流:其内部 webcast/room/web/enter 鉴权传会话 cookie
    // 会异地登录踢手机主号(见 docs/douyin-kick-investigation.md)。cookie 只用于弹幕(connectDanmu)。
    void _cookies;
    // ⚠️ 不要硬编码 api —— 必须走 `resolveApiMode()`(全局设置,UI 可选;默认 balance)。
    // 硬编码会无视用户在设置里的选择,且失去 balance 的失败自愈(见 resolveApiMode 注释)。
    // 取流路径在 stream.js 内对 balance 额外排除 webHTML/userHTML(它们恒 streams=0)。
    const res = await getStream({ channelId, quality, api: resolveApiMode(), formatPriorities: ["flv", "hls"] } as Parameters<typeof getStream>[0]);
    return {
      living: !!res?.living,
      url: res?.currentStream?.url,
      owner: res?.owner != null ? String(res.owner) : undefined,
      title: res?.title != null ? String(res.title) : undefined,
      ...(res?.liveId ? { liveSessionId: String(res.liveId) } : {}),
      raw: res, // 完整结果留给录制器子类(logStreamMeta 等)
    };
  },
  async getLiving(channelId) {
    // 判活同用该模式(别硬编码):默认 balance 可避免单点(如 webHTML 被拦)把「在播」误判成「未开播」。
    return !!(await getInfo(channelId, { api: resolveApiMode() })).living;
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
