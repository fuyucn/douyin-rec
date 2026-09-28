// ts/src/core/post/integrity.ts
/**
 * integrity.ts — 录制产物「完整性体检」（检测层，不改码流）。
 *
 * 背景:录制的 .ts 可能尾部带残帧（主播硬切断流 / 进程被强杀没收尾），merge 是 `-c copy`(不解码)
 * 会把损坏带进成品 → 上传后末段花屏。本模块用 ffmpeg 做**只读解码扫描**，把「哪一段有多少
 * 真问题」暴露出来，供 merge 命令打印、hub 管线告警。
 *
 * 分级(关键):`ffmpeg -v error` 的行不都是画面损坏，必须分两类，否则天天误报：
 *   - **problem**(告警):真正的解码/码流损坏 —— `cbp too large`、`error while decoding MB`、
 *     `Invalid data found`、缺参考帧(全片扫描时) 等。
 *   - **info**(不告警):`non monotonically increasing dts`(TS 里 B 帧拷贝的重复时间戳，播放器能处理);
 *     以及**跳尾扫描**时必然出现的 seek 起始伪影(`co located POCs unavailable` /
 *     `mmco: unref short failure`)——TS 无索引，`-sseof` 会落在非关键帧上，解码器缺前置参考帧就会报，
 *     与文件好坏无关(已用完好 TS 对照验证)。
 */
import { spawn } from "node:child_process";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
/** 体检告警行前缀:CLI 打印、hub 管线按此识别(唯一真理,避免两边各写一份字符串)。 */
const WARN_MARK = "[integrity] ⚠";
/** 需要打扰用户的行前缀(成品确实有可见风险时才有);⚠ 只进日志/详情,这一档才发通知。 */
const ALERT_MARK = "[integrity] ❗";
const OK_MARK = "[integrity] ✓";

export interface MediaScanResult {
  /** 没有真问题 = true(扫描本身失败时为 false,并用 failed=true 区分)。 */
  ok: boolean;
  /** ffmpeg 执行/被杀等导致扫描不可信。 */
  failed?: boolean;
  /** ffmpeg -v error 的原始行数(含 info 类)。 */
  errorCount: number;
  /** 需要告警的真问题条数。 */
  problemCount: number;
  /** 已知无画面影响的提示条数(重复时间戳 / 跳尾伪影)。 */
  infoCount: number;
  /** 真问题样例(≤5 条,去重)。 */
  samples: string[];
  /** info 样例(≤5 条,去重)。 */
  infoSamples: string[];
}

export interface ParsedIssues {
  errorCount: number;
  problemCount: number;
  infoCount: number;
  samples: string[];
  infoSamples: string[];
}

/** ffmpeg 行 → 去掉 `[h264 @ 0x…]` 前缀的正文(截断,便于日志)。 */
function stripPrefix(line: string): string {
  return line.replace(/^\[[^\]]*\]\s*/, "").slice(0, 140);
}

/**
 * 判定一行属于 problem 还是 info。
 * `seekTail=true` 时把 seek 起始伪影也算 info —— 只有「跳到文件尾部」的扫描才有这个前提。
 */
export function classifyFfmpegLine(msg: string, opts: { seekTail?: boolean } = {}): "problem" | "info" {
  // 重复时间戳:TS/`-c copy` 录制的常见现象,muxer 提示级别,播放器能处理。
  if (/non monotonically increasing dts/i.test(msg)) return "info";
  // 跳尾扫描的起始伪影:解码从非关键帧开始,缺前置参考帧(与文件好坏无关,已验证)。
  if (
    opts.seekTail &&
    /co located POCs unavailable|mmco: unref short failure|reference picture missing|Missing reference picture/i.test(msg)
  ) {
    return "info";
  }
  return "problem";
}

/** ffmpeg stderr → 分级统计 + 去重样例。 */
export function parseFfmpegIssues(
  stderr: string,
  opts: { seekTail?: boolean; maxSamples?: number } = {},
): ParsedIssues {
  const maxSamples = opts.maxSamples ?? 5;
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const samples: string[] = [];
  const infoSamples: string[] = [];
  let problemCount = 0;
  let infoCount = 0;
  for (const line of lines) {
    const msg = stripPrefix(line);
    if (!msg) continue;
    if (classifyFfmpegLine(msg, opts) === "info") {
      infoCount++;
      if (!infoSamples.includes(msg) && infoSamples.length < maxSamples) infoSamples.push(msg);
    } else {
      problemCount++;
      if (!samples.includes(msg) && samples.length < maxSamples) samples.push(msg);
    }
  }
  return { errorCount: lines.length, problemCount, infoCount, samples, infoSamples };
}

