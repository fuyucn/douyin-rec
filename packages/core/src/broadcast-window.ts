/**
 * Single source of truth for "is this the same broadcast?" (issues #148 / #292).
 *
 * Business rule: two adjacent sessions of one room whose gap is <= 30 minutes are one broadcast (the
 * recorder reconnected); a gap > 30 minutes is a new broadcast. Every clustering / reconnect-wait caller
 * must use this constant instead of a private tolerance.
 */
export const SAME_BROADCAST_GAP_MS = 30 * 60_000;

/** True when `gapMs` (next start minus previous end; may be negative for overlaps) still means the same broadcast. */
export function isSameBroadcastGap(gapMs: number, toleranceMs: number = SAME_BROADCAST_GAP_MS): boolean {
  return gapMs <= toleranceMs;
}

/**
 * Issue #320: same-broadcast decision with the platform's live id. When both sessions carry an id
 * (`PlatformStream.liveSessionId`, recorded in the session sidecar), the ids decide alone: a reconnect within
 * 30 minutes into a different live id is a new broadcast, and a long recorder gap inside one live id is still
 * the same broadcast. Without an id on either side (old recordings, platforms without one) the gap rule applies.
 */
export function isSameBroadcast(o: {
  aLiveId?: string | null;
  bLiveId?: string | null;
  gapMs: number;
  toleranceMs?: number;
}): boolean {
  if (o.aLiveId && o.bLiveId) return o.aLiveId === o.bLiveId;
  return isSameBroadcastGap(o.gapMs, o.toleranceMs);
}

/**
 * Effective reconnect wait window (clustering always uses the constant): `max(configured, SAME_BROADCAST_GAP_MS)`, so a stale
 * lower config value (e.g. the old 10-minute template default) cannot override the 30-minute rule.
 * `undefined` falls back to the constant; a value <= 0 is an explicit "disabled" and passes through unchanged.
 * `clamped` tells the caller the configured value was raised, so it can log once instead of clamping silently.
 */
export function effectiveReconnectWindowMs(configured: number | undefined): { ms: number; clamped: boolean } {
  if (configured == null || !Number.isFinite(configured)) return { ms: SAME_BROADCAST_GAP_MS, clamped: false };
  if (configured <= 0) return { ms: configured, clamped: false };
  if (configured < SAME_BROADCAST_GAP_MS) return { ms: SAME_BROADCAST_GAP_MS, clamped: true };
  return { ms: configured, clamped: false };
}
