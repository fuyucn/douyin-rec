/**
 * sync-receipt.ts — master-side expected-version bookkeeping for hub task sync.
 *
 * The version is derived from the *content* of the desired task set, not from a
 * sync attempt. A periodic tick that sends identical content must not look like
 * drift in the UI; only an actual configuration change bumps the version.
 */
import { createHash } from "node:crypto";
import type { RemoteTaskSpec, WorkerStatus } from "@drec/core";

/** Minimal settings surface (TaskStore satisfies it; tests can use a Map). */
export interface ReceiptSettings {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export interface ExpectedVersionState {
  /** Monotonic per worker, starts at 1. */
  version: number;
  /** Hash of the desired content this version was issued for. */
  fingerprint: string;
}

export const expectedVersionKey = (workerId: string): string => `hubSync.expectedVersion.${workerId}`;
export const syncErrorKey = (workerId: string): string => `hubSync.error.${workerId}`;

/** JSON with recursively sorted object keys, so property order cannot change the hash. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const body = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",");
  return `{${body}}`;
}

/**
 * Fingerprint of the desired content. `cookies` is included: a credential change
 * is a real configuration change even though the UI does not display it.
 */
export function desiredFingerprint(desired: RemoteTaskSpec[]): string {
  const sorted = [...desired].sort((a, b) =>
    a.platform.localeCompare(b.platform) || a.roomSlug.localeCompare(b.roomSlug));
  return createHash("sha256").update(stableStringify(sorted)).digest("hex");
}

/**
 * Next expected version for a worker.
 *
 * - no previous state → 1 (the first successful desired set)
 * - same fingerprint → unchanged (periodic sync is not a new version)
 * - changed fingerprint → previous + 1
 *
 * A previous apply failure does not bump the version: the content is what the
 * master expects, so `appliedVersion < expectedVersion` must keep showing drift
 * until the node actually applies it.
 */
export function nextExpectedVersion(
  prev: ExpectedVersionState | null,
  fingerprint: string,
): { state: ExpectedVersionState; changed: boolean } {
  if (!prev || !Number.isFinite(prev.version) || prev.version < 1) {
    return { state: { version: 1, fingerprint }, changed: true };
  }
  if (prev.fingerprint === fingerprint) return { state: prev, changed: false };
  return { state: { version: prev.version + 1, fingerprint }, changed: true };
}

function parseState(raw: string | null): ExpectedVersionState | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ExpectedVersionState>;
    if (typeof parsed.version !== "number" || typeof parsed.fingerprint !== "string") return null;
    if (!Number.isInteger(parsed.version) || parsed.version < 1) return null;
    return { version: parsed.version, fingerprint: parsed.fingerprint };
  } catch {
    return null;
  }
}

/** Current expected version for a worker; undefined = never synced. */
export function readExpectedVersion(settings: ReceiptSettings, workerId: string): number | undefined {
  return parseState(settings.getSetting(expectedVersionKey(workerId)))?.version;
}

/**
 * Issue (or reuse) the expected version for this desired content.
 * Returns the version that must be sent to the worker.
 */
export function recordExpectedVersion(
  settings: ReceiptSettings,
  workerId: string,
  desired: RemoteTaskSpec[],
): number {
  const fingerprint = desiredFingerprint(desired);
  const key = expectedVersionKey(workerId);
  const next = nextExpectedVersion(parseState(settings.getSetting(key)), fingerprint);
  if (next.changed) settings.setSetting(key, JSON.stringify(next.state));
  return next.state.version;
}

/** Record the last sync failure; null clears it after a successful apply. */
export function recordSyncError(settings: ReceiptSettings, workerId: string, error: string | null): void {
  const key = syncErrorKey(workerId);
  if (error) settings.setSetting(key, error);
  else if (settings.getSetting(key)) settings.setSetting(key, "");
}

export function readSyncError(settings: ReceiptSettings, workerId: string): string | undefined {
  const raw = settings.getSetting(syncErrorKey(workerId));
  return raw ? raw : undefined;
}

/**
 * Attach master-side receipt fields to a worker probe result.
 * Node-reported fields are kept as-is; the master only fills what it knows.
 */
export function withMasterReceipt(
  status: WorkerStatus,
  settings: ReceiptSettings,
): WorkerStatus {
  const expectedVersion = readExpectedVersion(settings, status.id);
  const syncError = readSyncError(settings, status.id);
  return {
    ...status,
    ...(expectedVersion !== undefined ? { expectedVersion } : {}),
    ...(syncError ? { syncError } : {}),
  };
}
