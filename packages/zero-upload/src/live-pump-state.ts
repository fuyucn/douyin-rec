import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

export interface LivePumpSourceFingerprint {
  size: number;
  mtimeMs: number;
  dev: number;
  ino: number;
}

export function fingerprintLivePumpSource(path: string): LivePumpSourceFingerprint | undefined {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return undefined;
    return { size: stat.size, mtimeMs: stat.mtimeMs, dev: stat.dev, ino: stat.ino };
  } catch {
    return undefined;
  }
}

export function matchesLivePumpSource(path: string, expected?: LivePumpSourceFingerprint): boolean {
  if (!expected || !Number.isSafeInteger(expected.size) || expected.size < 0
    || !Number.isFinite(expected.mtimeMs) || !Number.isSafeInteger(expected.dev)
    || !Number.isSafeInteger(expected.ino)) return false;
  const actual = fingerprintLivePumpSource(path);
  return !!actual && actual.size === expected.size && actual.mtimeMs === expected.mtimeMs
    && actual.dev === expected.dev && actual.ino === expected.ino;
}

/** Durable archive state. Only the recording process writes this file. */
export interface LivePumpState {
  schemaVersion: 1;
  submissionProofVersion?: 1;
  room: string;
  createdAt: number;
  title: string;
  tid: number;
  tag: string;
  /** Archive description; absent in older state files (treated as empty). */
  desc?: string;
  private: boolean;
  /** Archive identity; absent until the first part is submitted. */
  bvid?: string;
  aid?: number;
  /** Persist with archive identity before the best-effort season call so restart can recover. */
  seasonState?: "pending" | "done" | "failed";
  /** Local part history; cleanup requires qualified native per-part observation. */
  parts: Array<{
    index: number;
    spoolPath: string;
    filename: string;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
    confirmed: boolean;
    proof?: "accepted" | "observed";
    nativeKey?: string;
    acceptedAt?: number;
    observedAt?: number;
    sourceFp?: LivePumpSourceFingerprint;
    /** Incomplete spools cannot be auto-resubmitted after a write failure (issue #579). */
    spoolIncomplete?: boolean;
    /** Absent means sealed for old schemaVersion 1 states. False is an open-time WAL placeholder
     * that recovery must discard rather than re-upload; keep schemaVersion 1 for compatibility. */
    sealed?: boolean;
    /** Positive local duration/DTS validation proof. Missing means default-deny at queue handoff.
     * A seal-time WAL row is not proof; startup must validate it or require manual recovery. */
    validated?: boolean;
    /** Deprecated negative marker kept for pre-T-221 state files; still blocks enqueue. */
    needsValidation?: boolean;
  }>;
  /** Delivery degraded to spool-only but the queue accepted no rows (for example an order hole).
   * This preserves spool-mode recording on restart without claiming that the queue owns work. */
  deliveryDeferred?: boolean;
  /** Historical queue ownership marker. Preserve the hold until delivery is qualified;
   * old confirmations and journal ACKs cannot clear it. */
  queueManaged?: boolean;
  /** WAL for crash recovery. */
  pending?: {
    kind: "create" | "append";
    submissionState?: "intent" | "accepted";
    acceptedAt?: number;
    acceptedBvid?: string;
    acceptedAid?: number;
    partIndex: number;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
    spoolPath: string;
    sourceFp?: LivePumpSourceFingerprint;
  };
  updatedAt: number;
}

export function requiresLivePumpProof(state: LivePumpState): boolean {
  return state.submissionProofVersion !== undefined
    || !!state.pending
    || state.parts.some(part => part?.proof !== undefined);
}

export function isLivePumpPartObserved(part: LivePumpState["parts"][number]): boolean {
  return part?.confirmed === true && part.proof === "observed"
    && typeof part.nativeKey === "string" && part.nativeKey.length > 0
    && part.nativeKey === part.stem
    && Number.isFinite(part.observedAt) && part.observedAt! > 0;
}

export function hasUnobservedLivePumpWork(state: LivePumpState): boolean {
  return !!state.pending || !!state.queueManaged || !!state.deliveryDeferred
    || state.parts.some(part => !isLivePumpPartObserved(part))
    || (!requiresLivePumpProof(state) && (!!state.bvid || state.aid !== undefined));
}

/** Protect both part rows and pending WAL paths: either can own the only recovery copy. */
export function spoolPathsToKeep(state: LivePumpState | null): string[] {
  if (!state) return [];
  const out = state.parts.map((p) => p.spoolPath);
  if (state.pending) out.push(state.pending.spoolPath);
  return out;
}

export function livePumpStatePath(spoolDir: string, room: string): string {
  const safe = room.replace(/[^0-9A-Za-z_-]+/g, "_");
  return join(spoolDir, `live-pump-${safe}.state.json`);
}

export function readLivePumpState(path: string): LivePumpState | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf-8")) as LivePumpState;
    if (s.schemaVersion !== 1 || !s.room || !Array.isArray(s.parts)) return null;
    if (s.submissionProofVersion !== undefined && s.submissionProofVersion !== 1) return null;
    return s;
  } catch {
    return null;
  }
}

export function writeLivePumpState(path: string, state: LivePumpState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}
