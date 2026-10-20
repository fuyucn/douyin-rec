/**
 * Single source of truth for "is this the same broadcast?" (issues #148 / #292).
 *
 * Business rule: two adjacent sessions of one room whose gap is <= 60 minutes are one broadcast (the
 * recorder reconnected); a gap > 60 minutes is a new broadcast. Every clustering / reconnect-wait caller
 * must use this constant instead of a private tolerance.
 */
export const SAME_BROADCAST_GAP_MS = 60 * 60_000;

/** True when `gapMs` (next start minus previous end; may be negative for overlaps) still means the same broadcast. */
export function isSameBroadcastGap(gapMs: number, toleranceMs: number = SAME_BROADCAST_GAP_MS): boolean {
  return gapMs <= toleranceMs;
}

/**
 * Effective reconnect window / clustering tolerance: `max(configured, SAME_BROADCAST_GAP_MS)`, so a stale
 * lower config value (e.g. the old 10-minute template default) cannot override the 60-minute rule.
 * `undefined` falls back to the constant; a value <= 0 is an explicit "disabled" and passes through unchanged.
 * `clamped` tells the caller the configured value was raised, so it can log once instead of clamping silently.
 */
export function effectiveReconnectWindowMs(configured: number | undefined): { ms: number; clamped: boolean } {
  if (configured == null || !Number.isFinite(configured)) return { ms: SAME_BROADCAST_GAP_MS, clamped: false };
  if (configured <= 0) return { ms: configured, clamped: false };
  if (configured < SAME_BROADCAST_GAP_MS) return { ms: SAME_BROADCAST_GAP_MS, clamped: true };
  return { ms: configured, clamped: false };
}
