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
import { pipelineBurns } from "@drec/rolling-policy";
import { roomMethodKind } from "./room-method";

export type RoomIndicatorId = "danmu" | "delivery" | "upload";
export type RoomIndicatorKind = ModeLogoKind;

export interface RoomIndicator {
  /** Stable key for React and for the one-at-a-time explanation popover. */
  id: RoomIndicatorId;
  kind: RoomIndicatorKind;
  /** i18n key; this module stays pure and never emits translated text. */
  labelKey: string;
  /**
   * Short visible word for the delivery mark. Icon-only marks in the Upload column were unreadable
   * (three glyphs, no legend), so the mode carries one word and the other two marks stay glyphs.
   */
  shortLabelKey?: string;
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
  const privacyDetailKeys = room.processing?.pipeline?.upload
    ? [room.processing.pipeline.upload.private === false ? "room.publicShort" : "room.privateShort"]
    : [];
  const pausedKeys = (): string[] =>
    [...new Set([...(recordingPaused ? ["room.pausedRule"] : []), ...(processingPaused ? ["room.pausedRule"] : [])])];
  const uploadEnabled = !processingPaused && (method === "live" || method === "rolling" || method === "upload");
  const addUpload = (): void => {
    if (!uploadEnabled) return;
    out.push({
      id: "upload",
      kind: "bilibili",
      labelKey: "room.uploadMode",
      detailKeys: [...privacyDetailKeys, ...pausedKeys()],
    });
  };

  if (method === "live") {
    out.push({
      id: "delivery",
      kind: "zero-disk",
      labelKey: "room.methodLiveStream",
      shortLabelKey: "room.mark.live",
      detailKeys: ["room.editor.zeroDiskSpool", ...pausedKeys()],
    });
    addUpload();
  } else if (method === "rolling") {
    out.push({
      id: "delivery",
      kind: "segment",
      labelKey: "room.methodRolling",
      shortLabelKey: "room.mark.rolling",
      detailKeys: [...privacyDetailKeys, ...pausedKeys()],
    });
    addUpload();
  } else if (method === "upload") {
    const steps = room.processing?.pipeline?.steps;
    const nodeRoute = steps?.nodeSideUpload === true && !pipelineBurns(steps);
    out.push({
      id: "delivery",
      kind: nodeRoute ? "node" : steps?.mergeSegments === false ? "split" : "merge",
      labelKey: nodeRoute ? "room.editor.timingNode" : "room.methodUpload",
      shortLabelKey: nodeRoute ? "room.mark.node" : steps?.mergeSegments === false ? "room.mark.split" : "room.mark.upload",
      detailKeys: [...privacyDetailKeys, ...pausedKeys(),
        ...(nodeRoute ? ["room.editor.timingNodeHint", steps?.mergeSegments === false ? "room.editor.timingNodeSplitHint" : "room.editor.timingNodeMergeHint"] : steps?.mergeSegments === false ? ["roomForm.mergeSplitHint"] : ["roomForm.mergeOneHint"])],
    });
    addUpload();
  } else if (method === "archive") {
    out.push({
      id: "delivery",
      kind: "archive",
      labelKey: "room.archiveMode",
      shortLabelKey: "room.mark.archive",
      detailKeys: processingPaused ? ["room.pausedRule"] : undefined,
    });
  }

  return out;
}
