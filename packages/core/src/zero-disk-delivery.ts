/**
 * zero-disk-delivery.ts — contract between the master and a side node that runs a zero-disk
 * upload (issue #331). Pure types + strict parsers; no IO.
 *
 * Why a dedicated contract: a node's rule directory is empty, so everything the zero-disk
 * process used to read from the local rule (visibility, partition, tags, title templates) would
 * silently fall back to built-in defaults there, and Bilibili publishing is irreversible. The
 * master therefore ships the resolved metadata with the task spec and the node consumes ONLY that.
 * Parsing is strict on purpose: a missing field is a refusal to start, never a default.
 */
import { processTimeZone, zonedStamp } from "./title-template.js";
import {
  capLiveUploadSnapshot, LIVE_HISTORY_LIMIT, normalizeLiveUploadSnapshot, REPORT_EVENT_LIMIT, REPORT_PART_LIMIT,
  type LiveUploadSnapshot, type LiveUploadSummary,
} from "./live-upload.js";

/** Env var carrying the delivered JSON from the node's task manager to its `record` child. */
export const ZERO_DISK_DELIVERY_ENV = "DREC_ZERO_DISK_DELIVERY";

/** Upload metadata resolved by the master for one room (rule > hub.config uploadDefaults > built-ins). */
export interface ZeroDiskUploadMeta {
  tid: number;
  tag: string;
  desc?: string;
  /** Explicit on purpose: visibility is the one field that must never be defaulted on a node. */
  private: boolean;
  titleTemplate?: string;
  submissionTitleTemplate?: string;
  partTitleTemplate?: string;
  /** Optional Bilibili season section id; the node adds the archive after its first submit. */
  seasonSectionId?: number;
  /** Optional per-part byte cap in MiB; absent = built-in default. */
  partSizeMiB?: number;
}

/** Everything a hub-managed node needs to run a zero-disk room without reading master config. */
export interface ZeroDiskDelivery {
  v: 1;
  meta: ZeroDiskUploadMeta;
  /** Account key (core `biliAccountKey`) of the master-configured upload account. */
  accountKey: string;
  /** Fallback path of the upload login file ON THE NODE; only a path travels, never its content. */
  credentialPath?: string;
}

export type ZeroDiskDeliveryParse =
  | { ok: true; value: ZeroDiskDelivery }
  | { ok: false; error: string };

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);
const optString = (o: Record<string, unknown>, k: string): string | undefined | null => {
  const v = o[k];
  if (v === undefined || v === null) return undefined;
  return typeof v === "string" ? v : null;
};

/** Allowed per-part size range (MiB) for live upload; shared by API validation and delivery parsing. */
export const PART_SIZE_MIB_MIN = 100;
export const PART_SIZE_MIB_MAX = 4096;

export function isValidPartSizeMiB(x: unknown): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= PART_SIZE_MIB_MIN && x <= PART_SIZE_MIB_MAX;
}

/** Account keys that identify no account (`bilibili:unknown`, empty) cannot be verified. */
export function isKnownAccountKey(key: unknown): key is string {
  return typeof key === "string" && /^bilibili:\S+$/.test(key) && key !== "bilibili:unknown";
}

/** Strict parse of the delivery object. Any missing/mistyped field is an error (no defaults). */
export function parseZeroDiskDelivery(raw: unknown): ZeroDiskDeliveryParse {
  const bad = (why: string): ZeroDiskDeliveryParse => ({ ok: false, error: `zero-disk delivery invalid: ${why}` });
  if (!isRecord(raw)) return bad("not an object");
  if (raw.v !== 1) return bad("unsupported version");
  const m = raw.meta;
  if (!isRecord(m)) return bad("meta missing");
  if (typeof m.private !== "boolean") return bad("meta.private must be an explicit boolean");
  if (!Number.isInteger(m.tid) || (m.tid as number) <= 0) return bad("meta.tid must be a positive integer");
  if (typeof m.tag !== "string" || m.tag.trim() === "") return bad("meta.tag must be a non-empty string");
  const desc = optString(m, "desc");
  const titleTemplate = optString(m, "titleTemplate");
  const submissionTitleTemplate = optString(m, "submissionTitleTemplate");
  const partTitleTemplate = optString(m, "partTitleTemplate");
  if (desc === null || titleTemplate === null || submissionTitleTemplate === null || partTitleTemplate === null) {
    return bad("meta text fields must be strings");
  }
  const rawSeason = m.seasonSectionId;
  // Season association is optional: a bad optional value drops the feature instead of refusing
  // the whole zero-disk delivery (the upload itself must still start).
  const seasonSectionId = typeof rawSeason === "number" && Number.isSafeInteger(rawSeason) && rawSeason > 0
    ? rawSeason
    : undefined;
  // Optional like the season id: an out-of-range value falls back to the default instead of refusing.
  const rawSize = m.partSizeMiB;
  const partSizeMiB = isValidPartSizeMiB(rawSize) ? rawSize : undefined;
  if (!isKnownAccountKey(raw.accountKey)) return bad("accountKey missing or unknown");
  const credentialPath = optString(raw, "credentialPath");
  if (credentialPath === null) return bad("credentialPath must be a string");
  return {
    ok: true,
    value: {
      v: 1,
      meta: {
        tid: m.tid as number,
        tag: m.tag,
        private: m.private,
        ...(desc ? { desc } : {}),
        ...(titleTemplate ? { titleTemplate } : {}),
        ...(submissionTitleTemplate ? { submissionTitleTemplate } : {}),
        ...(partTitleTemplate ? { partTitleTemplate } : {}),
        ...(seasonSectionId ? { seasonSectionId } : {}),
        ...(partSizeMiB ? { partSizeMiB } : {}),
      },
      accountKey: raw.accountKey,
      ...(credentialPath ? { credentialPath } : {}),
    },
  };
}

