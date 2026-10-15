// ts/src/core/post/concat.ts
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, basename } from "node:path";
import { isOutputFormat, isVideoFileName, segmentIndexOf, sessionBaseOf, stageContainerOfPath, stampedSessionBaseOf, STAGE_CONTAINERS, type StageFormat } from "@drec/core";
import { runFfmpeg } from "./ffmpeg.js";
import { runFfmpegAtomic } from "./artifact.js";

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

export interface GroupSessionsOpts {
  /**
   * 会话基名 → 节点侧原地替换后的容器(读自该会话的 `{base}.session.json`,见 {@link readNodeFormats})。
   * 只有**录制目录**的调用方才传;不传 = 一个 mp4/mkv 都不收(stage / 合并模式 / 默认 original 与 base 一致)。
   */
  nodeFormats?: ReadonlyMap<string, StageFormat>;
}

/**
 * 读目录里各会话 `{base}.session.json` 的 `nodeFormat`(节点侧原地替换留的标记)。
 * 老文件缺字段 = 未转换(不入表);损坏/非白名单值同样忽略,绝不抛。
 * `files` = 该目录的文件名列表(只挑 `.session.json`)。
 */
export function readNodeFormats(dir: string, files: string[]): Map<string, StageFormat> {
  const out = new Map<string, StageFormat>();
  for (const f of files) {
    if (!f.endsWith(".session.json")) continue;
    try {
      const d = JSON.parse(readFileSync(join(dir, basename(f)), "utf-8")) as { nodeFormat?: unknown };
      const nf = d.nodeFormat;
      if (typeof nf === "string" && isOutputFormat(nf) && nf !== "original") {
        out.set(basename(f).slice(0, -".session.json".length), nf);
      }
    } catch { /* 缺失/损坏 → 视为未转换 */ }
  }
  return out;
}

/**
 * 目录 → 会话分组,**带上该目录里 session.json 声明的节点侧容器**(issue #143):
 * 所有「在真实目录上分组」的调用点共用这一个入口,避免有的认 mp4/mkv 分段、有的不认。
 * `files` 缺省 = `readdirSync(dir)`;调用方已有列表时传入避免重复读盘。
 * 目录里没有 session.json(或无 nodeFormat)= 与裸 `groupSessions(files)` 完全一致。
 */
export function groupSessionsInDir(dir: string, files: string[] = readdirSync(dir)): Record<string, SessionGroup> {
  return groupSessions(files, { nodeFormats: readNodeFormats(dir, files) });
}

/**
 * 文件名列表 → { base: SessionGroup }，ts/segmentXmls 已按段号排序。
 *
 * 同时填充两种弹幕来源（向后兼容）：
 *   - `xml`: 会话级单文件 {base}.xml（biliLive 或合并产物）
 *   - `segmentXmls`: DLR/VPS per-segment {base}_NNN.xml，与 ts[i] 一一对齐
 * 两者按各自规律就地填充；调用方按需选用（多段烧录优先 segmentXmls）。
 */
export function groupSessions(files: string[], opts: GroupSessionsOpts = {}): Record<string, SessionGroup> {
  const out: Record<string, SessionGroup> = {};
  const ensure = (b: string): SessionGroup => (out[b] ??= { ts: [], xml: null, segmentXmls: [] });

  // First pass: collect video segments。录制原生容器 .ts(ffmpeg/DLR/biliLive)/.flv(mesio)恒认(与 base 一致);
  // .mp4/.mkv 只有一种来源是源录像 —— 节点侧原地替换(issue #137):该会话的 session.json 声明了
  // `nodeFormat`(`opts.nodeFormats`)且扩展名与之相符,带段号与无段号单文件都收。其余一律不收:
  //   - 无声明(默认 original / stage 目录 / 合并模式):`{base}.mp4` 是合并产物、`{dateName}_{NNN}.mp4` 是
  //     分段模式产出的分 P(标题模板含时间时形如分段),收了会在收口/重跑时被当源删掉或重复合并;
  //   - 带 part 序号的切分产物 `{stem}_part{N}.mp4`(split.ts 小写命名)不是分段,声明了也不收;
  //   - `_danmu`/`_livechat` 烧录产物、无时间戳基名的产物天然不带时间戳,同样被挡在外面。
  const NATIVE = /\.(ts|flv)$/i;
  // 切分产物判定不用正则(session-name-guard 禁止在 core 之外写分段序号正则):stem 末尾 `_part` + 纯数字。
  const isSplitPart = (f: string): boolean => {
    const stem = f.slice(0, f.lastIndexOf("."));
    const i = stem.lastIndexOf("_part");
    const tail = stem.slice(i + 5);
    return i >= 0 && tail.length > 0 && [...tail].every((c) => c >= "0" && c <= "9");
  };
  for (const f of files) {
    if (NATIVE.test(f)) {
      ensure(sessionBase(f)).ts.push(f);
    } else if (isVideoFileName(f)) {
      if (isSplitPart(f) || !stampedSessionBaseOf(basename(f))) continue;
      const declared = opts.nodeFormats?.get(sessionBase(f));
      if (!declared || !f.toLowerCase().endsWith(STAGE_CONTAINERS[declared].ext)) continue;
      ensure(sessionBase(f)).ts.push(f);
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
    // 拼好的成品走原子收尾(`.part` → rename):被强杀时不会留下「最终名存在但没写完」的成品,
    // 否则下游会把它当已完成产物复用/上传(见 artifact.ts 注释)。
    await runFfmpegAtomic([
      "-y",
      "-f", "concat",
      "-safe", "0",
      "-i", list,
      "-c", "copy",
      ...stageContainerOfPath(outMp4).finalizeArgs,
      outMp4,
    ], outMp4);   // faststart 收尾静默由 runFfmpeg 的 CPU 探针兜住
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
