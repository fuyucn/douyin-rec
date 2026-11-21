import { readFileSync, readdirSync, statSync, writeFileSync, renameSync } from "node:fs";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { linkOrCopy, partTitleToFilename, stageExt, stampedSessionBaseOf, STAGE_EXT_ALT, type StageFormat } from "@drec/core";

/** 该场 stage 合成产物的确定性路径(merge 后 / 续跑反推)。 */
export interface StageProducts {
  dateName: string;
  /**
   * B 站投稿标题(可含空格/标点/emoji)。与 `dateName` 分开:
   * `dateName` 是 stage 文件名 stem(严格字符集),本字段只用于投稿,可宽松。
   * 未配置含 `{title}` 的模板时两者相同。
   */
  uploadTitle?: string;
  /**
   * 各分 P 期望的**视频标题**(渲染后,宽松);缺省/undefined = 不改名,沿用原文件名 stem。
   *
   * 用途:biliup 分 P 标题取自文件名 stem,没有 CLI 参数单独指定 → 上传前把文件
   * 硬链接成该标题的名字(见 `prepareUploadAlias`)。原产物名从不移动,
   * 幂等推导与清理逻辑不受影响。
   */
  partTitles?: Partial<Record<"plain" | "danmu" | "livechat", string | null>>;
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

/** `主播名_2026-08-10_23-08-10` 的会话文件 → 会话 base;规则见 core `stampedSessionBaseOf`。 */
export function sessionBaseOfFile(name: string): string | undefined {
  return stampedSessionBaseOf(name);
}

/** 从文件名集合提取全部会话 base，排序并去重(同一场多分段只算一次)。 */
export function sessionBasesOfFiles(files: string[]): string[] {
  return [...new Set(files.map(sessionBaseOfFile).filter((s): s is string => Boolean(s)))].sort();
}

function joinPath(dir: string, name: string): string {
  // 与 pipeline 原实现一致:直接用 path 分隔符拼(避免在此 import node:path 也能跑浏览器构建无关)。
  return `${dir}/${name}`;
}

/** `{dateName}[_danmu|_livechat]{ext}` 三个视频产物路径(合并路径的确定命名,唯一出处)。 */
export function stageProductPaths(
  dir: string,
  dateName: string,
  fmt: StageFormat = "mp4",
): Pick<StageProducts, "plain" | "danmuMp4" | "livechatMp4"> {
  const ext = stageExt(fmt);
  return {
    plain: joinPath(dir, `${dateName}${ext}`),
    danmuMp4: joinPath(dir, `${dateName}_danmu${ext}`),
    livechatMp4: joinPath(dir, `${dateName}_livechat${ext}`),
  };
}

/**
 * 从 stageSub 目录按确定命名反推产物路径;连一个源文件都找不到 → null。
 * `fmt` = 该场后处理产物容器(core `effectiveStageFormat` 算出);缺省 mp4(现状)。
 * 字段名 `danmuMp4`/`livechatMp4` 是历史命名,实际扩展名随 `fmt`。
 */
export function deriveStageProducts(stageSub: string, fmt: StageFormat = "mp4"): StageProducts | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const ext = stageExt(fmt);
  const danmu = files.find((f) => f.endsWith(`_danmu${ext}`));
  const livechat = files.find((f) => f.endsWith(`_livechat${ext}`));
  const plainF = files.find((f) => f.endsWith(ext) && !f.endsWith(`_danmu${ext}`) && !f.endsWith(`_livechat${ext}`));
  let dateName: string | undefined;
  let sessionBase = "";
  let sessionBases: string[] = [];
  if (danmu) dateName = danmu.slice(0, -`_danmu${ext}`.length);
  else if (livechat) dateName = livechat.slice(0, -`_livechat${ext}`.length);
  else if (plainF) dateName = plainF.slice(0, -ext.length);
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
    ...stageProductPaths(stageSub, dateName, fmt),
    plainXml: joinPath(stageSub, dateName + ".xml"),
    xmlArg: xmlFile ? joinPath(stageSub, xmlFile) : "",
  };
}

