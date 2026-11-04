import { api } from "../api/client";

/**
 * Non-blocking 合集 ID hint after a successful save (issue #460).
 *
 * Resolves the season with the MASTER's account and shows the season/section title as a toast;
 * when the master's account does not own it, the backend returns the fallback line and the
 * recording node resolves it with its own account instead. Never blocks the save, never writes
 * anything, and a request failure is silently ignored (it is a hint, not a gate).
 */
export function hintSeasonAfterSave(
  rawSeasonId: string,
  toast: (message: string) => void,
  prefix: string,
): void {
  const trimmed = rawSeasonId.trim();
  const seasonId = Number(trimmed);
  if (!trimmed || !Number.isSafeInteger(seasonId) || seasonId <= 0) return;
  void api
    .seasonHint(seasonId)
    .then((r) => toast(prefix + r.title))
    .catch(() => { /* hint only: a failed lookup must never surface as an error */ });
}
