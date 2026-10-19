/**
 * notify-context.ts — structured context for notifications (issue #53, step N1: contract only).
 *
 * Events today carry a bare streamKey or room id, so a reader cannot tell which live room a
 * notification is about. This module defines the shared vocabulary that later steps attach to
 * events (`NotifyEvent.ctx`) and render: the streamKey parser and the single display-name priority
 * chain. Nothing renders `ctx` yet, so existing messages are unchanged.
 */
import { parseSessionStamp } from "./title-template.js";

/** A parsed hub streamKey `{platform}:{roomSlug}:{YYYY-MM-DD}[_HHMM]`. */
export interface ParsedStreamKey { platform: string; roomSlug: string; date: string; time?: string }

/** Matches one streamKey; shared with the free-text humanizer (observability). */
export const STREAM_KEY_SOURCE = "([a-z]+):([^\\s:]+):(\\d{4}-\\d{2}-\\d{2})(?:_(\\d{2})(\\d{2}))?(?!\\d)";

/** Parse a streamKey; null when it is not in that format. The same-day `_HHMM` suffix becomes `HH:MM`. */
export function parseStreamKey(key: string): ParsedStreamKey | null {
  const m = new RegExp(`^${STREAM_KEY_SOURCE}$`).exec(key);
  if (!m) return null;
  return { platform: m[1]!, roomSlug: m[2]!, date: m[3]!, ...(m[4] ? { time: `${m[4]}:${m[5]}` } : {}) };
}

/** Where a resolved display name came from (lets renderers and tests tell a real name from a fallback). */
export type DisplayNameSource = "task" | "live" | "cached" | "ledger" | "session" | "fallback";

/** Every place a room's display name can come from; all optional. */
export interface DisplayNameSources {
  /** Name the user gave the task (explicit choice wins). */
  taskName?: string | null;
  /** Anchor name parsed by the running recorder (freshest). */
  liveAnchor?: string | null;
  /** Anchor name cached on the task row. */
  cachedAnchor?: string | null;
  /** Name snapshot stored on the ledger job (survives task deletion). */
  ledgerAnchor?: string | null;
  /** Session base `{name}_{YYYY-MM-DD}[_HH-MM[-SS]]`; the name prefix is used. */
  sessionBase?: string | null;
  platform?: string | null;
  roomSlug?: string | null;
}

const clean = (v: string | null | undefined): string => (v ?? "").trim();

/**
 * The single display-name priority chain: task name → live anchor → cached anchor → ledger snapshot →
 * session base prefix → `平台 房间` fallback (never the raw streamKey). Pure; callers gather sources.
 */
export function resolveDisplayName(s: DisplayNameSources): { name: string; source: DisplayNameSource } {
  const ordered: Array<[DisplayNameSource, string]> = [
    ["task", clean(s.taskName)],
    ["live", clean(s.liveAnchor)],
    ["cached", clean(s.cachedAnchor)],
    ["ledger", clean(s.ledgerAnchor)],
    ["session", clean(s.sessionBase ? parseSessionStamp(clean(s.sessionBase))?.name : "")],
  ];
  for (const [source, name] of ordered) if (name) return { name, source };
  const fallback = [clean(s.platform), clean(s.roomSlug)].filter(Boolean).join(" ");
  return { name: fallback || "未知直播间", source: "fallback" };
}

/** Outcome class of a notification; `error` requires `next` once rendering lands (N5). */
export type NotifyResult = "ok" | "warn" | "error";

/** Structured, optional context attached to a notification event. */
export interface NotifyContext {
  /** Resolved display name (see resolveDisplayName) and where it came from. */
  name?: string;
  nameSource?: DisplayNameSource;
  platform?: string;
  roomSlug?: string;
  /** Session date `YYYY-MM-DD`, plus `HH:MM` when several sessions share a day. */
  date?: string;
  time?: string;
  streamKey?: string;
  /** Node display name or role (master / worker). */
  node?: string;
  /** Pipeline step (e.g. merge, burn). */
  step?: string;
  result?: NotifyResult;
  /** Short actionable next step for the reader. */
  next?: string;
}