/** 把产物路径改到锁定的 stem(重跑时优先 ledger.outputStem,避免改模板后找不到已合成文件)。 */
export function withOutputStem(p: StageProducts, stem: string): StageProducts {
  const s = stem.trim();
  if (!s || s === p.dateName) return p;
  const dir = p.plain.slice(0, p.plain.lastIndexOf("/") + 1);
  const ext = p.plain.slice(p.plain.lastIndexOf(".")); // 沿用传入产物的容器扩展名
  return {
    ...p,
    dateName: s,
    plain: `${dir}${s}${ext}`,
    danmuMp4: `${dir}${s}_danmu${ext}`,
    livechatMp4: `${dir}${s}_livechat${ext}`,
    plainXml: `${dir}${s}.xml`,
  };
}

/**
 * `.upload` 里的「别名 → 规范产物」清单(文件名就是清单自己的名字,放在别名目录里)。
 * 它是**恢复的唯一证据**:恢复只认清单命中 + 大小一致,绝不按文件名后缀猜类型。
 */
export const ALIAS_MAP_FILE = ".aliases.json";

/** 清单条目:alias 名 → 它指向的规范产物 basename / 当时大小 / 记录时间。 */
interface AliasEntry {
  src: string;
  size: number;
  at?: number;
}

const basenameOf = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

function readAliasMap(dir: string): Record<string, AliasEntry> {
  try {
    const v = JSON.parse(readFileSync(`${dir}/${ALIAS_MAP_FILE}`, "utf8")) as unknown;
    if (!v || typeof v !== "object") return {};
    const out: Record<string, AliasEntry> = {};
    for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
      const src = typeof (e as { src?: unknown })?.src === "string" ? (e as { src: string }).src : "";
      const size = Number((e as { size?: unknown })?.size);
      if (!k || !src || !Number.isFinite(size) || size < 0) continue;
      const at = Number((e as { at?: unknown })?.at);
      out[k] = { src, size, ...(Number.isFinite(at) && at > 0 ? { at } : {}) };
    }
    return out;
  } catch {
    return {}; // 没有清单 = 老目录 / 未配模板:恢复一律保守不猜
  }
}

function writeAliasMap(dir: string, map: Record<string, AliasEntry>): void {
  const tmp = `${dir}/.${ALIAS_MAP_FILE}.part`;
  writeFileSync(tmp, JSON.stringify(map));
  renameSync(tmp, `${dir}/${ALIAS_MAP_FILE}`); // 原子替换:读者永远看到完整清单
}

/**
 * 从 `.upload` 别名里找回**只剩别名的 stage 产物**(规范名被手删),返回恢复的规范路径。
 *
 * 为什么需要:上传别名是硬链接(`prepareUploadAlias`),删掉规范名**不会**释放空间、数据只剩
 * `.upload/<分P标题>.mp4` 持有;而续跑/补跑一律以 `existsSync(规范名)` 判产物在不在 →
 * 「数据还在、只是名字没了」被误判成「产物缺失」,白白转人工(2026-11-21 线上真实发生)。
 *
 * 规则(全部以清单为依据,认不准就不动):
 * ① 规范名存在 → 跳过(正常情况,零成本,不建任何东西);
 * ② 只认 `.upload/.aliases.json` 里 `src` 等于该产物 basename 的条目,且别名文件是**普通文件**、
 *    大小与记录一致 —— 只靠文件名后缀推断类型会把 plain 内容当成弹幕分P(模板正文含 `_danmu`、
 *    `partTitleToFilename` 去掉尾部标点都会撞名),所以类型启发式一律不用;
 * ③ 清单缺失 / 无命中 / 大小不符 / 多个候选 → 不恢复、不改判定(宁可转人工,不可错传);
 * ④ 恢复用**同目录 rename**(原子、零拷贝、不回落复制,也不会与 ffmpeg 的 `.X.part.mp4` 临时名撞);
 *    别名名字因此消失,后续上传前 `prepareUploadAlias` 会重新建。
 *
 * 为什么重新挂规范名、而不是把别名路径往下传:后续 append / 校验 / 清理 / 删源全按规范名工作,
 * 多一条「别名路径」通路会多一份判定(且 `clean_stage` 删的是规范名 → 别名会永久留下)。
 *
 * `stemHint`(`sync_jobs.outputStem`,台账锁定的产物名)只在**规范产物全丢**、`deriveStageProducts`
 * 推不出 dateName 时兜底 —— 至少给恢复一个确定的目标路径,而不是直接判「产物缺失」。
 *
 * @returns 已恢复的规范路径(空数组 = 什么都没动)
 */
