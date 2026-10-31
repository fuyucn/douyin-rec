/**
 * room-runs.ts — what the room's run list shows (issue #417), kept pure so vitest can pin it.
 *
 * The current run is a row of the same list as the hub runs, so the list's count and its empty
 * state must account for it: a room that is on air is not "no processing runs".
 */

/** A live-upload / rolling room has a current row when it is upload-enabled and a node reports it. */
export function hasCurrentRun(o: { streamUpload: boolean; liveNodes: number; rolling: number }): boolean {
  return o.streamUpload && (o.liveNodes > 0 || o.rolling > 0);
}

/** The list is empty only when nothing at all is listed: no hub run and no current run. */
export function showsRunsEmpty(o: { loaded: boolean; hubRuns: number; hasCurrent: boolean }): boolean {
  return o.loaded && o.hubRuns === 0 && !o.hasCurrent;
}

/** Count shown in the list header: the rows currently listed (hub rows + the current run). */
export function listedRunCount(o: { hubRuns: number; hasCurrent: boolean }): number {
  return o.hubRuns + (o.hasCurrent ? 1 : 0);
}
