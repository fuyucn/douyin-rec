// ts/src/core/post/burn.ts
import { writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { runFfmpeg, ffprobeVideo, type Progress } from "./ffmpeg.js";

export type Hwaccel = "auto" | "videotoolbox" | "none";

/**
 * 视频编码选项(均可选,默认 = 旧行为 libx264/crf18/veryfast,向后兼容)。
 * - videoCodec: 软编 "libx264"(默认)/"libx265";硬编 "h264_videotoolbox"(macOS,快但忽略 crf)。
 * - crf / preset: 仅软编(x264/x265)生效。
 * - videoBitrate: 码率上限(如 "8M")。软编 → 加 -maxrate/-bufsize(crf 受 VBV 约束,长录控大小);
 *                 硬编(videotoolbox 不吃 crf)→ 作为 -b:v 目标码率。不设则软编纯 crf、硬编用默认 -q:v。
 */
export interface EncodeOpts {
  videoCodec?: string;
  crf?: number;
  preset?: string;
  videoBitrate?: string;
}

export interface BurnArgsOpts extends EncodeOpts {
  inputMp4: string;
  assName: string;
  outMp4: string;
  fontsDir: string;
  fps: number;
  hwaccel: Exclude<Hwaccel, "auto">;
}

/** 视频编码段(纯函数):据 codec 选软编(crf+preset[+maxrate])或硬编 videotoolbox(b:v|q:v)。 */
export function videoEncodeArgs(o: EncodeOpts): string[] {
  const codec = o.videoCodec ?? "libx264";
  if (codec.endsWith("_videotoolbox")) {
    // 硬件编码:不支持 crf/preset;有码率用 -b:v,否则用质量档 -q:v 60(≈ 高质量)。
    return ["-c:v", codec, ...(o.videoBitrate ? ["-b:v", o.videoBitrate] : ["-q:v", "60"])];
  }
  // 软件编码(x264/x265):crf + preset;若设码率上限则加 VBV 约束(maxrate+bufsize),长录可控大小。
  const args = ["-c:v", codec, "-crf", String(o.crf ?? 18), "-preset", o.preset ?? "veryfast"];
  if (o.videoBitrate) args.push("-maxrate", o.videoBitrate, "-bufsize", o.videoBitrate);
  return args;
}

/**
 * 构造 ffmpeg 烧录命令（纯函数）。移植 merger.py L737-807 danmu burn 命令。
 * ass 用 basename，调用方设 cwd 到输出目录（规避 libass 路径特殊字符问题）。
 * fps>0 → "fps=N," 前缀；-hwaccel videotoolbox 仅 hwaccel==="videotoolbox" 时加入。
 * 视频编码段由 videoEncodeArgs 决定(默认 libx264/crf18/veryfast,可经 EncodeOpts 覆盖)。
 */
export function buildBurnArgs(o: BurnArgsOpts): string[] {
  // Python: f"fps={src_fps:.6g}," — toPrecision(6) mirrors :.6g
  const fpsFilter = o.fps > 0 ? `fps=${Number(o.fps.toPrecision(6))},` : "";
  const vf = `${fpsFilter}ass=${o.assName}:fontsdir=${o.fontsDir},format=yuv420p`;
  return [
    "-y",
    ...(o.hwaccel === "videotoolbox" ? ["-hwaccel", "videotoolbox"] : []),
    "-i", resolve(o.inputMp4),
    "-progress", "pipe:1", "-nostats",
    "-vf", vf,
    ...videoEncodeArgs(o),
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    resolve(o.outMp4),
  ];
}

function resolveHwaccel(h: Hwaccel): Exclude<Hwaccel, "auto"> {
  if (h !== "auto") return h;
  return process.platform === "darwin" ? "videotoolbox" : "none";
}

export interface BurnOpts extends EncodeOpts {
  inputMp4: string;
  assText: string;
  outMp4: string;
  fontsDir: string;
  hwaccel?: Hwaccel;
  onProgress?: (p: Progress) => void;
}

/**
 * 写 ASS 到输出目录（与 outMp4 同目录、同 stem.ass）→ ffprobe 取 fps/durationMs
 * → buildBurnArgs → runFfmpeg(cwd=outDir)。
 * hwaccel "auto" → darwin=videotoolbox 否则 none（resolveHwaccel）。
 */
export async function burn(o: BurnOpts): Promise<void> {
  const outDir = dirname(resolve(o.outMp4));
  const assName = basename(o.outMp4).replace(/\.mp4$/i, ".ass");
  writeFileSync(resolve(outDir, assName), o.assText, "utf-8");
  const { fps, durationMs } = await ffprobeVideo(o.inputMp4).catch(() => ({
    fps: 0,
    durationMs: 0,
  }));
  const args = buildBurnArgs({
    inputMp4: o.inputMp4,
    assName,
    outMp4: o.outMp4,
    fontsDir: o.fontsDir,
    fps,
    hwaccel: resolveHwaccel(o.hwaccel ?? "auto"),
    videoCodec: o.videoCodec,
    crf: o.crf,
    preset: o.preset,
    videoBitrate: o.videoBitrate,
  });
  await runFfmpeg(args, { cwd: outDir, totalMs: durationMs, onProgress: o.onProgress });
}
