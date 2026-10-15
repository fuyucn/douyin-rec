// ts/src/core/post/concat.ts
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { isVideoFileName, segmentIndexOf, sessionBaseOf, stageContainerOfPath, stampedSessionBaseOf } from "@drec/core";
import { runFfmpeg } from "./ffmpeg.js";

/**
 * 从视频分段文件名取会话基名(剥分段后缀 + 容器后缀);规则见 core `sessionBaseOf`。
 * 容器 .ts(ffmpeg/DLR/biliLive)与 .flv(mesio)均认。
 */
export function sessionBase(tsName: string): string {
  return sessionBaseOf(tsName);
}

/** 取 .xml 文件名的会话基名(剥分段后缀 + .xml),与 sessionBase 同规则。 */
export function xmlSessionBase(xmlName: string): string {
  return sessionBaseOf(xmlName);
}

/** 按段号数字排序（非字典序）；无段号的文件（单 {base}.ts）排最前。 */
export function sortSegments(files: string[]): string[] {
  return [...files].sort((a, b) => segmentIndexOf(a) - segmentIndexOf(b));
}

export interface SessionGroup {
  /** 分段 .ts，已按段号排序。 */
  ts: string[];
  /** 单一会话级 {base}.xml（biliLive / 合并产物），无则 null。 */
  xml: string | null;
  /** DLR/VPS per-segment xml（{base}_NNN.xml），已按段号排序与 ts 对齐；无则空数组。 */
  segmentXmls: string[];
}

/**
 * 文件名列表 → { base: SessionGroup }，ts/segmentXmls 已按段号排序。
 *
 * 同时填充两种弹幕来源（向后兼容）：
 *   - `xml`: 会话级单文件 {base}.xml（biliLive 或合并产物）
 *   - `segmentXmls`: DLR/VPS per-segment {base}_NNN.xml，与 ts[i] 一一对齐
 * 两者按各自规律就地填充；调用方按需选用（多段烧录优先 segmentXmls）。
 */
export function groupSessions(files: string[]): Record<string, SessionGroup> {
  const out: Record<string, SessionGroup> = {};
  const ensure = (b: string): SessionGroup => (out[b] ??= { ts: [], xml: null, segmentXmls: [] });

  // First pass: collect video segments。录制原生容器 .ts(ffmpeg/DLR/biliLive)/.flv(mesio)恒认;
  // .mp4/.mkv(节点侧原地替换后的分段,issue #137)也认,但**排除合并/烧录产物**以免合并自己吃自己:
  //   - `_danmu`/`_livechat` 结尾的烧录产物;
  //   - 无时间戳基名的合并产物 `{主播}_{日期}.mp4`;
  //   - 同会话已有 .ts/.flv 分段时,无段号后缀的 `{base}.mp4/.mkv`(= 该会话的合并产物,keepTime/撞名时带时间戳)。
  const NATIVE = /\.(ts|flv)$/i;
  const nativeBases = new Set(files.filter((f) => NATIVE.test(f)).map(sessionBase));
  for (const f of files) {
    if (NATIVE.test(f)) {
      ensure(sessionBase(f)).ts.push(f);
    } else if (isVideoFileName(f)) {
      const stem = f.replace(/\.[^.]+$/, "");
      if (/_(danmu|livechat)$/i.test(stem)) continue;
      if (!stampedSessionBaseOf(f)) continue;
      const b = sessionBase(f);
      if (segmentIndexOf(f) < 0 && nativeBases.has(b)) continue;
      ensure(b).ts.push(f);
    }
  }

  // Second pass: associate .xml files
  //   - {base}.xml （无段号后缀）→ 会话级 xml
  //   - {base}_NNN.xml / -PARTNNN.xml → per-segment segmentXmls
  for (const f of files) {
    if (!/\.xml$/i.test(f)) continue;
    const seg = segmentIndexOf(f);
    if (seg < 0) {
      // 会话级：basename 去掉 .xml 即为 base
      const b = basename(f).replace(/\.xml$/i, "");
      if (out[b]) out[b].xml = f;
    } else {
      const b = xmlSessionBase(f);
      if (out[b]) out[b].segmentXmls.push(f);
    }
  }

  // Sort each session's ts + segmentXmls array by segment index
  for (const b of Object.keys(out)) {
    out[b].ts = sortSegments(out[b].ts);
    out[b].segmentXmls.sort((a, c) => segmentIndexOf(a) - segmentIndexOf(c));
  }

  return out;
}

/**
 * 合并一组分段 .ts 文件 → outMp4（同会话 -c copy 无损）。
 * 输出容器(mp4/mkv)由 `outMp4` 扩展名决定,封装参数取自 core 注册表。
 * 写 concat 列表到临时目录，完成后清理。
 */
export async function mergeSession(
  tsFilesAbs: string[],
  outMp4: string,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "concat_"));
  const list = join(dir, "list.txt");
  try {
    // 先把每段规范化为「单视频(v:0)+单音频(a:0?)」、统一流顺序,再 concat。
    // 抖音 .ts 有时含双 program、且段间流顺序不一致(段A 视频在前、段B 音频在前)→
    // 直接 concat -c copy 会在段边界报「Invalid data found when processing input」。
    // 规范化是 -c copy(无损,只丢弃冗余的第二路流),统一布局后同参数(h264/aac)可安全拷贝拼接。
    // a:0? 的 `?` = 该段无音频时跳过而非报错。
    const normalized: string[] = [];
    for (let i = 0; i < tsFilesAbs.length; i++) {
      const seg = join(dir, `seg${i}.ts`);
      await runFfmpeg([
        "-y",
        "-i", resolve(tsFilesAbs[i]),
        "-map", "0:v:0",
        "-map", "0:a:0?",
        "-c", "copy",
        "-f", "mpegts",
        seg,
      ]);
      normalized.push(seg);
    }
    writeFileSync(
      list,
      normalized.map((p) => `file '${p}'`).join("\n") + "\n",
      "utf-8",
    );
    await runFfmpeg([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", list,
      "-c", "copy",
      ...stageContainerOfPath(outMp4).finalizeArgs,
      outMp4,
    ]);   // faststart 收尾静默由 runFfmpeg 的 CPU 探针兜住
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
