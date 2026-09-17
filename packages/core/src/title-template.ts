/**
 * hub 投稿标题 / stage 产物 stem 共用模板。
 * 渲染结果必须同时是合法文件名和 B 站标题,所以只允许字、数字、_-【】（）()。
 */
export const DEFAULT_TITLE_TEMPLATE = "{name}_{date}";
export const MAX_TITLE_LEN = 80;
export const TITLE_TOKENS = [
  "name", "user", "owner",
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
}

export interface TitleContext {
  sessionBase?: string;
  startMs?: number | null;
  timeZone?: string;
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

export function applyTitleTemplate(template: string | null | undefined, parts: TitleParts): string {
  const t = (template ?? "").trim() || DEFAULT_TITLE_TEMPLATE;
  const [yyyy, month, day] = parts.date.split("-");
  const time = `${parts.hh}-${parts.mm}-${parts.ss}`;
  const map: Record<string, string> = {
    name: parts.name,
    user: parts.name,
    owner: parts.name,
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
  const rendered = applyTitleTemplate(template, resolveTitleParts(ctx));
  if (!rendered) throw new Error("标题渲染结果为空");
  if (rendered.length > MAX_TITLE_LEN) {
    throw new Error(`标题超过 ${MAX_TITLE_LEN} 字: ${rendered} (${rendered.length})`);
  }
  if (!isSafeStem(rendered)) throw new Error(`标题含非法文件名字符: ${rendered}`);
  return rendered;
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
