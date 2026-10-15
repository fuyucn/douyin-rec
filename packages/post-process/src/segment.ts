// 分段(不合并)后处理:录制分段 .ts/.flv 各自 remux 成独立 mp4,以及把一份会话级 xml
// 按该段在整场时间轴上的窗口切出该段的弹幕 → 该段 ASS。供 hub「分段上传」模式逐段产出。
import { resolve } from "node:path";
import { STAGE_CONTAINERS, stageContainerOfPath, type StageFormat } from "@drec/core";
import { runFfmpeg } from "./ffmpeg.js";
import { runFfmpegAtomic } from "./artifact.js";
import { extractItems, itemsToLivechatAss, itemsToRollingAss, type RenderOpts } from "./ass/render.js";

/**
 * 单段 remux 参数(纯函数):`-c copy` 无损换容器(ts/flv → mp4),不做任何拼接。
 * `-map 0:v:0 -map 0:a:0?` 与 mergeSession 的归一化口径一致(抖音 .ts 可能含双 program/多路流);
 * `?` = 该段无音频时跳过而非报错。
 */
export function buildRemuxArgs(input: string, outMp4: string, fmt?: StageFormat): string[] {
  // 容器专属输出参数(mp4:时基 90000 + faststart;mkv:无)按**输出路径扩展名**取自 core 注册表。
  // 这些参数是 mp4 专属,mkv 不带,故不能写死。
  // 显式传 `fmt`(节点侧原地替换写临时文件,扩展名不是容器扩展名)→ 按 fmt 取参数并显式 `-f` 指定封装器。
  const container = fmt ? STAGE_CONTAINERS[fmt] : stageContainerOfPath(outMp4);
  return [
    "-y",
    "-i", resolve(input),
    "-map", "0:v:0",
    "-map", "0:a:0?",
    "-c", "copy",
    // mp4:FLV(1000Hz 时基)直接 -c copy 进 mp4 会得到 time_base=1/16000(非 H.264 标准),
    // B站转码器拒收 → state=-16 转码失败。显式钉成 90000(视频标准时基)——见注册表 remuxArgs。
    ...container.remuxArgs,
    ...(fmt ? ["-f", container.muxer] : []),
    resolve(outMp4),
  ];
}

/** 单段 remux(ts/flv → mp4,无损)。调用方负责目标目录存在。 */
export interface RemuxSegmentOpts {
  /**
   * 是否由本函数负责**原子落盘**(写 `.part` → rename),默认 true。
   *
   * 置 false 只给「调用方自己已经做了两阶段落盘」的场景:节点侧原地替换(`node-remux`)先写
   * `{最终名}.{owner}-{pid}.drec-remux`、校验通过才 fsync + rename 成最终名 —— 它的中间名
   * 本身就是崩溃接管扫描(`recoverNodeRemux`)的识别依据,套一层 `.part` 会让那个解析认不出来。
   */
  atomic?: boolean;
}

export async function remuxSegment(input: string, outMp4: string, fmt?: StageFormat, opts: RemuxSegmentOpts = {}): Promise<void> {
  // 看门狗用「进程 CPU 时间」判活(runFfmpegAtomic 内默认):faststart 收尾一遍不写 stdout/stderr,
  // 但一直在烧 CPU → 不会被误判卡死(线上实测整场转人工的根因)。
  // 落盘走原子收尾(`.part` → rename):被强杀时不留下「最终名存在但 moov 没写完」的半成品,
  // 否则下游的续跑判定(existsSync)会把它当成品复用并静默投稿(见 artifact.ts 注释)。
  // `fmt` 原样透传(节点侧原地替换会传非容器扩展名的临时名,必须显式 `-f` 指定封装器)。
  const args = buildRemuxArgs(input, outMp4, fmt);
  if (opts.atomic === false) { await runFfmpeg(args); return; }
  await runFfmpegAtomic(args, outMp4);
}

/** 分段烧录样式:danmu(飞屏滚动)| livechat(聊天框)。 */
export type SegmentStyle = "danmu" | "livechat";

/**
 * 把一串段(时长)按目标时长聚成若干组 —— 每组拼成**一个分 P**。
 *
 * 动机:mesio 的 `--fix` 会在流不连续时切出大量碎段(0.2s 初始化残片 + 时长不一的真实段),
 * 导致分 P 数量爆炸且长短参差。这里把连续段按累计时长聚成接近 `targetSec` 的组,
 * 使每个分 P 的时长接近录制时设置的分段时长。
 *
 * 纯函数(不依赖 ffprobe)。`maxRatio` 允许超出目标的比例(默认 1.2 = 最多超 20%),
 * 避免为凑整把一小段并进已经快满的组里。单个段自身超过上限时独占一组(不切它)。
 */
export function planSegmentGroups(
  durations: number[],
  targetSec: number,
  maxRatio = 1.2,
): number[][] {
  if (targetSec <= 0 || durations.length === 0) return durations.map((_, i) => [i]);
  const limit = targetSec * Math.max(1, maxRatio);
  const groups: number[][] = [];
  let cur: number[] = [];
  let sum = 0;
  for (let i = 0; i < durations.length; i++) {
    const d = durations[i];
    if (cur.length > 0 && sum + d > limit) {
      groups.push(cur);
      cur = [];
      sum = 0;
    }
    cur.push(i);
    sum += d;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

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
