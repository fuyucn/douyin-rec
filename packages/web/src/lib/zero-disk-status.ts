/**
 * zero-disk-status.ts — how a side node's zero-disk state is shown in the master console (issue #331).
 * Pure and tested: the backend sends a state + a stable refusal code, the UI picks the wording.
 */
import type { ZeroDiskNodeStatusDTO } from "@drec/contracts";

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
      return { key: (z.code && REFUSAL_KEYS[z.code]) || "room.zeroDisk.refused", tone: "error" };
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
