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
