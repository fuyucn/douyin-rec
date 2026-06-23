// ts/src/core/post/ass/multi.ts
// 多分段弹幕合并渲染：每段 XML 时间相对该段起点，按前序 .ts 累计时长平移到拼接后时间轴。
// 移植 merger.combine_ass_files 的累计偏移思路，但偏移作用在「抽取出的 item」上（而非
// 已渲染的 Dialogue 行），这样滚动轨碰撞检测在合并后的完整时间轴上正确工作。
import { readFileSync } from "node:fs";
import { ffprobeDuration } from "../ffmpeg.js";
import { extractItems, itemsToRollingAss, itemsToLivechatAss } from "./render.js";
import type { ChatItem } from "./livechat.js";

export type DanmuStyle = "danmu" | "livechat";

export interface MultiRenderOpts {
  giftValueFilter?: number;
  width?: number;
  height?: number;
}

export interface MultiRenderResult {
  ass: string;
  count: number;          // danmu: 弹幕条数；livechat: Dialogue 行数
}

/** 已读取的分段：XML 文本 + 该段视频时长（秒）。 */
export interface SegmentWithDuration {
  xml: string;
  durationSec: number;
}

/**
 * 纯函数核心（无 IO）：对各段 XML 按前序段累计时长平移后合并渲染。
 * 累计偏移 offsets[i] = sum(durationSec[0..i-1])。
 * 可直接单测，无需真实 ffprobe。
 */
export function combineWithOffsets(
  segments: SegmentWithDuration[],
  style: DanmuStyle,
  opts: MultiRenderOpts = {},
): MultiRenderResult {
  // 两种样式都排除 member（进入直播间）——对齐 VPS/Python 输出（进场刷屏，Python 不收）
  const types = new Set(["danmaku", "gift"] as const);

  const all: ChatItem[] = [];
  let offset = 0;
  for (const seg of segments) {
    const items = extractItems(seg.xml, {
      giftValueFilter: opts.giftValueFilter,
      types,
      offset,
    });
    all.push(...items);
    offset += seg.durationSec;
  }

  // 合并后按时间升序（滚动轨碰撞检测假定时间近似有序；livechat 内部也会再排序）
  all.sort((a, b) => a.timeSec - b.timeSec);

  if (style === "livechat") {
    const { ass, count } = itemsToLivechatAss(all, { width: opts.width, height: opts.height });
    return { ass, count };
  }
  const { ass, danmaku } = itemsToRollingAss(all, { width: opts.width, height: opts.height });
  return { ass, count: danmaku };
}

export interface Segment {
  xmlPath: string;
  tsPath: string;
}

/**
 * 多分段 → 单 ASS。对每段 ffprobe 其 .ts 时长得到累计偏移，读 XML 抽取并平移，
 * 喂给 RollingAss(danmu) 或 LiveChatAss(livechat)。复用 combineWithOffsets 纯核心。
 */
export async function renderSegmentsToAss(
  segments: Segment[],
  style: DanmuStyle,
  opts: MultiRenderOpts = {},
): Promise<MultiRenderResult> {
  const withDur: SegmentWithDuration[] = [];
  for (const s of segments) {
    let durationSec = 0;
    try {
      durationSec = await ffprobeDuration(s.tsPath);
    } catch (e) {
      // 探测失败按 0 计(对齐 Python 容错),但**绝不静默** —— 后续段弹幕偏移会前移、无声漂移。
      console.warn(`[ass] ⚠️ ffprobe 时长失败,该段偏移按 0 计(后续弹幕可能漂移): ${s.tsPath} — ${(e as Error)?.message ?? e}`);
    }
    withDur.push({ xml: readFileSync(s.xmlPath, "utf-8"), durationSec });
  }
  return combineWithOffsets(withDur, style, opts);
}
