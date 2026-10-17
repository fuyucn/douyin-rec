/**
 * room-status.ts — one room's list status (recording + processing halves → one badge). Pure, tested.
 *
 * Why a separate derivation: a room is a task (recording) plus a hub rule (processing), and the
 * list shows ONE status per row. Recording state is NOT re-derived here — it comes from
 * `taskPhase` (the single authority); this only decides how it combines with the latest hub run.
 */
import { HUB_TERMINAL_STATES } from "@drec/hub-ledger-contract";
import type { RoomDTO, Task } from "../api/client";
import { taskPhase, type TaskPhase } from "./task-status";

/** List order = this order (needs-you first, paused last). */
export const ROOM_STATUS_ORDER = ["attention", "recording", "processing", "waiting", "paused"] as const;
export type RoomStatusKind = (typeof ROOM_STATUS_ORDER)[number];

/** Latest hub run of a room (`GET /api/hub/latest-runs`). */
export interface LatestRun {
  state: string;
  bv: string | null;
  updatedAt: number;
  /**
   * Fine-grained `needs_manual` phase, same source as the queue page (`needsManualPhaseOf`).
   * Absent on old masters → fall back to treating every needs_manual as attention.
   */
  manualPhase?: string | null;
}

/** needs_manual that is NOT a fault: stage-mode normal close-out, or the user stopped it. */
const BENIGN_MANUAL_PHASES: readonly string[] = ["waiting_upload", "stopped"];

/** Does this run need the user? failed always; needs_manual unless its phase says it is benign. */
export function runNeedsAttention(run: Pick<LatestRun, "state" | "manualPhase">): boolean {
  if (run.state === "failed") return true;
  if (run.state !== "needs_manual") return false;
  return !(run.manualPhase != null && BENIGN_MANUAL_PHASES.includes(run.manualPhase));
}

export interface RoomStatus {
  kind: RoomStatusKind;
  /** Why this kind: the task phase (when it decided) or the run state. */
  phase: TaskPhase | null;
  run: LatestRun | null;
}

/**
 * Key used by `latest-runs`: `{platform}:{roomSlug}` (colon). A room's own key is
 * `{platform}.{roomSlug}` (dot) — joining on `room.key` would silently match nothing.
 */
export function latestRunKey(room: Pick<RoomDTO, "platform" | "roomSlug">): string {
  return `${room.platform}:${room.roomSlug}`;
}

const TERMINAL: readonly string[] = HUB_TERMINAL_STATES;

/**
 * Precedence (overlapping inputs are common, so order matters):
 * 1. live recording (incl. draining / stopping — the stream is still being written);
 * 2. a recording fault (nodes offline / task error) — must not hide behind "processing";
 *    (in the LIST, attention sorts above everything — see ROOM_STATUS_ORDER)
 * 3. a non-terminal hub run → processing;
 * 4. rule paused, task disabled or no task → paused — a switched-off room's stale failed run is
 *    noise in the list (it stays visible on the detail page);
 * 5. latest run failed / needs_manual-with-a-fault → attention (until a newer run replaces it);
 *    stage close-out and user-stop are not faults → waiting;
 * 6. otherwise waiting for the stream.
 */
export function roomStatus(room: Pick<RoomDTO, "processing" | "recording">, task: Task | undefined, run: LatestRun | null): RoomStatus {
  const phase = task ? taskPhase(task) : null;
  const out = (kind: RoomStatusKind): RoomStatus => ({ kind, phase, run });
  if (phase && (phase.kind === "recording" || phase.kind === "draining" || phase.kind === "stopping")) return out("recording");
  if (phase && (phase.kind === "offline" || phase.kind === "error")) return out("attention");
  if (run && !TERMINAL.includes(run.state)) return out("processing");
  if (room.processing?.enabled === false || !task || !task.enabled) return out("paused");
  if (run && runNeedsAttention(run)) return out("attention");
  return out("waiting");
}

/** Stable sort by status order; ties keep the server order. */
export function sortByStatus<T>(items: readonly T[], statusOf: (x: T) => RoomStatus): T[] {
  const rank = (x: T): number => ROOM_STATUS_ORDER.indexOf(statusOf(x).kind);
  return items.map((x, i) => ({ x, i, r: rank(x) })).sort((a, b) => a.r - b.r || a.i - b.i).map((e) => e.x);
}
