import { noteRecorderProgress } from "@drec/core";

/** Resolve early when any signal aborts, including while an injected sleep is pending. */
export async function sleepUnlessAborted(
  ms: number,
  signals: Array<AbortSignal | undefined>,
  sleepImpl?: (ms: number) => Promise<void>,
): Promise<void> {
  // Bounded polling/backoff is progress, not a finalizing stall; the 24h backstop still applies.
  noteRecorderProgress();
  const live = signals.filter((x): x is AbortSignal => !!x);
  if (live.some((x) => x.aborted)) return;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    for (const sig of live) sig.addEventListener("abort", onAbort, { once: true });
  });
  const slept = sleepImpl
    ? sleepImpl(ms)
    : new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([slept, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const sig of live) sig.removeEventListener("abort", onAbort);
  }
}
