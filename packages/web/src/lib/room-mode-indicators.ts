/**
 * room-mode-indicators.ts — pure projection of a room's facts into the compact room-list marks.
 *
 * The list shows icons without visible labels, so every mark must come from an authoritative DTO
 * field. Danmu capture is `recording.danmu > 0` (never inferred from burn settings). Delivery uses
 * `roomMethodKind`, the same priority the rest of the room UI uses. Unknown or absent delivery
 * configuration gets no mark: there is no honest icon for "not configured".
 */
import type { RoomDTO } from "../api/client";
import type { ModeLogoKind } from "../components/ModeLogo";
import { roomMethodKind } from "./room-method";

export type RoomIndicatorId = "danmu" | "delivery" | "upload";
export type RoomIndicatorKind = ModeLogoKind | "danmu";

export interface RoomIndicator {
  /** Stable key for React and for the one-at-a-time explanation popover. */
  id: RoomIndicatorId;
  kind: RoomIndicatorKind;
  /** i18n key; this module stays pure and never emits translated text. */
  labelKey: string;
  /** Extra existing i18n keys composed into the explanation (privacy, spool, paused). */
  detailKeys?: string[];
}

export type RoomIndicatorSource = Pick<RoomDTO, "recording" | "processing">;

export function roomModeIndicators(room: RoomIndicatorSource): RoomIndicator[] {
  const out: RoomIndicator[] = [];
  const recordingPaused = room.recording?.enabled === false;
  const processingPaused = room.processing?.enabled === false;

  if ((room.recording?.danmu ?? 0) > 0) {
    out.push({
      id: "danmu",
      kind: "danmu",
      labelKey: "rooms.danmu",
      detailKeys: recordingPaused ? ["room.pausedRule"] : undefined,
    });
  }

  const method = roomMethodKind(room);
  const privacy = room.processing?.pipeline?.upload
    ? [room.processing.pipeline.upload.private === false ? "room.publicShort" : "room.privateShort"]
    : [];
  const spool = room.recording?.streamUploadSpool !== false ? "room.editor.zeroDiskSpool" : "room.editor.zeroDisk";
  const uploadReady = (() => {
    if (processingPaused) return false;
    if (room.recording?.streamUpload === true) return !recordingPaused;
    const mode = room.processing?.pipeline?.upload?.mode;
    return mode === "rolling" || mode === "upload";
  })();
  const addUpload = (): void => {
    if (!uploadReady) return;
    out.push({
      id: "upload",
      kind: "bilibili",
      labelKey: "room.uploadMode",
      detailKeys: privacy.length > 0 ? privacy : undefined,
    });
  };

  if (method === "live") {
    out.push({
      id: "delivery",
      kind: "zero-disk",
      labelKey: "room.methodLiveStream",
      detailKeys: [spool, ...(recordingPaused || processingPaused ? ["room.pausedRule"] : [])],
    });
    addUpload();
  } else if (method === "rolling") {
    out.push({
      id: "delivery",
      kind: "segment",
      labelKey: "room.methodRolling",
      detailKeys: [...privacy, ...(processingPaused ? ["room.pausedRule"] : [])],
    });
    addUpload();
  } else if (method === "upload") {
    addUpload();
  } else if (method === "archive") {
    out.push({
      id: "delivery",
      kind: "archive",
      labelKey: "room.archiveMode",
      detailKeys: processingPaused ? ["room.pausedRule"] : undefined,
    });
  }

  return out;
}
