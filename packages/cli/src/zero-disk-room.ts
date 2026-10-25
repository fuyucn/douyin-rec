/**
 * Resolve the room key used by the zero-disk pump.
 *
 * The pump passes this value straight to Platform.getStream. Platforms that need a numeric
 * room id (Douyin) reject a full live URL, so normalize at this boundary instead of relying
 * on every stream fetch implementation to accept both forms.
 */
import { join } from "node:path";
import { processTimeZone, sanitizePathSegment, zonedStamp, type Platform } from "@drec/core";

export function zeroDiskRoom(platform: Platform, room: string): string {
  return platform.extractRoomSlug(platform.roomToUrl(room));
}

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
  return join(outDir, `live-pump-${head}_${z.date}_${z.hh}-${z.mm}-${z.ss}.xml`);
}
