// lib/room-detail.ts — derived labels for the room detail page (pure, testable without a DOM).
import type { RoomDTO } from "../api/client";

/**
 * Which outputs a room delivers, as i18n keys. Burned versions only exist when the room uploads,
 * and burn flags default ON when unset (same reading as the editor and the backend).
 */
export function versionKeys(proc: RoomDTO["processing"]): string[] {
  const mode = proc?.pipeline?.upload?.mode;
  const uploading = mode === "upload" || mode === "rolling";
  const steps = proc?.pipeline?.steps;
  return [
    "room.editor.original",
    ...(uploading && steps?.burnDanmu !== false ? ["room.editor.danmuVer"] : []),
    ...(uploading && steps?.burnLivechat !== false ? ["room.editor.livechatVer"] : []),
  ];
}
