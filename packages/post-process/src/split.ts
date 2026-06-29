import { statSync } from "node:fs";
import { resolve } from "node:path";
import { runFfmpeg, ffprobeDuration } from "./ffmpeg.js";

/** B站单文件上限:16GiB(粉丝 <1000 的账号;≥1000 才解锁 64GB)。biliup 不绕过(服务端强制)。 */
export const BILI_FILE_LIMIT_BYTES = 16 * 1024 ** 3;

export interface SplitPlan {
  /** 切成几段(1 = 无需切)。 */
  parts: number;
  /** 每段时长(秒);parts===1 时为 0。 */
  segmentTimeSec: number;
}

/**
 * 计划按大小上限切分(纯函数)。
 * sizeBytes ≤ limit → 不切(parts=1)。超限 → parts = ceil(size / (limit*margin)),
 * 段时长 = ceil(duration/parts)。margin(默认 0.97)留余量,防 `-c copy` 按关键帧取整后某段略超限。
 */
export function planSizeSplit(
  sizeBytes: number,
  durationSec: number,
  limitBytes: number = BILI_FILE_LIMIT_BYTES,
  marginRatio = 0.97,
): SplitPlan {
  if (sizeBytes <= limitBytes) return { parts: 1, segmentTimeSec: 0 };
  const parts = Math.max(2, Math.ceil(sizeBytes / (limitBytes * marginRatio)));
  const segmentTimeSec = Math.ceil(durationSec / parts);
  return { parts, segmentTimeSec };
}

/** 构造 ffmpeg segment 切分参数(纯函数):`-c copy` 无损,按时长切到 outPattern(含 %d)。 */
export function buildSplitArgs(inputMp4: string, segmentTimeSec: number, outPattern: string): string[] {
  return [
    "-y", "-i", resolve(inputMp4),
    "-c", "copy", "-map", "0",
    "-f", "segment", "-segment_time", String(segmentTimeSec),
    "-reset_timestamps", "1",
    outPattern,
  ];
}

export interface SplitDeps {
  /** 注入(测试用);默认真实 fs/ffprobe/ffmpeg。 */
  statSize?: (p: string) => number;
  probeDuration?: (p: string) => Promise<number>;
  run?: (argv: string[]) => Promise<void>;
}

/**
 * 把超过 limitBytes 的 mp4 用 `-c copy` 无损切成多段 <limit,返回各段路径(已存在且 ≤limit 则原样返回单元素)。
 * 段命名 `{stem}_part{N}.mp4`(N 从 0)。不删原文件(调用方决定)。
 */
export async function splitToSizeLimit(
  inputMp4: string,
  limitBytes: number = BILI_FILE_LIMIT_BYTES,
  deps: SplitDeps = {},
): Promise<string[]> {
  const statSize = deps.statSize ?? ((p: string) => statSync(p).size);
  const probeDuration = deps.probeDuration ?? ffprobeDuration;
  const run = deps.run ?? runFfmpeg;

  const size = statSize(inputMp4);
  if (size <= limitBytes) return [inputMp4];

  const durationSec = await probeDuration(inputMp4);
  const { parts, segmentTimeSec } = planSizeSplit(size, durationSec, limitBytes);
  const stem = resolve(inputMp4).replace(/\.mp4$/i, "");
  await run(buildSplitArgs(inputMp4, segmentTimeSec, `${stem}_part%d.mp4`));
  return Array.from({ length: parts }, (_, i) => `${stem}_part${i}.mp4`);
}
