/**
 * sync-receipt.ts — master-side expected-version bookkeeping for hub task sync.
 *
 * The version is derived from the *content* of the desired task set, not from a
 * sync attempt. A periodic tick that sends identical content must not look like
 * drift in the UI; only an actual configuration change bumps the version.
 */
import { createHash } from "node:crypto";
import type { ApplyCookiesPayload, ApplyCookiesResult, RemoteTaskSpec, WorkerStatus } from "@drec/core";

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
/** Last platform-credential fingerprint this worker confirmed applying (issue #563). */
export const cookiesAppliedKey = (workerId: string): string => `hubSync.cookiesApplied.${workerId}`;

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

/**
 * Fingerprint of the platform-credential payload (issue #563).
 *
 * Platform ids are sorted so map order cannot change the hash; the values themselves never leave this
 * function. The master records this per worker to skip the ssh round trip when nothing changed
 * (`hubSync.cookiesApplied.<workerId>`).
 */
export function cookiesFingerprint(payload: ApplyCookiesPayload): string {
  const entries = Object.entries(payload.platformCookies)
    .filter(([, value]) => typeof value === "string" && value.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));
  return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
}

/** What a worker last confirmed applying, and when. */
export interface CookiesAppliedState {
  fingerprint: string;
  /** epoch ms of the confirmation. */
  at: number;
}

/**
 * How long a confirmed push is trusted before it is re-sent anyway.
 *
 * Why: the bookkeeping lives on the **master**, so a worker that was reinstalled / lost its data root
 * (empty db, no credential) still looks "already applied" and would stay anonymous forever — visible only
 * as zero danmaku (issue #563 review F3). Re-sending one small payload per node every 6h bounds that
 * window to hours instead of "until the next master login".
 */
export const COOKIE_REVERIFY_MS = 6 * 60 * 60 * 1000;

/** Parse the stored state; a legacy bare fingerprint (or garbage) is treated as "unknown, re-send". */
function parseCookiesApplied(raw: string | null): CookiesAppliedState | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as Partial<CookiesAppliedState>;
    if (typeof p.fingerprint === "string" && p.fingerprint.length > 0 && typeof p.at === "number" && Number.isFinite(p.at)) {
      return { fingerprint: p.fingerprint, at: p.at };
    }
    return undefined;
  } catch {
    // Legacy shape (a bare fingerprint string): no timestamp → re-send once and start tracking.
    return undefined;
  }
}

/** Fingerprint the worker last confirmed applying, with its timestamp. */
export function readCookiesApplied(settings: ReceiptSettings, workerId: string): CookiesAppliedState | undefined {
  return parseCookiesApplied(settings.getSetting(cookiesAppliedKey(workerId)));
}

/** Record that this worker confirmed the delivered credential payload. */
export function recordCookiesApplied(
  settings: ReceiptSettings,
  workerId: string,
  fingerprint: string,
  at: number = Date.now(),
): void {
  settings.setSetting(cookiesAppliedKey(workerId), JSON.stringify({ fingerprint, at } satisfies CookiesAppliedState));
}

/** Outcome of one credential push, reduced to the only question the master must answer: record or retry. */
export interface CookiesPushVerdict {
  /** Every delivered platform accounted for and no rejected value → the fingerprint may be recorded. */
  ok: boolean;
  /** Delivered platforms the node neither applied nor acknowledged (must be empty on a clean apply). */
  missing: string[];
  /** Values the node refused as unusable (corrupted/truncated) → retry. */
  rejected: string[];
  /** Platforms the node does not have at all (informational, not a failure). */
  unsupported: string[];
}

/**
 * Decide whether a push counts as delivered.
 *
 * `unsupported` counts as accounted for: a node whose bundle predates a platform can never apply it, and
 * treating that as "missing" would re-send the whole payload every sync tick forever (issue #563 review).
 * `rejected`/`missing` must not be recorded — those are real failures and get retried.
 */
export function cookiesPushVerdict(payload: ApplyCookiesPayload, result: ApplyCookiesResult): CookiesPushVerdict {
  const accounted = new Set([...result.applied, ...result.unchanged, ...(result.unsupported ?? [])]);
  const missing = Object.keys(payload.platformCookies).filter((p) => !accounted.has(p));
  const rejected = [...(result.rejected ?? [])];
  return { ok: missing.length === 0 && rejected.length === 0, missing, rejected, unsupported: [...(result.unsupported ?? [])] };
}

/**
 * Should this worker receive the payload now?
 *
 * - never confirmed → yes;
 * - credential content changed → yes;
 * - same content but the confirmation is older than `maxAgeMs` → yes (re-verify, see COOKIE_REVERIFY_MS).
 */
export function shouldPushCookies(
  prev: CookiesAppliedState | undefined,
  fingerprint: string,
  nowMs: number,
  maxAgeMs: number = COOKIE_REVERIFY_MS,
): boolean {
  if (!prev) return true;
  if (prev.fingerprint !== fingerprint) return true;
  return nowMs - prev.at >= maxAgeMs;
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