/** Why a zero-disk run on a node refused to start (stable codes; the UI maps them to text). */
export type ZeroDiskRefusalCode =
  | "delivery_missing"      // managed node task without (valid) delivered metadata
  | "credential_missing"    // no upload login file found on the node
  | "account_unknown"       // node or master account cannot be identified
  | "account_mismatch";     // node account differs from the master-configured one

export interface ZeroDiskRefusal {
  code: ZeroDiskRefusalCode;
  /** Human readable, contains no key/credential values. */
  message: string;
}

/** Compare the node's login account with the master-configured one. null = verified equal. */
export function zeroDiskAccountVerdict(expectedKey: string, nodeKey: string): ZeroDiskRefusal | null {
  if (!isKnownAccountKey(expectedKey)) return { code: "account_unknown", message: "master-configured upload account cannot be identified" };
  if (!isKnownAccountKey(nodeKey)) return { code: "account_unknown", message: "node upload login does not identify an account" };
  if (expectedKey !== nodeKey) return { code: "account_mismatch", message: "node upload account differs from the master-configured account" };
  return null;
}

/**
 * Ledger key of a zero-disk run (issue #324): `{platform}:{roomSlug}:{date}_{HHMM}-zd`, date and time of the
 * stream start in the configured time zone.
 *
 * It must never equal a key the broadcast clustering can produce (`{date}` / `{date}_{HHMM}` / `-N`). A zero-disk
 * run used to take the bare `{UTC date}` key without a start time; clustering then treated a real recording of the
 * same room and day as "the known job", reused the key, found it `done` and skipped the recording without a trace.
 */
export function zeroDiskStreamKey(platform: string, roomSlug: string, startMs: number, timeZone: string = processTimeZone()): string {
  const z = zonedStamp(startMs, timeZone);
  return `${platform}:${roomSlug}:${z.date}_${z.hh}${z.mm}-zd`;
}

/** One finished zero-disk run, written by the node and applied to the master ledger exactly once. */
export interface ZeroDiskReceipt {
  v: 1;
  /** Unique per run (stable across re-polls); the master dedupes on it. */
  id: string;
  platform: string;
  roomSlug: string;
  /** Ledger job key, built by the node with {@link zeroDiskStreamKey} (same formula as the local path). */
  streamKey: string;
  /** When the run started; stored as the ledger job's startMs. Absent on receipts from nodes older than issue #324. */
  startMs?: number;
  bvid: string;
  parts: number;
  atMs: number;
}

/**
 * Ledger entry the master records for a receipt. Receipts from nodes older than issue #324 carry no start time and
 * the bare UTC-date key that swallows same-day real recordings; those are re-keyed into the `-zd` namespace using the
 * completion time instead of trusting the node's formula.
 */
export function zeroDiskReceiptLedgerEntry(r: ZeroDiskReceipt, timeZone?: string): { streamKey: string; startMs: number } {
  if (r.startMs === undefined) {
    return { streamKey: zeroDiskStreamKey(r.platform, r.roomSlug, r.atMs, timeZone), startMs: r.atMs };
  }
  return { streamKey: r.streamKey, startMs: r.startMs };
}

/** Lifecycle of the zero-disk process on a node, as shown in the master console. */
export type ZeroDiskRunState = "running" | "finished" | "failed" | "refused" | "stopped";

export interface ZeroDiskNodeStatus {
  v: 1;
  platform: string;
  roomSlug: string;
  state: ZeroDiskRunState;
  /** Present when `state === "refused"`. */
  code?: ZeroDiskRefusalCode;
  message?: string;
  /** Parts confirmed into the archive so far. */
  parts: number;
  bvid?: string;
  updatedAt: number;
}

/** `_zero-disk-report` payload: read-only receipts + per-room status. */
export interface ZeroDiskReport {
  v: 1;
  receipts: ZeroDiskReceipt[];
  status: ZeroDiskNodeStatus[];
  /** Bounded current/previous snapshots for rooms with an active or recent run; `history` = finished runs, newest first. */
  live?: Array<{ platform: string; roomSlug: string; current?: LiveUploadSnapshot; previous?: LiveUploadSnapshot; history?: LiveUploadSnapshot[] }>;
}