/** 兼容旧调用:只取原始行数 + 全部去重样例(不分类)。 */
export function parseFfmpegErrors(stderr: string, maxSamples = 5): { errorCount: number; samples: string[] } {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const samples: string[] = [];
  for (const line of lines) {
    const msg = stripPrefix(line);
    if (msg && !samples.includes(msg) && samples.length < maxSamples) samples.push(msg);
  }
  return { errorCount: lines.length, samples };
}

/** 单行体检结论(CLI 打印 → hub job.log;⚠ 前缀 = 真问题,hub 管线据此告警)。 */
export function formatScanLine(label: string, res: MediaScanResult): string {
  if (res.failed) return `${WARN_MARK} ${label}: 扫描失败(${res.samples[0] ?? "未知错误"})`;
  if (res.problemCount > 0) {
    const sample = res.samples[0] ? `(示例: ${res.samples[0]})` : "";
    const extra = res.infoCount > 0 ? `,另有 ${res.infoCount} 条无画面影响的提示` : "";
    return `${WARN_MARK} ${label}: ${res.problemCount} 处解码错误${sample}${extra}`;
  }
  const note = res.infoCount > 0 ? `(另有 ${res.infoCount} 条时间戳/跳尾提示,无画面影响)` : "";
  return `${OK_MARK} ${label}: 解码正常${note}`;
}

/** 从 merge 命令输出挑出体检告警行(hub 管线用来落 step detail + 发通知)。 */
export function parseIntegrityWarnings(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(WARN_MARK));
}

/** 从 merge 命令输出挑出「需要通知用户」的行(成品尾部确有可见风险)。 */
export function parseIntegrityAlerts(output: string): string[] {
  return output
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith(ALERT_MARK));
}

/** 成品尾部解码错误达到这个数才值得打扰用户:1 处孤立坏块在 2h+ 录像里肉眼不可见。 */
export const TAIL_ALERT_MIN_PROBLEMS = 2;

/** 合并后成品的体检结论行:达到阈值 → ❗(hub 会通知);低于阈值 → ℹ 明细。 */
export function formatOutputVerdict(res: MediaScanResult, minProblems = TAIL_ALERT_MIN_PROBLEMS): string {
  if (res.failed) return `${ALERT_MARK} 成品体检无法完成(${res.samples[0] ?? "扫描失败"})`;
  if (res.problemCount >= minProblems) {
    return `${ALERT_MARK} 成品尾部 60s 有 ${res.problemCount} 处解码错误(示例: ${res.samples[0] ?? "-"}),可能花屏`;
  }
  if (res.problemCount > 0) {
    return `[integrity] ℹ 成品尾部 60s 仅 ${res.problemCount} 处孤立解码错误(<${minProblems}),按无可见影响处理`;
  }
  return "";
}

/**
 * 只读解码扫描一个媒体文件,返回分级统计。
 * `lastSeconds > 0` → 只扫结尾 N 秒(`-sseof`,廉价);此时 seek 起始伪影计为 info(见文件头说明)。
 */
export function scanMediaErrors(
  file: string,
  opts: { lastSeconds?: number; timeoutMs?: number } = {},
): Promise<MediaScanResult> {
  const seekTail = Boolean(opts.lastSeconds && opts.lastSeconds > 0);
  const args = ["-hide_banner", "-v", "error", "-nostdin"];
  if (seekTail) args.push("-sseof", `-${opts.lastSeconds}`);
  args.push("-i", file, "-f", "null", "-");

  return new Promise((resolve) => {
    let stderr = "";
    let done = false;
    const finish = (r: MediaScanResult): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(r);
      }
    };
    const failed = (reason: string): MediaScanResult => ({
      ok: false, failed: true, errorCount: 0, problemCount: 0, infoCount: 0, samples: [reason], infoSamples: [],
    });
    const proc = spawn(FFMPEG, args);
    const timer = setTimeout(() => {
      try { proc.kill("SIGKILL"); } catch { /* 已退出 */ }
      finish(failed("扫描超时被中止"));
    }, opts.timeoutMs ?? 20 * 60_000);

    proc.stderr?.on("data", (d: Buffer) => { stderr = (stderr + String(d)).slice(-65_536); });
    proc.on("error", (e) => finish(failed(String((e as Error).message ?? e))));
    proc.on("close", () => {
      const parsed = parseFfmpegIssues(stderr, { seekTail });
      finish({ ok: parsed.problemCount === 0, ...parsed });
    });
  });
}
