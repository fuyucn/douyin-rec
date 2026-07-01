/**
 * tz.ts — 时间显示统一按后端 `settings.timezone`(effective,见 GET /api/timezone)为主口径,
 * 与 daemon 实际判定排期窗口的时区口径一致;浏览器本地时区仅在 hover tooltip 里作为换算辅助,
 * 且**只在两者不同时才显示** tooltip(相同时没必要,避免噪音)。
 */

function partsMap(date: Date, tz: string, opts: Intl.DateTimeFormatOptions): Record<string, string> {
  const dtf = new Intl.DateTimeFormat("en-US", tz ? { ...opts, timeZone: tz } : opts);
  const out: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) out[p.type] = p.value;
  return out;
}

/** 浏览器解析到的本地 IANA 时区名,取不到返回空串。 */
export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  } catch {
    return "";
  }
}

/** "HH:MM",tz 为空则用浏览器本地时区。 */
export function fmtTimeInTz(date: Date, tz: string): string {
  const p = partsMap(date, tz, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.hour}:${p.minute}`;
}

/** "YYYY-MM-DD HH:MM:SS",tz 为空则用浏览器本地时区。 */
export function fmtDateTimeInTz(date: Date, tz: string): string {
  const p = partsMap(date, tz, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

/**
 * 本地时间换算的 hover tooltip 文案;serverTz 与浏览器时区相同(或任一取不到)时返回 undefined,
 * 调用方据此决定是否渲染 `title` 属性。
 */
export function localTimeTooltip(
  date: Date,
  serverTz: string,
  label: (local: string) => string,
): string | undefined {
  const local = browserTimezone();
  if (!serverTz || !local || serverTz === local) return undefined;
  return label(`${fmtDateTimeInTz(date, local)} · ${local}`);
}
