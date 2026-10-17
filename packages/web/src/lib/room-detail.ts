// lib/room-detail.ts — derived labels for the room detail page (pure, testable without a DOM).
import { burnFlags } from "@drec/rolling-policy";
import type { RoomDTO } from "../api/client";

/**
 * Which outputs a room delivers, as i18n keys. Burn flags use the core authority `burnFlags`
 * (default ON, independent of archive/upload — stage mode burns too). Without a danmu file there
 * is nothing to burn, matching the editor's reading (`danmu` off → burn off).
 */
export function versionKeys(room: Pick<RoomDTO, "processing" | "recording">): string[] {
  if (!room.processing) return ["room.editor.original"];
  const f = burnFlags(room.processing.pipeline?.steps);
  const canBurn = room.recording ? !!room.recording.danmu : true;
  return [
    "room.editor.original",
    ...(canBurn && f.burnDanmu ? ["room.editor.danmuVer"] : []),
    ...(canBurn && f.burnLivechat ? ["room.editor.livechatVer"] : []),
  ];
}
