import type { Command } from "commander";
import { readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { groupSessionsInDir, renderXmlToAss, burn, FONTS_DIR } from "@drec/post-process";
import { commandWebhook, toggledNotifier } from "./cli-notifier.js";

interface BurnOptions {
  video?: string; xml?: string; indir?: string; base?: string; style: string;
  giftValue: string; out?: string; hwaccel: string; videoCodec?: string;
  crf?: number; preset?: string; videoBitrate?: string;
}

async function renderSegments(o: BurnOptions & { indir: string; base: string }) {
  const { renderSegmentsToAss } = await import("@drec/post-process");
  const groups = groupSessionsInDir(o.indir);
  const g = groups[o.base];
  if (!g || g.segmentXmls.length === 0) {
    console.error(`[burn] ${o.base}: 在 ${o.indir} 找不到 per-segment xml（{base}_NNN.xml）`);
    process.exit(2); return;
  }
  const n = Math.min(g.ts.length, g.segmentXmls.length);
  const segments = Array.from({ length: n }, (_, i) => ({
    xmlPath: join(o.indir!, g.segmentXmls[i]),
    tsPath: join(o.indir!, g.ts[i]),
  }));
  const video = o.video ?? join(o.indir, `${o.base}.mp4`);
  const dim = await probeDim(video);
  const r = await renderSegmentsToAss(segments, o.style as "danmu" | "livechat", { giftValueFilter: Number(o.giftValue), ...dim });
  const label = o.style === "livechat" ? `${r.count} 行(livechat, ${n} 段)` : `${r.count} 弹幕(${n} 段)`;
  return { video, ass: r.ass, label };
}

async function renderSingle(o: BurnOptions & { video: string; xml: string }) {
  const xml = readFileSync(o.xml, "utf-8");
  const video = o.video;
  const dim = await probeDim(video);
  if (o.style === "livechat") {
    const { renderXmlToLivechat } = await import("@drec/post-process");
    const r = renderXmlToLivechat(xml, { giftValueFilter: Number(o.giftValue), ...dim });
    return { video, ass: r.ass, label: `${r.count} 行(livechat)` };
  } else {
    const r = renderXmlToAss(xml, { giftValueFilter: Number(o.giftValue), ...dim });
    return { video, ass: r.ass, label: `${r.danmaku} 弹幕` };
  }
}

async function renderInput(o: BurnOptions) {
  if (o.indir && o.base) return renderSegments({ ...o, indir: o.indir, base: o.base });
  if (o.video && o.xml) return renderSingle({ ...o, video: o.video, xml: o.xml });
  console.error("[burn] 需 --video + --xml（单文件）或 --indir + --base（多段）");
  process.exit(2);
}

async function runBurn(program: Command, o: BurnOptions): Promise<void> {
  if (o.style !== "danmu" && o.style !== "livechat") {
    console.error("[burn] --style 仅支持 danmu | livechat"); process.exit(2); return;
  }
  try {
    const rendered = await renderInput(o);
    if (!rendered) return;
    const { video, ass, label } = rendered;
    const out = o.out ?? resolve(video).replace(/(\.[^./\\]+)$/, `_${o.style}$1`);
    console.log(`[burn] ${basename(video)} + ${label} → ${basename(out)}`);
    await burn({ inputMp4: video, assText: ass, outMp4: out, fontsDir: FONTS_DIR, hwaccel: o.hwaccel as "auto",
      videoCodec: o.videoCodec, crf: o.crf, preset: o.preset, videoBitrate: o.videoBitrate });
    console.log(`[burn] 完成: ${out}`);
    await toggledNotifier(commandWebhook(program)).notify({ kind: "burnDone", style: o.style, file: out });
  } catch (e) {
    await toggledNotifier(commandWebhook(program)).notify({ kind: "error", stage: "burn", message: (e as Error).message });
    throw e;
  }
}

async function probeDim(video: string): Promise<{ width?: number; height?: number }> {
  try {
    const { ffprobeVideo } = await import("@drec/post-process");
    const { width, height } = await ffprobeVideo(video);
    return width > 0 && height > 0 ? { width, height } : {};
  } catch {
    return {};
  }
}

export function registerBurnCommand(program: Command): void {
  program
    .command("burn")
    .addHelpText("after", `\n例:\n  $ douyin-rec burn --video out.mp4 --xml out.xml --style danmu --gift-value 0.9\n  $ douyin-rec burn --indir recordings --base 主播_2026-06-11 --style livechat`)
    .description("烧录弹幕 ASS → {video stem}_danmu.mp4 / {video stem}_livechat.mp4")
    .option("--video <mp4>", "已合并的 plain mp4（单文件模式；多段模式默认 {indir}/{base}.mp4）")
    .option("--xml <xml>", "会话弹幕 xml（单文件模式）")
    .option("--indir <dir>", "多段模式：含 {base}_NNN.ts + {base}_NNN.xml 的目录")
    .option("--base <base>", "多段模式：会话基名（如 主播_2026-06-11_15-01-27）")
    .option("--style <s>", "danmu|livechat", "danmu")
    .option("--gift-value <n>", "礼物价值过滤阈值", "0.9")
    .option("--out <mp4>", "输出（默认 {video stem}_{style}.mp4）")
    .option("--hwaccel <h>", "auto|videotoolbox|none", "auto")
    .option("--video-codec <c>", "视频编码器: libx264(默认)|libx265|h264_videotoolbox(硬编,忽略 crf)")
    .option("--crf <n>", "软编质量(仅 x264/x265),越小越清晰", (v) => Number(v))
    .option("--preset <p>", "软编预设(仅 x264/x265): veryfast(默认)|fast|medium…")
    .option("--video-bitrate <r>", "码率上限如 8M(软编→VBV 约束控大小;硬编→目标 -b:v)")
    .action((o: BurnOptions) => runBurn(program, o));
}
