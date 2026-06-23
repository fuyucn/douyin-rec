/**
 * @drec/ffmpeg-recorder-extra — 录制器**附加插件**:流元数据 + 直播设备检测。
 *
 * 与核心录制(record-engine)解耦:核心只管取流/分段;本包提供「这场流是什么」的
 * 附加信息——分辨率/帧率/码率/编码(来自 getStream 的 sdk_params)+ 推流设备/软件
 * (ffprobe FLV 的 onMetaData encoder 标签,biliLive-tools 同款映射)。
 *
 * 用法(录制开始拿到 FLV URL + getStream 返回时):
 *   logStreamMeta(url, streamRes, quality)  // 打印「流信息:」+「直播设备:」(console → manager tail → UI)
 * 或单独取:
 *   await detectDevice(url)        // → "iOS（iPhone/iPad）" | "Android" | "OBS" | …
 *   streamInfoLine(streamRes, q)   // → "1080x1920 | 22fps | 码率 2751k | H264"
 */
import { spawn } from "node:child_process";

// scope = stream_processor。本包是 L0 叶子(与 @drec/core 同层),不能 import core 的 createLogger
// (会触发 layering.test 的同层依赖违规),故内联一个等价的 scoped logger(输出 `[stream_processor] …` 一致)。
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

const log = {
  info: (...a: unknown[]): void => console.log("[stream_processor]", ...a),
};

/** getStream 返回里我们用到的部分(sources[].streamMap[*].main.sdk_params)。 */
export interface StreamMetaSource {
  sources?: Array<{ streamMap?: Record<string, { main?: { sdk_params?: string } }> }>;
}

/** FLV onMetaData 的 encoder 标签 → 推流端(biliLive-tools 同款)。空/未知回落原始首段。 */
export function mapEncoder(raw: string): string | undefined {
  if (!raw) return undefined;
  const e = raw.toLowerCase();
  if (e.includes("bytedmediasdkios")) return "iOS（iPhone/iPad）";
  if (e.includes("bytedmediasdk")) return "Android";
  if (e.includes("obs")) return "OBS";
  if (e.includes("fmle") || e.includes("flash")) return "Flash Media Encoder";
  if (e.includes("xsplit")) return "XSplit";
  return raw.split(":")[0];
}

/** ffprobe FLV 的 format.tags.encoder → 推流设备/软件。HLS/失败/超时 → undefined。 */
export async function detectDevice(url: string): Promise<string | undefined> {
  if (!/^https?:/.test(url)) return undefined;
  return new Promise((res) => {
    const proc = spawn(FFPROBE, [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      "-probesize", "65536",
      "-analyzeduration", "0",
      "-headers", "User-Agent: Mozilla/5.0\r\n",
      url,
    ]);
    let out = "";
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* ignore */ }
      res(undefined);
    }, 15_000);
    proc.stdout?.on("data", (d) => (out += String(d)));
    proc.on("error", () => { clearTimeout(timer); res(undefined); });
    proc.on("close", () => {
      clearTimeout(timer);
      try {
        const tags = (JSON.parse(out)?.format?.tags ?? {}) as Record<string, string>;
        res(mapEncoder(String(tags.encoder ?? tags.Encoder ?? "")));
      } catch {
        res(undefined);
      }
    });
  });
}

/** 从 getStream 返回的 sources[].streamMap 取某档 sdk_params → 「流信息」串。 */
export function streamInfoLine(res: StreamMetaSource, qualityKey: string): string | undefined {
  const sm = res.sources?.[0]?.streamMap ?? {};
  const raw = sm[qualityKey]?.main?.sdk_params ?? sm.origin?.main?.sdk_params;
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Record<string, unknown>;
    const parts: string[] = [];
    if (typeof p.resolution === "string" && p.resolution) parts.push(p.resolution);
    if (p.fps) parts.push(`${Number(p.fps)}fps`);
    if (p.vbitrate) parts.push(`码率 ${Math.round(Number(p.vbitrate) / 1000)}k`);
    if (typeof p.VCodec === "string" && p.VCodec) parts.push(String(p.VCodec).toUpperCase());
    return parts.length ? parts.join(" | ") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 录制开始时调用:打印「流信息」(同步) + 「直播设备」(异步 ffprobe,不阻塞录制)。
 * 走 console.log → 录制子进程 stdout → manager tail → Web/TUI 日志可见。
 */
export function logStreamMeta(url: string, res: StreamMetaSource, quality: string): void {
  const info = streamInfoLine(res, quality);
  if (info) log.info(`流信息: ${info}`);
  void detectDevice(url).then((d) => {
    if (d) log.info(`直播设备: ${d}`);
  });
}
