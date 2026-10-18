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
  /** Pipeline step (e.g. merge, upload). */
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
