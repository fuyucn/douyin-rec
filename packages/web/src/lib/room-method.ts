/**
 * room-method.ts — one truth for "how does this room deliver?" used by the rooms list + cards.
 *
 * Priority matches `uploadMethod`/`deliverText`: live upload > rolling > after-close upload >
 * archive. It is a pure projection of the API DTO, so the list and the editor cannot disagree on
 * the label/logo.
 */
import type { RoomDTO } from "../api/client";
import { normalizeUploadMode } from "@drec/rolling-policy";

export type RoomMethodKind = "live" | "rolling" | "upload" | "archive" | "none";

/**
 * Priority: live upload > rolling > after-close upload > archive > none. `rollingEffective` is the
 * master-computed truth for legacy rolling: an unconfigured mode (missing/null/empty per core
 * `normalizeUploadMode`) or an upload mode or a missing rule keeps rolling, while an explicit
 * stage or unknown mode in the rule always wins over a stale effective field. Core folds unknown
 * future strings into "stage", so this projection compares the raw configured value: only the
 * literal stage is archive, and a future mode receives no guessed mark.
 */
export function roomMethodKind(r: Pick<RoomDTO, "recording" | "processing">): RoomMethodKind {
  if (r.recording?.streamUpload === true) return "live";
  const raw = r.processing?.pipeline?.upload?.mode;
  const configured = raw == null ? "" : String(raw).trim();
  if (configured === "") return r.recording?.rollingEffective === true ? "rolling" : r.processing ? "archive" : "none";
  const mode = normalizeUploadMode(raw);
  if (mode === "upload") return r.recording?.rollingEffective === true ? "rolling" : "upload";
  if (mode === "rolling") return "rolling";
  if (mode === "stage") return configured === "stage" ? "archive" : "none";
  return "none";
}
