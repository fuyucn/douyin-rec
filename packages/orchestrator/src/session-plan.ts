import { readdirSync } from "node:fs";

/** 该场 stage 合成产物的确定性路径(merge 后 / 续跑反推)。 */
export interface StageProducts {
  dateName: string;
  /** merge 命令 --base 用的完整会话 base(含时间戳),如 `主播名_2026-08-10_23-08-10`。 */
  sessionBase: string;
  /** 断流重连多会话时全部会话 base(按时间序);单会话 = [sessionBase]。 */
  sessionBases: string[];
  plain: string;
  danmuMp4: string;
  livechatMp4: string;
  plainXml: string;
  xmlArg: string;
}

/**
 * `主播名_2026-08-10_23-08-10` 的会话文件 → 会话 base。识别三种分段后缀:
 * `-PART01`(biliLive)、`_PART001`(biliLive 下划线)、`_000`(本项目录制器/DLR/ffmpeg 的裸段号)。
 */
export function sessionBaseOfFile(name: string): string | undefined {
  const m = /^(.+_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})(?:-PART\d+|_PART\d+|_\d{3,})?\.(?:ts|flv|xml|mp4)$/i.exec(name);
  return m?.[1];
}

/** 从文件名集合提取全部会话 base，排序并去重(同一场多分段只算一次)。 */
export function sessionBasesOfFiles(files: string[]): string[] {
  return [...new Set(files.map(sessionBaseOfFile).filter((s): s is string => Boolean(s)))].sort();
}

function joinPath(dir: string, name: string): string {
  // 与 pipeline 原实现一致:直接用 path 分隔符拼(避免在此 import node:path 也能跑浏览器构建无关)。
  return `${dir}/${name}`;
}

/** 从 stageSub 目录按确定命名反推产物路径;连一个源文件都找不到 → null。 */
export function deriveStageProducts(stageSub: string): StageProducts | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const danmu = files.find((f) => f.endsWith("_danmu.mp4"));
  const livechat = files.find((f) => f.endsWith("_livechat.mp4"));
  const plainF = files.find((f) => f.endsWith(".mp4") && !f.endsWith("_danmu.mp4") && !f.endsWith("_livechat.mp4"));
  let dateName: string | undefined;
  let sessionBase = "";
  let sessionBases: string[] = [];
  if (danmu) dateName = danmu.slice(0, -"_danmu.mp4".length);
  else if (livechat) dateName = livechat.slice(0, -"_livechat.mp4".length);
  else if (plainF) dateName = plainF.slice(0, -".mp4".length);
  if (!dateName) {
    // merge 还没产出时(失败重跑):从拉来的源段反推 dateName + 完整 sessionBase。
    sessionBases = sessionBasesOfFiles(files);
    sessionBase = sessionBases[0] ?? "";
    if (!sessionBase) return null;
    dateName = sessionBase.replace(/_\d{2}-\d{2}-\d{2}$/, "");
  } else {
    sessionBases = sessionBasesOfFiles(files);
    sessionBase = sessionBases[0] ?? dateName;
  }
  const xmlFile = files.find((f) => f.endsWith(".xml"));
  return {
    dateName,
    sessionBase,
    sessionBases,
    plain: joinPath(stageSub, dateName + ".mp4"),
    danmuMp4: joinPath(stageSub, dateName + "_danmu.mp4"),
    livechatMp4: joinPath(stageSub, dateName + "_livechat.mp4"),
    plainXml: joinPath(stageSub, dateName + ".xml"),
    xmlArg: xmlFile ? joinPath(stageSub, xmlFile) : "",
  };
}

/** 把产物路径改到锁定的 stem(重跑时优先 ledger.outputStem,避免改模板后找不到已合成文件)。 */
export function withOutputStem(p: StageProducts, stem: string): StageProducts {
  const s = stem.trim();
  if (!s || s === p.dateName) return p;
  const dir = p.plain.slice(0, p.plain.lastIndexOf("/") + 1);
  return {
    ...p,
    dateName: s,
    plain: `${dir}${s}.mp4`,
    danmuMp4: `${dir}${s}_danmu.mp4`,
    livechatMp4: `${dir}${s}_livechat.mp4`,
    plainXml: `${dir}${s}.xml`,
  };
}

// ─── 分段产出(steps.mergeSegments=false):不合并,逐段产出 ─────────────────────