export function repairStageProductsByAlias(
  stageSub: string,
  fmt: StageFormat = "mp4",
  log?: (msg: string) => void,
  opts?: { stemHint?: string | null },
): string[] {
  const prod = deriveStageProducts(stageSub, fmt);
  const hint = (opts?.stemHint ?? "").trim();
  const trio = (p: Pick<StageProducts, "plain" | "danmuMp4" | "livechatMp4">) => ({
    plain: p.plain,
    danmu: p.danmuMp4,
    livechat: p.livechatMp4,
  });
  const paths = prod ? trio(prod) : hint ? trio(stageProductPaths(stageSub, hint, fmt)) : null;
  if (!paths) return [];
  const targets = [paths.plain, paths.danmu, paths.livechat];
  const repaired: string[] = [];
  for (const path of targets) {
    if (restoreProductFromAlias(path, log)) repaired.push(path);
  }
  return repaired;
}

/**
 * 就**一个**规范产物做别名回找:缺失且清单里有唯一命中、大小一致 → 零拷贝挂回规范名。
 *
 * 只做清单命中:猜错的代价是把别的内容传成这个分 P,比转人工严重得多。
 *
 * @returns true = 刚刚恢复了(调用方应记一条日志/告警)
 */
export function restoreProductFromAlias(canonical: string, log?: (msg: string) => void): boolean {
  if (existsSync(canonical)) return false;
  const dir = `${dirnameOf(canonical)}/${UPLOAD_ALIAS_DIR}`;
  const src = basenameOf(canonical);
  const map = readAliasMap(dir);
  const hits = Object.entries(map).filter(([, e]) => e.src === src);
  if (hits.length === 0) return false; // 没有清单证据(未配模板 / 老目录)→ 不猜
  if (hits.length > 1) {
    log?.(`[alias] ${src} 缺失,但清单里有多条候选(${hits.map(([k]) => k).slice(0, 3).join(",")}),认不准,不恢复`);
    return false;
  }
  const [aliasName, entry] = hits[0]!;
  const aliasPath = `${dir}/${aliasName}`;
  try {
    const st = statSync(aliasPath);
    if (!st.isFile() || st.size !== entry.size) {
      log?.(`[alias] ${src} 缺失,别名 ${aliasName} 与清单记录不一致(大小 ${st.size}≠${entry.size}),不恢复`);
      return false;
    }
  } catch {
    return false; // 别名已被删/不可读:不再有第二份,保守转人工
  }
  try {
    renameSync(aliasPath, canonical); // 同目录原子 rename:零拷贝,不回落复制
  } catch {
    return false; // 恢复失败 → 保持原判定(不静默把「产物缺失」翻成「产物在」)
  }
  try {
    const m = readAliasMap(dir);
    delete m[aliasName]; // 清单里这条已消费(名字已变成规范名)
    writeAliasMap(dir, m);
  } catch { /* 清单清理失败只影响下一次恢复,不影响本次 */ }
  log?.(`[alias] 规范产物 ${src} 缺失,已从 ${UPLOAD_ALIAS_DIR}/${aliasName} 零拷贝恢复(内容与占位未变)`);
  return true;
}

/** 取路径所在目录(只用 `/` 分割:stage 路径内部一律 POSIX 风格,与 `joinPath` 一致)。 */
function dirnameOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
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

/** 上传别名集中放这里(stage 内子目录),收尾时整体删除。 */
export const UPLOAD_ALIAS_DIR = ".upload";

/**
 * 按期望的**分 P 标题**给产物建一个可上传的别名文件(硬链接),返回要传给 biliup 的路径。
 *
 * 为什么必须这样做:biliup 的分 P 标题取自**文件名 stem**(`uploader/line.rs`:title 为空时
 * 用 `file_stem()`),而 `upload`/`append` 都没有「指定分 P 标题」的 CLI 参数。所以要让分 P
 * 显示成自定义名字,唯一办法是给它一个文件名就是该标题的路径。
 *
 * 用**硬链接**:同盘零拷贝、不移动规范产物名 → `deriveStageProducts` 幂等推导、各类
 * stage 清理逻辑完全不受影响。硬链接不可用(跨设备)时回落复制。
 *
 * @returns 上传用路径;`desiredTitle` 为空/清洗后为空/构建失败 → 返回 `canonical`(不改名)。
 */