/** Build the context for a hub session from its streamKey and whatever name sources the caller has. */
export function contextForStream(streamKey: string, names: Omit<DisplayNameSources, "platform" | "roomSlug"> = {}): NotifyContext {
  const k = parseStreamKey(streamKey);
  const resolved = resolveDisplayName({ ...names, platform: k?.platform, roomSlug: k?.roomSlug });
  return {
    name: resolved.name,
    nameSource: resolved.source,
    streamKey,
    ...(k ? { platform: k.platform, roomSlug: k.roomSlug, date: k.date, ...(k.time ? { time: k.time } : {}) } : {}),
  };
}

/** What a recording session knows about its room when it notifies. */
export interface RecordNameFacts {
  /** Task name passed to the recorder (`--name`). */
  taskName?: string | null;
  /** Anchor name the recorder resolved from the platform. */
  liveAnchor?: string | null;
  platform?: string | null;
  roomSlug?: string | null;
}

/**
 * Decorate an event from a recording session (issue #53 N4): attach `ctx` built by the shared name
 * chain and, for the record start / reconnect / end events, show that resolved name instead of the
 * raw platform anchor so the recorder's own notifications match the master's. Fields already on the
 * event's `ctx` win. The `room` field and everything else stay as they were.
 */
export function decorateRecordEvent<E extends { kind: string; ctx?: NotifyContext; anchor?: string }>(e: E, f: RecordNameFacts): E {
  const resolved = resolveDisplayName({ taskName: f.taskName, liveAnchor: f.liveAnchor, platform: f.platform, roomSlug: f.roomSlug });
  const derived: NotifyContext = {
    name: resolved.name,
    nameSource: resolved.source,
    ...(f.platform ? { platform: f.platform } : {}),
    ...(f.roomSlug ? { roomSlug: f.roomSlug } : {}),
  };
  // Only defined event fields win (an explicit `undefined` must not erase a derived value).
  const own = Object.fromEntries(Object.entries(e.ctx ?? {}).filter(([, v]) => v !== undefined)) as NotifyContext;
  const ctx = { ...derived, ...own };
  const isRecord = e.kind === "recordStart" || e.kind === "recordReconnect" || e.kind === "recordEnd";
  // Without any real name keep the event's own anchor text (the message already falls back to the room).
  const anchor = isRecord && resolved.source !== "fallback" ? { anchor: resolved.name } : {};
  return { ...e, ...anchor, ctx };
}

/** Every NotifyContext field, checked both ways by the compiler (missing or extra keys fail to build). */
const CTX_FIELDS = {
  name: true, nameSource: true, platform: true, roomSlug: true, date: true, time: true,
  streamKey: true, node: true, step: true, result: true, next: true,
} as const satisfies Record<keyof NotifyContext, true>;

// Allowed enum values, exhaustive at compile time (a new member must be listed here to cross a process).
const NAME_SOURCES = { task: true, live: true, cached: true, ledger: true, session: true, fallback: true } as const satisfies Record<DisplayNameSource, true>;
const RESULTS = { ok: true, warn: true, error: true } as const satisfies Record<NotifyResult, true>;

/**
 * Validate a context received over a process boundary (the recorder alert line): keep only known keys
 * with non-empty string values; the two enum fields must hold an allowed value. Anything else (a newer
 * or broken child) is dropped, never trusted.
 */
export function sanitizeNotifyContext(raw: unknown): NotifyContext | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of Object.keys(CTX_FIELDS) as (keyof NotifyContext)[]) {
    const v = src[k];
    if (typeof v !== "string" || v.length === 0) continue;
    if (k === "nameSource" && !Object.hasOwn(NAME_SOURCES, v)) continue;
    if (k === "result" && !Object.hasOwn(RESULTS, v)) continue;
    out[k] = v;
  }
  return Object.keys(out).length ? (out as NotifyContext) : undefined;
}
