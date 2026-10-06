/**
 * hub 投稿标题 / stage 产物 stem 共用模板。
 * 渲染结果必须同时是合法文件名和 B 站标题,所以只允许字、数字、_-【】（）()。
 */
export const DEFAULT_TITLE_TEMPLATE = "{name}_{date}";
export const MAX_TITLE_LEN = 80;
export const TITLE_TOKENS = [
  "name", "user", "owner", "title",
  "part", "parts", "kind",
  "date", "time", "datetime",
  "yyyy", "YYYY", "year",
  "MM", "month",
  "dd", "day",
  "HH", "hh", "hour",
  "mm", "min",
  "ss", "sec",
  "HHmm", "HHmmss",
] as const;
export const DEFAULT_TITLE_TIMEZONE = "Asia/Shanghai";

const TOKEN_RE = /\{([A-Za-z]+)\}/g;
const STAMP_FULL = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})$/;
const STAMP_NO_SEC = /^(.+)_(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})$/;
const STAMP_DATE = /^(.+)_(\d{4}-\d{2}-\d{2})$/;
const SAFE_STEM = /^[\p{L}\p{N}_\-【】（）()]+$/u;

export interface TitleParts {
  name: string;
  date: string;
  hh: string;
  mm: string;
  ss: string;
  /** 本场直播标题(已按用途清洗);缺省 = 空串。`{title}` 取不到时渲染成空。 */
  liveTitle?: string;
  /** 分P序号(从 1 起)字符串;`{part}` 用。 */
  part?: string;
  /** 分P总数字符串;`{parts}` 用。 */
  parts?: string;
  /** 分P类型标签(plain / 弹幕 / 聊天 / 等);`{kind}` 用。 */
  kind?: string;
}

export interface TitleContext {
  sessionBase?: string;
  startMs?: number | null;
  timeZone?: string;
  /** 本场直播标题(平台 `PlatformStream.title`);从 `{base}.session.json` 读出。 */
  liveTitle?: string | null;
  /** 分P序号(从 1 起);`{part}` 用。无分P概念时省略 → 渲染成空。 */
  partIndex?: number | null;
  /** 分P总数;`{parts}` 用。 */
  partTotal?: number | null;
  /** 分P类型标签(plain / danmu / livechat);`{kind}` 用。 */
  kind?: string;
}

export function isSafeStem(s: string): boolean {
  return s.length > 0 && s.length <= MAX_TITLE_LEN && SAFE_STEM.test(s);
}

export function parseSessionStamp(sessionBase: string): (TitleParts & { hasTime: boolean }) | null {
  const full = STAMP_FULL.exec(sessionBase);
  if (full) return { name: full[1]!, date: full[2]!, hh: full[3]!, mm: full[4]!, ss: full[5]!, hasTime: true };
  const noSec = STAMP_NO_SEC.exec(sessionBase);
  if (noSec) return { name: noSec[1]!, date: noSec[2]!, hh: noSec[3]!, mm: noSec[4]!, ss: "00", hasTime: true };
  const dateOnly = STAMP_DATE.exec(sessionBase);
  if (dateOnly) return { name: dateOnly[1]!, date: dateOnly[2]!, hh: "00", mm: "00", ss: "00", hasTime: false };
  return null;
}

export function zonedStamp(ms: number, timeZone?: string): Omit<TitleParts, "name"> {
  let tz = (timeZone ?? "").trim() || DEFAULT_TITLE_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    tz = DEFAULT_TITLE_TIMEZONE;
  }
  const bag: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ms))) {
    if (part.type !== "literal") bag[part.type] = part.value;
  }
  return {
    date: `${bag.year}-${bag.month}-${bag.day}`,
    hh: bag.hour ?? "00",
    mm: bag.minute ?? "00",
    ss: bag.second ?? "00",
  };
}

