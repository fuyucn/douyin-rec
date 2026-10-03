// 分段(不合并)后处理:录制分段 .ts/.flv 各自 remux 成独立 mp4,以及把一份会话级 xml
// 按该段在整场时间轴上的窗口切出该段的弹幕 → 该段 ASS。供 hub「分段上传」模式逐段产出。
import { resolve } from "node:path";
import { runFfmpeg } from "./ffmpeg.js";
import { extractItems, itemsToLivechatAss, itemsToRollingAss, type RenderOpts } from "./ass/render.js";

/**
 * 单段 remux 参数(纯函数):`-c copy` 无损换容器(ts/flv → mp4),不做任何拼接。
 * `-map 0:v:0 -map 0:a:0?` 与 mergeSession 的归一化口径一致(抖音 .ts 可能含双 program/多路流);
 * `?` = 该段无音频时跳过而非报错。
 */
export function buildRemuxArgs(input: string, outMp4: string): string[] {
  return [
    "-y",
    "-i", resolve(input),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    "-movflags", "+faststart",
    resolve(outMp4),
  ];
}

/** 单段 remux(ts/flv → mp4,无损)。调用方负责目标目录存在。 */
export async function remuxSegment(input: string, outMp4: string): Promise<void> {
  await runFfmpeg(buildRemuxArgs(input, outMp4));
}

/** 分段烧录样式:danmu(飞屏滚动)| livechat(聊天框)。 */
export type SegmentStyle = "danmu" | "livechat";

export interface SegmentWindowRenderOpts extends RenderOpts {
  width?: number;
  height?: number;
}

/**
 * 一份会话 xml + 该段在整场时间轴上的窗口 [startSec, endSec) → 该段 ASS。
 * 时间重定基到 0(该段视频起点),使 ASS 与「只有这一段的 mp4」对齐。
 * 窗口内无任何条目 → ass="" (调用方可跳过烧录,直接拿 remux 的 plain 段当该段产物)。
 */
export function renderXmlWindowToAss(
  xml: string,
  style: SegmentStyle,
  window: { startSec: number; endSec: number },
  opts: SegmentWindowRenderOpts = {},
): { ass: string; count: number } {
  // 与整场烧录一致:排除 member(进场刷屏);gift 仍按 giftValueFilter 过滤。
  const types = new Set(["danmaku", "gift"] as const);
  const items = extractItems(xml, { types, giftValueFilter: opts.giftValueFilter, window });
  if (items.length === 0) return { ass: "", count: 0 };
  if (style === "livechat") {
    const { ass, count } = itemsToLivechatAss(items, { width: opts.width, height: opts.height });
    return { ass, count };
  }
  const { ass, danmaku } = itemsToRollingAss(items, { width: opts.width, height: opts.height });
  return { ass, count: danmaku };
}
