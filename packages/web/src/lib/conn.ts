import type { ConnState } from "../atoms";

/** Header state from the two list fetches: OK only when neither last result failed; time = latest of them. */
export function connOf(rooms: ConnState, tasks: ConnState): ConnState {
  const seen = [rooms, tasks].filter((c): c is NonNullable<ConnState> => c !== null);
  if (seen.length === 0) return null;
  const failed = seen.filter((c) => !c.ok);
  if (failed.length > 0) return { ok: false, at: Math.max(...failed.map((c) => c.at)) };
  return { ok: true, at: Math.max(...seen.map((c) => c.at)) };
}