/** 一个录制分段(一个 .ts/.flv)在 stage 内的产出计划。 */
export interface SegmentPart {
  /** 全场段序号(0 基,跨会话连续),决定分 P 顺序与文件名。 */
  index: number;
  /** 原始源段序号(过滤碎片前);排序/窗口对齐用。 */
  srcSegIndex?: number;
  /** 该段时长(秒;反推场景为 0)。 */
  durSec?: number;
  /** 该段拉进 stage 的源(remux 输入)。 */
  src: string;
  /** 该段 remux 后的 plain mp4(stage 内)。 */
  plain: string;
  /** 该段所属会话的弹幕 xml(stage 内);该会话无 xml 则 ""。 */
  xmlPath: string;
  /** 该段在该会话 xml 时间轴上的窗口(秒);无 xml 则 null。 */
  window: { startSec: number; endSec: number } | null;
  /** 烧录产物;未烧(无 xml / 关烧录)则 ""。 */
  danmu: string;
  livechat: string;
}

/** 分段模式的产出计划(替代 StageProducts)。 */
export interface SegmentPlan {
  /** 全场 stem / 稿件标题(= P1 标题)。 */
  dateName: string;
  parts: SegmentPart[];
}

/**
 * **上传用**分 P 产物文件名 stem:`{dateName}_{NNN}`,`{NNN}` 补零 3 位(字典序 = 段序)。
 * 这是唯一会出现在 B站分 P 名里的格式;逐段 remux 的**中间产物**放在 `SEG_WORK_DIR`
 * 子目录里(命名随意),绝不外泄成上传名(`_segNNN` / `_gNNN` 均已废弃)。
 */
export function segmentStem(dateName: string, index: number): string {
  return `${dateName}_${String(index).padStart(3, "0")}`;
}

/**
 * 逐段 remux 中间产物的**工作子目录**(位于 stageSub 下)。放子目录是为了:
 * ① 内部命名(纯段号)不会与上传产物 `{dateName}_{NNN}.mp4` 撞名;
 * ② stage 根目录只留「待上传/已上传」的规范产物,目录一目了然。
 */
export const SEG_WORK_DIR = ".work";

/** 内部段文件路径:`<stageSub>/.work/<origIdx>.mp4`(origIdx = 源段在整场中的原始序号)。 */
export function segWorkPath(stageSub: string, origIdx: number): string {
  return `${stageSub}/${SEG_WORK_DIR}/${String(origIdx).padStart(3, "0")}.mp4`;
}

/** 规范上传产物名:`{dateName}_{NNN}[_danmu|_livechat].mp4`。 */
const UPLOAD_FILE_RE = /^(.*)_(\d{3})(?:_(danmu|livechat))?\.mp4$/;

/**
 * 从 stageSub 反推**已产出的分 P 产物**(续跑幂等用)。
 * 只认规范命名 `{dateName}_{NNN}[_danmu|_livechat].mp4`(即真正上传的那种);
 * 旧版内部名 `_segNNN` / `_gNNN` 一律忽略(不再产、也绝不当作上传产物)。
 * `allowedIndices` = 本次有效段号白名单(调用方按碎片阈值算好),防止把历史残留当分 P。
 */
export function deriveSegmentPlan(stageSub: string, allowedIndices?: ReadonlySet<number>): SegmentPlan | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const byIdx = new Map<number, { dateName: string; plain?: string; danmu?: string; livechat?: string }>();
  for (const f of files) {
    const m = UPLOAD_FILE_RE.exec(f);
    if (!m) continue;
    const [, dateName, num, kind] = m;
    const idx = Number(num);
    if (allowedIndices && !allowedIndices.has(idx)) continue;
    const e = byIdx.get(idx) ?? { dateName };
    if (kind === "danmu") e.danmu = joinPath(stageSub, f);
    else if (kind === "livechat") e.livechat = joinPath(stageSub, f);
    else e.plain = joinPath(stageSub, f);
    byIdx.set(idx, e);
  }
  if (byIdx.size === 0) return null;
  const parts: SegmentPart[] = [];
  for (const idx of [...byIdx.keys()].sort((a, b) => a - b)) {
    const e = byIdx.get(idx)!;
    if (!e.plain) continue; // 没有 plain 的不算(未产出完整)
    parts.push({
      index: idx,
      src: "",
      plain: e.plain,
      xmlPath: "",
      window: null,
      danmu: e.danmu ?? "",
      livechat: e.livechat ?? "",
    });
  }
  if (parts.length === 0) return null;
  return { dateName: byIdx.get(parts[0].index)!.dateName, parts };
}