export function resolveTitleParts(ctx: TitleContext): TitleParts {
  const parsed = ctx.sessionBase ? parseSessionStamp(ctx.sessionBase) : null;
  const zoned = ctx.startMs != null && ctx.startMs > 0 ? zonedStamp(ctx.startMs, ctx.timeZone) : null;
  if (parsed?.hasTime) {
    const { hasTime: _hasTime, ...parts } = parsed;
    return parts;
  }
  if (parsed && zoned) return { name: parsed.name, ...zoned };
  if (parsed) {
    const { hasTime: _hasTime, ...parts } = parsed;
    return parts;
  }
  if (zoned && ctx.sessionBase?.trim()) return { name: ctx.sessionBase.trim(), ...zoned };
  throw new Error("无法从会话名或开播时间渲染标题");
}

/** 渲染 `TitleContext` → `TitleParts`,并带上清洗后的直播标题(供 `{title}`)。 */
export function resolveTitlePartsWithLiveTitle(ctx: TitleContext): TitleParts {
  const part = ctx.partIndex != null && ctx.partIndex > 0 ? String(ctx.partIndex) : "";
  const parts = ctx.partTotal != null && ctx.partTotal > 0 ? String(ctx.partTotal) : "";
  return {
    ...resolveTitleParts(ctx),
    liveTitle: sanitizeLiveTitle(ctx.liveTitle),
    part,
    parts,
    kind: ctx.kind ?? "",
  };
}

export function applyTitleTemplate(template: string | null | undefined, parts: TitleParts): string {
  const t = (template ?? "").trim() || DEFAULT_TITLE_TEMPLATE;
  const [yyyy, month, day] = parts.date.split("-");
  const time = `${parts.hh}-${parts.mm}-${parts.ss}`;
  const map: Record<string, string> = {
    name: parts.name,
    user: parts.name,
    owner: parts.name,
    title: parts.liveTitle ?? "",
    part: parts.part ?? "",
    parts: parts.parts ?? "",
    kind: parts.kind ?? "",
    date: parts.date,
    time,
    datetime: `${parts.date}_${time}`,
    yyyy: yyyy ?? "",
    YYYY: yyyy ?? "",
    year: yyyy ?? "",
    MM: month ?? "",
    month: month ?? "",
    dd: day ?? "",
    day: day ?? "",
    HH: parts.hh,
    hh: parts.hh,
    hour: parts.hh,
    mm: parts.mm,
    min: parts.mm,
    ss: parts.ss,
    sec: parts.ss,
    HHmm: `${parts.hh}${parts.mm}`,
    HHmmss: `${parts.hh}${parts.mm}${parts.ss}`,
  };
  return t.replace(TOKEN_RE, (raw, key: string) => map[key] ?? raw);
}

/**
 * 直播标题 → 可用作文件名的一段文字。
 * 直播标题是主播自由输入,常含空格/标点/表情/斜杠,直接进文件名字面会非法或难读。
 * 这里做保守清洗:只保留文字/数字/少量符号,其余(空白、标点、emoji)换成 `-`,再折叠去重。
 * 清洗后为空 → 返回空串(调用方回落到默认命名,不产出 `_` 开头的空标题)。
 */
export function sanitizeLiveTitle(raw: string | null | undefined, maxLen = 40): string {
  const s = (raw ?? "").normalize("NFC").trim();
  if (!s) return "";
  const kept = s
    // 允许:中日韩文字、字母数字、下划线连字符、少量括注
    .replace(/[^\p{L}\p{N}_\-【】（）()]/gu, "-")
    // 折叠连续分隔符,去掉首尾
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  return kept.length > maxLen ? kept.slice(0, maxLen).replace(/-+$/, "") : kept;
}

/** 保存时校验模板(空 = 用默认)。返回错误文案,通过则 null。 */
export function validateTitleTemplate(template: string): string | null {
  const t = template.trim();
  if (!t) return null;
  const unknown: string[] = [];
  const stripped = t.replace(TOKEN_RE, (_, key: string) => {
    if (!(TITLE_TOKENS as readonly string[]).includes(key)) unknown.push(key);
    return "x";
  });
  if (unknown.length) {
    return `未知占位符: ${[...new Set(unknown)].map((k) => `{${k}}`).join(", ")}`;
  }
  if (/[{}]/.test(stripped)) return "标题模板含未闭合的大括号";
  if (!SAFE_STEM.test(stripped)) {
    return "标题模板含非法字符(仅允许字、数字、_-【】（）())";
  }
  return null;
}

