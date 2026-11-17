/** Literal, case-sensitive prefix matching; room slugs must not become SQL wildcards. */
export const HUB_ROOM_STREAM_PREDICATE = "substr(streamKey, 1, length(?)) = ? COLLATE BINARY";

/** Convert the first room-key separator only, preserving the literal slug. */
export function roomKeyToStreamPrefix(roomKey: string): string {
  return `${roomKey.replace(".", ":")}:`;
}
