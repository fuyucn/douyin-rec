// lib/room-create.ts — payload shapes for the `/rooms` add dialog. Pure, so the create path
// (which writes a hub rule as a side effect) can be tested without a DOM.
import type { HubRulePayload, TaskPayload } from "../api/client";
import type { OutputFormat } from "@drec/output-format";

export interface NewRoomForm {
  room: string;
  name: string;
  schedule: string;
  quality: string;
  engine: string;
  danmu: boolean;
  useCookie: boolean;
  outputFormat: OutputFormat;
  uploadPrivate: boolean;
  workers: string[];
}

export type NewRoomMode = "archive" | "upload";

/** Recording-task payload. `outputFormat` only travels in archive mode (post-processing wins otherwise). */
export function newRoomTaskPayload(f: NewRoomForm, mode: NewRoomMode): TaskPayload {
  return {
    room: f.room.trim(),
    name: f.name.trim() || null,
    quality: f.quality || undefined,
    engine: f.engine || undefined,
    danmu: f.danmu ? 1 : 0,
    useCookie: f.useCookie,
    schedule: f.schedule.trim() || null,
    ...(mode === "archive" ? { outputFormat: f.outputFormat } : {}),
  };
}

/**
 * Hub rule for a new room. `sourceTaskId` is what ties the rule to the recording task, so it is
 * required; a rule without it would never be driven by this task's recordings.
 */
export function newRoomRulePayload(o: { taskId: number; mode: NewRoomMode; danmu: boolean; uploadPrivate: boolean; workers: string[] }): HubRulePayload {
  return {
    enabled: true,
    workers: o.workers,
    recording: { sourceTaskId: o.taskId },
    pipeline: {
      steps: { mergeSegments: true, burnDanmu: o.mode === "upload" && o.danmu, burnLivechat: false },
      upload: {
        mode: o.mode === "upload" ? "upload" : "stage",
        ...(o.mode === "upload" ? { private: o.uploadPrivate, tid: 21 } : {}),
      },
      cleanup: { stageSourceAfterMerge: false, sourceAfterDone: false, stageAfterDone: false },
    },
  };
}
