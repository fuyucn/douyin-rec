// lib/room-create.ts — duplicate detection around `POST /api/rooms`. Pure, so the create path can
// be tested without a DOM. The payload itself comes from room-editor-form (create and edit share
// one mapping); only the "does this room already exist / where did it land" lookups live here.

import type { RoomDTO } from "../api/client";
import { roomId } from "./labels";

/**
 * Best-effort duplicate check before creating anything: the room is already listed with a
 * recording task on the same platform. Adding it again would create a second task and record twice.
 * (The create endpoint also returns 409 — this only saves a round trip and explains itself.)
 */
export function findExistingRoom(rooms: readonly RoomDTO[], platformId: string, input: string): RoomDTO | undefined {
  const id = roomId(input);
  return rooms.find((r) => r.recording !== null && r.platform === platformId && (r.roomSlug === id || roomId(r.room) === id));
}

/**
 * The room a new task landed in, matched by task id (not by URL text, which may be normalized).
 * If another task already owns that room view, this returns undefined and the caller must not touch
 * the rule — rebinding it would steal the processing half from the existing task.
 */
export function findCreatedRoom(rooms: readonly RoomDTO[], taskId: number): RoomDTO | undefined {
  return rooms.find((r) => r.recording?.taskId === taskId);
}
