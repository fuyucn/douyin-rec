/**
 * live-notify.ts — who owns the 开播/收播 notification for a task (issue #403).
 *
 * Two paths never send it themselves: the live-direct pump (it never creates a recording
 * session) and any task whose recorder runs on a worker (the child is not on the master).
 * The master's watcher covers exactly those, and stays silent for local file recording so the
 * child's own notification is not duplicated.
 */

/** Is this room live right now, counting the hub's worker probes? */
export function roomIsLive(localRecording: boolean, workerStates: ReadonlyArray<{ state: string }>): boolean {
  return localRecording || workerStates.some((w) => w.state === "recording");
}

/** Should the master send the notification itself instead of leaving it to the recording child? */
export function masterNotifiesLive(localRecording: boolean, streamUpload: boolean): boolean {
  // Local file recording: the child already sends it.
  if (localRecording && !streamUpload) return false;
  return true;
}

/** What the watcher remembered about the previous tick. */
export interface LiveTick { live: boolean; local: boolean; streamUpload: boolean }

/**
 * Should the master send the notification for the transition we just observed?
 *
 * Ownership is decided from the session that is ENDING, not from the current tick: a local file
 * recorder clears its "recording" flag before the process exits, so by the time the watcher sees
 * the end, `local` is already false and the child's own notification would be duplicated.
 */
export function masterSendsTransition(prev: LiveTick, next: LiveTick): boolean {
  const session = next.live ? next : prev;
  return masterNotifiesLive(session.local, session.streamUpload);
}

/** A worker probe that could not answer must not be read as "not recording". */
export function workerProbeUsable(states: ReadonlyArray<{ state: string }>): boolean {
  return states.length === 0 || !states.some((w) => w.state === "unavailable");
}
