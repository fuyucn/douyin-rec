/**
 * douyin-live/probe.ts — 抖音**录制前**流探测(原 @drec/douyin-live-recorder 的 probeStream,
 * 随 4 个录制器包合并为通用录制器 + 引擎策略后移入 douyin-live)。
 *
 * 匿名(不踢手机)拿开播状态 + 各档画质的分辨率/码率/编码/帧率 + 横竖屏 + 推流设备。
 * 经 `douyinPlatform.probe()` 暴露,CLI `probe` 命令走 `Platform.probe?()` 接口(不再硬编码抖音)。
 */
import { createLogger } from "@drec/core";
import { detectDevice } from "@drec/ffmpeg-recorder-extra";
import { getStream, extractRoomSlug, resolveShortURL } from "./index.js";

const log = createLogger("stream_processor");

/** 某档画质的信息(录制前探测用)。 */
export interface QualityInfo {
  /** 档位描述:原画 / 蓝光 / 超清 / 高清 …(抖音返回的中文 desc)。 */
  desc: string;
  /** 内部 key(origin/uhd/hd…)。 */
  key: string;
  /** 码率(抖音给的数值,通常 kbps)。 */
  bitRate: number;
  /** 分辨率 "宽x高"(从 sdk_params 解析);竖屏时宽<高。 */
  resolution?: string;
  /** 视频编码:h264 / bytevc1(=H.265)。 */
  vcodec?: string;
  /** 帧率。 */
  fps?: number;
}

/** 录制前的流探测结果。 */
export interface StreamProbe {
  living: boolean;
  owner: string;
  title: string;
  /** 横竖屏(由 origin 分辨率宽高判定);未知为 undefined。 */
  orientation?: "横屏" | "竖屏";
  /** 推流端/设备(ffprobe FLV encoder 标签 → iOS/Android/OBS…);拿不到 undefined。 */
  device?: string;
  /** 各可选画质(含分辨率/码率/编码/帧率)。 */
  qualities: QualityInfo[];
}

/**
 * **录制前**探测房间的流信息(匿名,不踢手机):开播状态 + 各档画质的分辨率/码率/编码/帧率。
 * 复用录制同款 getStream;解析每档的 sdk_params 取分辨率等。未开播时 living=false、qualities 空。
 */
export async function probeStream(roomUrl: string): Promise<StreamProbe> {
  let slug = extractRoomSlug(roomUrl);
  if (/v\.douyin\.com\//.test(roomUrl)) {
    // 短链解析失败不抛(与 start() 一致):回退用 slug,getStream 再判 living。
    try { slug = String(await resolveShortURL(roomUrl)); }
    catch (e) { log.error(`短链解析失败 (${roomUrl}):`, (e as Error)?.message ?? e); }
  }
  let res: Awaited<ReturnType<typeof getStream>>;
  try {
    res = await getStream({
      channelId: slug,
      quality: "origin",
      formatPriorities: ["flv", "hls"],
    } as Parameters<typeof getStream>[0]);
  } catch {
    return { living: false, owner: "", title: "", qualities: [] };
  }

  // 直接遍历 streamMap:每档的 sdk_params 必有 resolution/VCodec/fps/vbitrate(streams[].key 与
  // streamMap key 体系不一致,逐 key 映射会丢档,故以 streamMap 为准)。
  const streamMap = (res.sources?.[0]?.streamMap ?? {}) as Record<
    string,
    { main?: { sdk_params?: string } }
  >;
  // streamMap key → 中文档位(尽力;未知回落 key)。
  const KEY_LABEL: Record<string, string> = {
    origin: "原画", uhd: "蓝光", hd: "超清", sd: "高清", ld: "标清", md: "中清", ao: "音频",
  };
  const px = (r?: string): number => {
    if (!r) return 0;
    const [w, h] = r.split("x").map((n) => Number(n));
    return (w || 0) * (h || 0);
  };

  const qualities: QualityInfo[] = Object.entries(streamMap)
    .map(([key, v]) => {
      let p: Record<string, unknown> = {};
      try {
        p = v?.main?.sdk_params ? (JSON.parse(v.main.sdk_params) as Record<string, unknown>) : {};
      } catch {
        /* sdk_params 解析失败 → 空 */
      }
      const fps = p.fps != null ? Number(p.fps) : undefined;
      const br = p.vbitrate != null ? Number(p.vbitrate) : 0;
      return {
        desc: KEY_LABEL[key] ?? key,
        key,
        bitRate: Number.isFinite(br) ? br : 0,
        resolution: typeof p.resolution === "string" ? p.resolution : undefined,
        vcodec: typeof p.VCodec === "string" ? p.VCodec : undefined,
        fps: Number.isFinite(fps) ? fps : undefined,
      };
    })
    .filter((q) => q.resolution) // 去掉纯音频(ao)等无分辨率的档
    .sort((a, b) => px(b.resolution) - px(a.resolution)); // 像素数降序(最高档在前)

  // 横竖屏:用最高档分辨率判定。
  let orientation: StreamProbe["orientation"];
  const top = qualities[0]?.resolution;
  if (top) {
    const [w, h] = top.split("x").map((n) => Number(n));
    if (w && h) orientation = w >= h ? "横屏" : "竖屏";
  }

  // 推流设备:ffprobe 当前(FLV)流的 encoder 标签(附加插件)。
  const device = res.currentStream?.url ? await detectDevice(res.currentStream.url) : undefined;

  return { living: res.living, owner: res.owner, title: res.title, orientation, device, qualities };
}