export function prepareUploadAlias(
  stageSub: string,
  kind: string,
  canonical: string,
  desiredTitle: string | null | undefined,
): string {
  if (!desiredTitle) return canonical;
  const stem = partTitleToFilename(desiredTitle);
  if (!stem) return canonical;
  const ext = canonical.slice(canonical.lastIndexOf("."));
  const dir = joinPath(stageSub, UPLOAD_ALIAS_DIR);
  const dst = joinPath(dir, `${stem}${ext}`);
  try {
    mkdirSync(dir, { recursive: true });
    // 续跑:上一次留下的别名先移除,保证指向最新产物(同名不同内容时不会串)。
    if (existsSync(dst)) rmSync(dst, { force: true });
    linkOrCopy(canonical, dst);
    // 记一份「别名 → 规范名」清单:恢复时只认清单命中,绝不靠文件名猜(见 restoreProductFromAlias)。
    try {
      const src = canonical.slice(canonical.lastIndexOf("/") + 1);
      const map = readAliasMap(dir);
      // 一个规范产物只留最新一条(换模板后旧别名不再当候选):名单恒 ≤1 条/source。
      for (const [k, e] of Object.entries(map)) if (e.src === src) delete map[k];
      map[dst.slice(dst.lastIndexOf("/") + 1)] = { src, size: statSync(canonical).size, at: Date.now() };
      writeAliasMap(dir, map);
    } catch { /* 清单只是恢复用的增强证据:写不了不影响上传(恢复会保守转人工) */ }
    return dst;
  } catch {
    return canonical; // 别名失败不影响上传(回落原名)
  }
}

/**
 * 逐段 remux 中间产物的**工作子目录**(位于 stageSub 下)。放子目录是为了:
 * ① 内部命名(纯段号)不会与上传产物 `{dateName}_{NNN}.mp4` 撞名;
 * ② stage 根目录只留「待上传/已上传」的规范产物,目录一目了然。
 */
export const SEG_WORK_DIR = ".work";

/** 内部段文件路径:`<stageSub>/.work/<origIdx>.<ext>`(origIdx = 源段在整场中的原始序号)。 */
export function segWorkPath(stageSub: string, origIdx: number, fmt: StageFormat = "mp4"): string {
  return `${stageSub}/${SEG_WORK_DIR}/${String(origIdx).padStart(3, "0")}${stageExt(fmt)}`;
}

/** 规范上传产物名:`{dateName}_{NNN}[_danmu|_livechat].{mp4|mkv}`(扩展名全集来自注册表)。 */
const UPLOAD_FILE_RE = new RegExp(`^(.*)_(\\d{3})(?:_(danmu|livechat))?\\.(${STAGE_EXT_ALT})$`);

/**
 * 从 stageSub 反推**已产出的分 P 产物**(续跑幂等用)。
 * 只认规范命名 `{dateName}_{NNN}[_danmu|_livechat].mp4`(即真正上传的那种);
 * 旧版内部名 `_segNNN` / `_gNNN` 一律忽略(不再产、也绝不当作上传产物)。
 * `allowedIndices` = 本次有效段号白名单(调用方按碎片阈值算好),防止把历史残留当分 P。
 */
export function deriveSegmentPlan(stageSub: string, allowedIndices?: ReadonlySet<number>, fmt: StageFormat = "mp4"): SegmentPlan | null {
  let files: string[];
  try { files = readdirSync(stageSub); } catch { return null; }
  const byIdx = new Map<number, { dateName: string; plain?: string; danmu?: string; livechat?: string }>();
  for (const f of files) {
    const m = UPLOAD_FILE_RE.exec(f);
    if (!m || `.${m[4]}` !== stageExt(fmt)) continue; // 只认本场生效容器(换格式后旧容器残留不当分 P)
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
