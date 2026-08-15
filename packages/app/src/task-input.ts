/**
 * task-input.ts — 任务表单/CLI 共用的输入解析。
 *
 * web api 与 cli-task 之前各写一份 schedule/danmu/flag 解析，此处收口成单点，
 * 保证 Web 表单和命令行对同一输入得到同一语义。
 */

/** "HH:MM-HH:MM" → [start, end]; throws on malformed/empty. */
export function parseSchedule(s: string): [string, string] {
  const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`schedule 格式应为 HH:MM-HH:MM，收到: ${s}`);
  return [m[1], m[2]];
}

const FALSE_FLAGS = new Set(["0", "off", "false", "no", "none"]);

/** Parse a 0/1/on/off/true/false flag string → boolean. Defaults to `def`. */
export function parseBoolFlag(v: string | undefined, def: boolean): boolean {
  if (v === undefined) return def;
  return !FALSE_FLAGS.has(v.trim().toLowerCase());
}

/** Normalise a danmu value (number|boolean|string) to 0/1; defaults to 1. */
export function toDanmuFlag(v: number | boolean | string | undefined): number {
  if (v === undefined) return 1;
  if (typeof v === "string") return parseBoolFlag(v, true) ? 1 : 0;
  return v ? 1 : 0;
}
