import { statSync } from "node:fs";

/** 字节 → 人类可读("90MB" / "1.5KB" / "2GB")。1 位小数,整数省略小数。 */
export function humanBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const s = v >= 10 || Number.isInteger(v) ? String(Math.round(v)) : v.toFixed(1);
  return `${s}${units[i]}`;
}

/** 秒 → 人类可读("1h38m" / "10m" / "45s")。 */
export function humanDur(sec: number): string {
  if (!Number.isFinite(sec) || sec < 60) return `${Math.max(0, Math.round(sec))}s`;
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

/** 一组文件字节和(best-effort:stat 失败的跳过;全失败返 0)。 */
export function sumBytes(paths: string[]): number {
  let total = 0;
  for (const p of paths) {
    try { total += Number(statSync(p).size); } catch { /* 拿不到就跳过 */ }
  }
  return total;
}
