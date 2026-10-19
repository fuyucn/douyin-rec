/**
 * Resolve the room key used by the zero-disk pump.
 *
 * The pump passes this value straight to Platform.getStream. Platforms that need a numeric
 * room id (Douyin) reject a full live URL, so normalize at this boundary instead of relying
 * on every stream fetch implementation to accept both forms.
 */
import type { Platform } from "@drec/core";

export function zeroDiskRoom(platform: Platform, room: string): string {
  return platform.extractRoomSlug(platform.roomToUrl(room));
}
