/**
 * Resolve the room key used by the zero-disk pump.
 *
 * The pump passes this value straight to Platform.getStream. Platforms that need a numeric
 * room id (Douyin) reject a full live URL, so normalize at this boundary instead of relying
 * on every stream fetch implementation to accept both forms.
 */
import { join } from "node:path";
import { processTimeZone, zonedStamp, type Platform } from "@drec/core";

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
export function zeroDiskXmlPath(outDir: string, roomSlug: string, startMs: number, timeZone: string = processTimeZone()): string {
  const z = zonedStamp(startMs, timeZone);
  return join(outDir, `live-pump-${roomSlug}_${z.date}_${z.hh}-${z.mm}-${z.ss}.xml`);
}
