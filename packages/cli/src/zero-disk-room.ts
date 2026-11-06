import { join } from "node:path";
import { processTimeZone, sanitizePathSegment, zonedStamp } from "@drec/core";

// zeroDiskRoom lives in @drec/app (shared with the serve-side live gate); re-exported for the cli.
export { zeroDiskRoom } from "@drec/app";

/**
 * Danmu xml path for one zero-disk run (issue #329).
 *
 * The xml is the only artifact the zero-disk path writes to disk, so every run gets its own
 * file stamped with the danmu start time. A room-only name was reused by every restart and
 * the writer's open() truncated the previous broadcast's danmu.
 */
export function zeroDiskXmlPath(
  outDir: string,
  roomSlug: string,
  startMs: number,
  timeZone: string = processTimeZone(),
  anchorName?: string | null,
): string {
  const z = zonedStamp(startMs, timeZone);
  // Issue #360: the xml lives in the room directory and carries the anchor name, like the spool.
  // Without an anchor (legacy layout / unresolved name) the room slug keeps the old behaviour.
  // Legacy layout passes no anchor: keep the historical raw room slug byte-for-byte.
  // Cap the anchor like the spool name does: NAME_MAX is 255 bytes and the suffix adds ~30.
  const head = anchorName?.trim()
    ? (sanitizePathSegment(anchorName.trim()).slice(0, 60) || roomSlug)
    : roomSlug;
  return join(outDir, `${head}_${z.date}_${z.hh}-${z.mm}-${z.ss}.live.xml`);
}

/** New live-upload spool naming: time-first, with a `.live` suffix before the media extension. */
export function zeroDiskSpoolName(
  head: string,
  startMs: number,
  seg: number,
  timeZone: string = processTimeZone(),
  collision = 0,
): string {
  const z = zonedStamp(startMs, timeZone);
  const safeHead = sanitizePathSegment(head).slice(0, 60) || "room";
  const suffix = collision > 0 ? `-${collision}` : "";
  return `${safeHead}_${z.date}_${z.hh}-${z.mm}-${z.ss}_${String(seg).padStart(3, "0")}${suffix}.live.ts`;
}
