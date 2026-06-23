// ts/src/core/post/burn.ts
import { writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { runFfmpeg, ffprobeVideo, type Progress } from "./ffmpeg.js";

export type Hwaccel = "auto" | "videotoolbox" | "none";

export interface BurnArgsOpts {
  inputMp4: string;
  assName: string;
  outMp4: string;
  fontsDir: string;
  fps: number;
  hwaccel: Exclude<Hwaccel, "auto">;
}

/**
 * 构造 ffmpeg 烧录命令（纯函数）。移植 merger.py L737-807 danmu burn 命令。
 * ass 用 basename，调用方设 cwd 到输出目录（规避 libass 路径特殊字符问题）。
 * fps>0 → "fps=N," 前缀；-hwaccel videotoolbox 仅 hwaccel==="videotoolbox" 时加入。
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
    "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    resolve(o.outMp4),
  ];
}

function resolveHwaccel(h: Hwaccel): Exclude<Hwaccel, "auto"> {
  if (h !== "auto") return h;
  return process.platform === "darwin" ? "videotoolbox" : "none";
}

export interface BurnOpts {
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
  });
  await runFfmpeg(args, { cwd: outDir, totalMs: durationMs, onProgress: o.onProgress });
}
