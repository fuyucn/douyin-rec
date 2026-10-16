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
 * What to do about the processing half when adding a room.
 *
 * - `create`   — no rule for this room yet → write a fresh one with the chosen shape.
 * - `bindOnly` — the room already has a rule (possibly hand-tuned, maybe paused) → only point its
 *   `sourceTaskId` at the new task. Writing a full rule here would silently re-enable the room and
 *   rewrite its upload mode / burn flags / nodes, which the user never asked for.
 */
export type NewRoomRulePlan =
  | { kind: "create"; payload: HubRulePayload }
  | { kind: "bindOnly"; taskId: number };

export function planNewRoomRule(o: {
  taskId: number;
  mode: NewRoomMode;
  danmu: boolean;
  uploadPrivate: boolean;
  /** 空 = 全部节点(与 isWorkerTargeted 同义,不固化成当前节点快照)。 */
  workers: string[];
  hasExistingRule: boolean;
}): NewRoomRulePlan {
  if (o.hasExistingRule) return { kind: "bindOnly", taskId: o.taskId };
  return { kind: "create", payload: newRoomRulePayload(o) };
}

/**
 * Hub rule for a new room. `sourceTaskId` is what ties the rule to the recording task, so it is
 * required; a rule without it would never be driven by this task's recordings.
 * `workers: []` means "all nodes" (dynamic) — never expand it to today's node list.
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