export function formatUploadTitle(template: string | null | undefined, ctx: TitleContext): string {
  const rendered = applyTitleTemplate(template, resolveTitlePartsWithLiveTitle(ctx));
  if (!rendered) throw new Error("标题渲染结果为空");
  if (rendered.length > MAX_TITLE_LEN) {
    throw new Error(`标题超过 ${MAX_TITLE_LEN} 字: ${rendered} (${rendered.length})`);
  }
  if (!isSafeStem(rendered)) throw new Error(`标题含非法文件名字符: ${rendered}`);
  return rendered;
}

/**
 * 渲染 **B 站投稿标题**(与 stage 文件名分开)。
 *
 * 为什么要分两套:stage 文件名要跨 ffmpeg/rsync/文件系统,只能用严格字符集;而 B 站标题
 * 允许空格、标点、emoji,直接限制成同一套会让主播改的直播标题用不上。
 * 这里对 B 站侧放宽:只做长度截断(B 站上限 80),并把清洗后的直播标题填回去。
 */
export function formatBiliTitle(template: string | null | undefined, ctx: TitleContext): string {
  const parts = resolveTitlePartsWithLiveTitle(ctx);
  const rendered = applyTitleTemplate(template, parts);
  if (!rendered.trim()) throw new Error("标题渲染结果为空");
  if (rendered.length > MAX_TITLE_LEN) return rendered.slice(0, MAX_TITLE_LEN);
  return rendered;
}

/**
 * 渲染**分 P 的视频标题**(与稿件标题分开)。
 *
 * 背景:biliup 的 `upload` 里,稿件标题为空时取**第一个文件的 stem**,而每个分 P 的标题
 * 也来自**各自文件名的 stem** —— 文件名同时承担了两个职责。要让「稿件名」和「分 P 名」
 * 不同,就必须在调用 biliup 之前把文件重命名成想要的分 P 名(见 orchestrator 侧)。
 *
 * 这里只负责渲染出那个名字:宽松(B 站标题允许空格/标点),截断到 80 字。
 * 未配置 `partTitleTemplate` 时返回 null → 调用方回落到原文件名(行为不变)。
 */
export function formatPartTitle(
  template: string | null | undefined,
  ctx: TitleContext,
): string | null {
  const t = (template ?? "").trim();
  if (!t) return null;
  const rendered = applyTitleTemplate(t, resolveTitlePartsWithLiveTitle(ctx));
  if (!rendered.trim()) return null;
  return rendered.length > MAX_TITLE_LEN ? rendered.slice(0, MAX_TITLE_LEN) : rendered;
}

/**
 * 把分 P 标题安全地转成**文件名片段**(用于把 stage 产物改名后再交给 biliup)。
 *
 * 为什么需要:分 P 标题来自文件名 stem,所以想让分 P 显示成任意文本,就得先把文件
 * 改成那个名字。文件名不能含 `/` `\` `:` 等,故做与 `sanitizeLiveTitle` 同口径的清洗;
 * 清洗后为空 → 返回 null(调用方保持原文件名)。
 */
export function partTitleToFilename(title: string | null | undefined, maxLen = 60): string | null {
  const s = (title ?? "").normalize("NFC").trim();
  if (!s) return null;
  const kept = s
    .replace(/[^\p{L}\p{N}_\-【】（）()]/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .trim();
  if (!kept) return null;
  return kept.length > maxLen ? kept.slice(0, maxLen).replace(/-+$/, "") : kept;
}

/** 一场 job 的 stem:已落盘的优先,否则按模板渲染。 */
export function resolveOutputStem(opts: TitleContext & {
  template?: string | null;
  existingStem?: string | null;
}): string {
  const existing = opts.existingStem?.trim();
  if (existing) return existing;
  return formatUploadTitle(opts.template, opts);
}
