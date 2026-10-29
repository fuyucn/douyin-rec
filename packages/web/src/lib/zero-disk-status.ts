/**
 * zero-disk-status.ts — how a side node's zero-disk state is shown in the master console (issue #331).
 * Pure and tested: the backend sends a state + a stable refusal code, the UI picks the wording.
 */
import type { LiveUploadSummary, ZeroDiskNodeStatusDTO } from "@drec/contracts";

export type ZeroDiskTone = "ok" | "warn" | "error" | "muted";

export interface ZeroDiskView {
  /** i18n key under `room.zeroDisk.*`. */
  key: string;
  vars?: Record<string, string>;
  tone: ZeroDiskTone;
  /** Backend-provided detail (shown as a tooltip), when there is one. */
  detail?: string;
}

const REFUSAL_KEYS: Record<string, string> = {
  account_mismatch: "room.zeroDisk.refusedAccountMismatch",
  account_unknown: "room.zeroDisk.refusedAccountUnknown",
  credential_missing: "room.zeroDisk.refusedCredential",
  delivery_missing: "room.zeroDisk.refusedDelivery",
};

export function zeroDiskView(z: ZeroDiskNodeStatusDTO): ZeroDiskView {
  switch (z.state) {
    case "unsupported":
      return { key: "room.zeroDisk.unsupported", tone: "error", ...(z.reason ? { detail: z.reason } : {}) };
    case "offline":
      return { key: "room.zeroDisk.offline", tone: "warn", ...(z.reason ? { detail: z.reason } : {}) };
    case "blocked":
      return { key: "room.zeroDisk.blocked", tone: "error", ...(z.reason ? { detail: z.reason } : {}) };
    case "ok":
      break;
    default: {
      const unhandled: never = z.state;
      void unhandled;
      return { key: "room.zeroDisk.idle", tone: "muted" };
    }
  }
  switch (z.run) {
    case "refused":
      return { key: (z.code && REFUSAL_KEYS[z.code]) || "room.zeroDisk.refused", tone: "error", ...(z.message ? { detail: z.message } : {}) };
    case "failed":
      return { key: "room.zeroDisk.failed", tone: "error", ...(z.message ? { detail: z.message } : {}) };
    case "running":
      return { key: "room.zeroDisk.running", vars: { n: String(z.parts ?? 0) }, tone: "ok" };
    case "finished":
      return { key: "room.zeroDisk.finished", vars: { n: String(z.parts ?? 0) }, tone: "ok" };
    case "stopped":
      return { key: "room.zeroDisk.stopped", vars: { n: String(z.parts ?? 0) }, tone: "warn" };
    default:
      return { key: "room.zeroDisk.idle", tone: "muted" };
  }
}

/** A state the user has to act on (an old node, a refusal, a failure, an unreachable node). */
export function zeroDiskNeedsAttention(z: ZeroDiskNodeStatusDTO): boolean {
  const tone = zeroDiskView(z).tone;
  return tone === "error" || z.state === "offline";
}

export interface LiveDetailEntry {
  workerId: string;
  workerName: string;
  current?: import("@drec/contracts").LiveUploadSnapshot;
  previous?: import("@drec/contracts").LiveUploadSnapshot;
}

export interface LiveUploadView {
  state: string;
  currentPart?: number;
  parts: import("@drec/contracts").LivePartView[];
  events: import("@drec/contracts").LiveEvent[];
  bvid?: string;
  updatedAt: number;
  tone: ZeroDiskTone;
}

/** Pick the newest detail entry (current first, then previous). */
export function liveUploadView(summary: LiveUploadSummary, entries: LiveDetailEntry[] = []): LiveUploadView {
  const best = entries
    .flatMap((e) => [e.current, e.previous].filter((x): x is NonNullable<typeof x> => !!x))
    .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  const snap = best;
  const tone: ZeroDiskTone = summary.state === "failed" ? "error" : summary.state === "stopped" ? "warn" : summary.state === "finished" ? "muted" : "ok";
  return {
    state: snap?.state ?? summary.state,
    ...(snap?.currentPart?.index !== undefined ? { currentPart: snap.currentPart.index } : {}),
    parts: snap?.parts ?? [],
    events: snap?.events ?? [],
    ...(snap?.bvid ?? summary.bvid ? { bvid: snap?.bvid ?? summary.bvid } : {}),
    updatedAt: snap?.updatedAt ?? summary.updatedAt,
    tone,
  };
}
