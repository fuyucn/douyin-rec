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
