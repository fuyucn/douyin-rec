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
 * 调用方据此决定是否渲染 tooltip。label 拿到 (当前生效时区名, 换算成本地时间的文案) 两段,同时
 * 交代"这是哪个时区"和"换算到我本地是几点"。
 */
export function localTimeTooltip(
  date: Date,
  serverTz: string,
  label: (serverTz: string, local: string) => string,
): string | undefined {
  const local = browserTimezone();
  if (!serverTz || !local || serverTz === local) return undefined;
  return label(serverTz, `${fmtDateTimeInTz(date, local)} · ${local}`);
}

/** tz 在 date 这一刻相对 UTC 的偏移(分钟,东正西负)。 */
function tzOffsetMinutes(date: Date, tz: string): number {
  const p = partsMap(date, tz, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return (asUtc - date.getTime()) / 60000;
}

/** minutes-from-midnight → { time: "HH:MM", dayDelta }(相对 day 0,跨天则 dayDelta ≠ 0)。 */
function toClock(totalMin: number): { time: string; dayDelta: number } {
  const dayDelta = Math.floor(totalMin / 1440);
  const wrapped = ((totalMin % 1440) + 1440) % 1440;
  return {
    time: `${String(Math.floor(wrapped / 60)).padStart(2, "0")}:${String(wrapped % 60).padStart(2, "0")}`,
    dayDelta,
  };
}

/**
 * 定时窗口("HH:MM"-"HH:MM",每日循环,end<start 视为跨夜次日)按浏览器本地时区换算的 hover 提示;
 * serverTz 与浏览器时区相同(或任一缺失)时返回 undefined。**关键**:跨夜的"+1 天"必须在换算时区
 * 之前先加到 end 上(以 server 时区的 day 0 为统一基准),否则 start/end 各自独立平移会把跨夜
 * 语义算错(例如 22:00-01:30 北京时间换算到落后 15 小时的时区,实际落在同一天 07:00-10:30,
 * 若不先处理跨夜就会错误地给 end 标上不存在的"-1d")。跨天用 (+1d)/(-1d) 标注。
 */
export function localScheduleTooltip(
  start: string,
  end: string,
  serverTz: string,
  label: (serverTz: string, localWindow: string) => string,
): string | undefined {
  const local = browserTimezone();
  if (!serverTz || !local || serverTz === local) return undefined;
  const now = new Date();
  const diff = tzOffsetMinutes(now, local) - tzOffsetMinutes(now, serverTz);
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const startServerMin = sh * 60 + sm;
  const endServerMin = eh * 60 + em + (eh * 60 + em <= startServerMin ? 1440 : 0);
  const fmtPart = (p: { time: string; dayDelta: number }): string =>
    p.dayDelta === 0 ? p.time : `${p.time}(${p.dayDelta > 0 ? "+" : ""}${p.dayDelta}d)`;
  const localWindow = `${fmtPart(toClock(startServerMin + diff))}-${fmtPart(toClock(endServerMin + diff))}`;
  return label(serverTz, `${localWindow} · ${local}`);
}
