import { EndDebouncer } from "./trigger.js";

export interface HubDeps {
  tasks: () => { id: number }[];
  isRecording: (id: number) => boolean;
  reconcileAll: () => Promise<void>;
  settleMs: number;
  pollMs: number;
  reconcileIntervalMs: number;
}

/**
 * startHub — pure-wiring function that polls isRecording for each task and
 * triggers reconcileAll after settle period once recording stops.
 * Also fires reconcileAll periodically as a safety-net.
 * Returns a cleanup function that clears both intervals.
 */
export function startHub(deps: HubDeps): () => void {
  const debouncers = new Map<number, EndDebouncer>();

  const pollInterval = setInterval(() => {
    for (const t of deps.tasks()) {
      let d = debouncers.get(t.id);
      if (!d) {
        d = new EndDebouncer(deps.settleMs, () => void deps.reconcileAll());
        debouncers.set(t.id, d);
      }
      d.observe(deps.isRecording(t.id));
    }
  }, deps.pollMs);

  const reconcileInterval = setInterval(() => {
    void deps.reconcileAll();
  }, deps.reconcileIntervalMs);

  return () => {
    clearInterval(pollInterval);
    clearInterval(reconcileInterval);
  };
}
