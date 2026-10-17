/**
 * last-delivery.ts — "did the last run deliver?" for the room list. Pure, tested.
 *
 * One answer per room from its latest hub run, using the SAME benign/fault verdict as the room
 * status (`runNeedsAttention`), so a row can't say "needs action" in the status column and
 * "delivered" in this one.
 */
import { HUB_TERMINAL_STATES } from "@drec/hub-ledger-contract";
import { runNeedsAttention, type LatestRun } from "./room-status";

export type DeliveryKind = "none" | "running" | "uploaded" | "archived" | "stopped" | "fault";

export interface Delivery {
  kind: DeliveryKind;
  /** Submission id, only for `uploaded`. */
  bv: string | null;
  /** When the run last changed (epoch ms); null when there is no run. */
  at: number | null;
}

const TERMINAL: readonly string[] = HUB_TERMINAL_STATES;

export function lastDelivery(run: LatestRun | null | undefined): Delivery {
  if (!run) return { kind: "none", bv: null, at: null };
  const at = run.updatedAt;
  if (!TERMINAL.includes(run.state)) return { kind: "running", bv: null, at };
  if (run.state === "done") return run.bv ? { kind: "uploaded", bv: run.bv, at } : { kind: "archived", bv: null, at };
  if (run.state === "needs_manual" && !runNeedsAttention(run)) {
    return { kind: run.manualPhase === "stopped" ? "stopped" : "archived", bv: null, at };
  }
  return { kind: "fault", bv: null, at };
}

export type AgeUnit = "now" | "m" | "h" | "d";

/** Coarse "how long ago" — the list only needs minutes/hours/days, never seconds. */
export function ageOf(now: number, at: number): { unit: AgeUnit; n: number } {
  const sec = Math.max(0, Math.floor((now - at) / 1000));
  if (sec < 60) return { unit: "now", n: 0 };
  if (sec < 3600) return { unit: "m", n: Math.floor(sec / 60) };
  if (sec < 86400) return { unit: "h", n: Math.floor(sec / 3600) };
  return { unit: "d", n: Math.floor(sec / 86400) };
}