const RUN_STATES: readonly string[] = ["running", "finished", "failed", "refused", "stopped"];
const REFUSALS: readonly string[] = ["delivery_missing", "credential_missing", "account_unknown", "account_mismatch"];

export function normalizeZeroDiskReceipt(x: unknown): ZeroDiskReceipt | null {
  if (!isRecord(x) || x.v !== 1) return null;
  const { id, platform, roomSlug, streamKey, bvid, parts, atMs } = x;
  if (typeof id !== "string" || !id || typeof platform !== "string" || !platform || typeof roomSlug !== "string" || !roomSlug) return null;
  if (typeof streamKey !== "string" || !streamKey || typeof bvid !== "string" || !bvid) return null;
  if (!Number.isInteger(parts) || (parts as number) < 0 || typeof atMs !== "number" || !Number.isFinite(atMs)) return null;
  const startMs = typeof x.startMs === "number" && Number.isFinite(x.startMs) ? x.startMs : undefined;
  return { v: 1, id, platform, roomSlug, streamKey, bvid, parts: parts as number, atMs, ...(startMs !== undefined ? { startMs } : {}) };
}

export function normalizeZeroDiskStatus(x: unknown): ZeroDiskNodeStatus | null {
  if (!isRecord(x) || x.v !== 1) return null;
  const { platform, roomSlug, state, parts, updatedAt } = x;
  if (typeof platform !== "string" || !platform || typeof roomSlug !== "string" || !roomSlug) return null;
  if (typeof state !== "string" || !RUN_STATES.includes(state)) return null;
  if (!Number.isInteger(parts) || (parts as number) < 0 || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) return null;
  const code = typeof x.code === "string" && REFUSALS.includes(x.code) ? (x.code as ZeroDiskRefusalCode) : undefined;
  return {
    v: 1,
    platform,
    roomSlug,
    state: state as ZeroDiskRunState,
    ...(code ? { code } : {}),
    ...(typeof x.message === "string" ? { message: x.message.slice(0, 300) } : {}),
    parts: parts as number,
    ...(typeof x.bvid === "string" && x.bvid ? { bvid: x.bvid } : {}),
    updatedAt,
  };
}

/** Lenient-per-item, strict-per-shape: bad entries are dropped, never trusted. */
export function normalizeZeroDiskReport(x: unknown): ZeroDiskReport | null {
  if (!isRecord(x) || x.v !== 1) return null;
  const receipts = (Array.isArray(x.receipts) ? x.receipts : []).map(normalizeZeroDiskReceipt).filter((r): r is ZeroDiskReceipt => r !== null);
  const status = (Array.isArray(x.status) ? x.status : []).map(normalizeZeroDiskStatus).filter((s): s is ZeroDiskNodeStatus => s !== null);
  const live = (Array.isArray(x.live) ? x.live : []).flatMap((v) => {
    if (!isRecord(v) || typeof v.platform !== "string" || !v.platform || typeof v.roomSlug !== "string" || !v.roomSlug) return [];
    const current = v.current ? normalizeLiveUploadSnapshot(v.current) : undefined;
    const previous = v.previous ? normalizeLiveUploadSnapshot(v.previous) : undefined;
    const history = (Array.isArray(v.history) ? v.history : [])
      .flatMap((h) => { const s = normalizeLiveUploadSnapshot(h); return s ? [capLiveUploadSnapshot(s, { events: REPORT_EVENT_LIMIT, parts: REPORT_PART_LIMIT })] : []; })
      .slice(0, LIVE_HISTORY_LIMIT);
    return [{
      platform: v.platform,
      roomSlug: v.roomSlug,
      ...(current ? { current: capLiveUploadSnapshot(current) } : {}),
      ...(previous ? { previous: capLiveUploadSnapshot(previous) } : {}),
      ...(history.length ? { history } : {}),
    }];
  });
  return { v: 1, receipts, status, ...(live.length ? { live } : {}) };
}

/** GET /api/tasks projection of one zero-disk node for a room (one entry per targeted worker). */
export interface ZeroDiskNodeStatusDTO {
  workerId: string;
  workerName: string;
  /** ok = reporting; unsupported = old node / capability missing; offline = unreachable; blocked = master refused to push. */
  state: "ok" | "unsupported" | "offline" | "blocked";
  /** Why, for every state except a healthy ok (no credential or key values). */
  reason?: string;
  /** Node-reported lifecycle (only for state=ok and a status file exists). */
  run?: ZeroDiskRunState;
  code?: ZeroDiskRefusalCode;
  message?: string;
  parts?: number;
  bvid?: string;
  /** When the master last got a real answer (epoch ms). */
  checkedAt: number | null;
  /** Compact timeline summary for this worker/room. */
  live?: LiveUploadSummary;
}
