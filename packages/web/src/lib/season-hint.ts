import { api } from "../api/client";

/**
 * Non-blocking 合集 ID hint after a successful save (issue #460).
 *
 * Only fires when the saved 合集 ID actually CHANGED: an unchanged value was already resolved (and
 * possibly rejected) before, so re-asking would be a pointless request on every save.
 *
 * Resolves the season with the MASTER's account and shows the season/section title as a toast; when
 * the master's account cannot see it, the backend returns a fallback line and the recording node
 * resolves it with its own account instead. Never blocks the save, never writes anything, and a
 * request failure is silently ignored (it is a hint, not a gate).
 */
export function hintSeasonAfterSave(
  rawSeasonId: string,
  previousSeasonId: number | null | undefined,
  toast: (message: string) => void,
  prefix: string,
): void {
  const trimmed = rawSeasonId.trim();
  const seasonId = Number(trimmed);
  if (!trimmed || !Number.isSafeInteger(seasonId) || seasonId <= 0) return;
  if (previousSeasonId === seasonId) return;
  void api
    .seasonHint(seasonId)
    .then((r) => toast(prefix + r.title))
    .catch(() => { /* hint only: a failed lookup must never surface as an error */ });
}
