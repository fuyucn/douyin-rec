/**
 * room-runs.ts — what the room's run list shows (issue #417), kept pure so vitest can pin it.
 *
 * The current run and the live-upload history are rows of the same list as the hub runs, so the list's
 * header count and its empty state are computed from the rows that are actually rendered — the list does
 * not predict them from task flags (that would be a second, drifting copy of the components' own rules).
 */

/** The list is empty only when nothing at all is listed: no hub run and no live row. */
export function showsRunsEmpty(o: { loaded: boolean; hubRuns: number; liveRows: number }): boolean {
  return o.loaded && o.hubRuns === 0 && o.liveRows === 0;
}

/** Header count: the hub total (not just the loaded page) plus the live rows above it. */
export function listedRunCount(o: { hubRuns: number; liveRows: number }): number {
  return o.hubRuns + o.liveRows;
}
