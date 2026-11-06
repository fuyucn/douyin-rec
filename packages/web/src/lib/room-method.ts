/**
 * room-method.ts — one truth for "how does this room deliver?" used by the rooms list + cards.
 *
 * Priority matches `uploadMethod`/`deliverText`: live upload > rolling > upload > archive. It is a
 * pure projection of the API DTO, so the list and the editor cannot disagree on the label/logo.
 */
import type { RoomDTO } from "../api/client";

export type RoomMethodKind = "live" | "rolling" | "upload" | "archive" | "none";

export function roomMethodKind(r: Pick<RoomDTO, "recording" | "processing">): RoomMethodKind {
  if (r.recording?.streamUpload === true) return "live";
  if (!r.processing) return "none";
  const mode = r.processing.pipeline?.upload?.mode;
  if (mode === "rolling") return "rolling";
  if (mode === "upload") return "upload";
  if (mode === "stage") return "archive";
  if (mode === undefined || mode === null) return "archive";
  return "none";
}
