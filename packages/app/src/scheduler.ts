/**
 * app/scheduler.ts — PURE schedule-window logic. No I/O, no clock, no recorders.
 *
 * Windows are LOCAL time, expressed as "HH:MM" strings. A null/empty start OR
 * end means "no schedule" → always eligible. Supports overnight windows where
 * the start time is later in the day than the end time (e.g. 22:30~01:00).
 *
 * Everything here is trivially unit-testable: pass minutes-since-midnight in,
 * get a boolean out.
 */

/** Parse "HH:MM" → minutes since midnight (0..1439). Throws on malformed input. */
function parseHHMM(s: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) throw new Error(`invalid HH:MM time: ${s}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) {
    throw new Error(`HH:MM out of range: ${s}`);
  }
  return h * 60 + min;
}

/**
 * Is `nowMinutes` (0..1439, minutes since local midnight) inside [start, end]?
 *
 * - start OR end null/empty → true (no schedule means always eligible).
 * - same-day window (startMin <= endMin): startMin <= now <= endMin.
 * - overnight window (startMin > endMin): now >= startMin || now <= endMin.
 *
 * Boundaries are inclusive on both ends.
 */
export function inWindow(
  nowMinutes: number,
  start: string | null,
  end: string | null,
): boolean {
  if (!start || !end) return true;
  const startMin = parseHHMM(start);
  const endMin = parseHHMM(end);
  if (startMin <= endMin) {
    return nowMinutes >= startMin && nowMinutes <= endMin;
  }
  // overnight: window wraps past midnight
  return nowMinutes >= startMin || nowMinutes <= endMin;
}

/** Minutes since local midnight for a Date (local time, 0..1439). */
export function nowMinutesLocal(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}
