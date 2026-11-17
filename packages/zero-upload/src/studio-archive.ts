import { UA, controlSignal, cookieHeaderOrThrow } from "./upos-http.js";

/** A confirmed part as returned by the authenticated member archive endpoint. */
export interface StudioVideo {
  cid?: string | number;
  filename: string;
  title?: string;
  desc?: string;
}

/** Metadata needed to edit an archive without dropping any earlier part. */
export interface StudioArchive {
  aid: number;
  bvid?: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  private: boolean;
  videos: StudioVideo[];
}

export interface LookupArchiveResult {
  ok: boolean;
  archive?: StudioArchive;
  raw: Record<string, unknown>;
}

export interface FindArchiveResult {
  ok: boolean;
  archive?: StudioArchive;
  /** Exact or prefix-overlapping candidates; more than one is ambiguous. */
  matches: number;
  /** Distinguishes a successful empty search from an unavailable list endpoint. */
  searched?: boolean;
  raw: Record<string, unknown>;
}

function archiveFromViewData(data: unknown): StudioArchive | null {
  const root = data as {
    archive?: Record<string, unknown>;
    videos?: Array<Record<string, unknown>>;
  } | null;
  const a = root?.archive;
  if (!a) return null;
  const aid = Number(a.aid);
  const title = String(a.title ?? "").trim();
  const tid = Number(a.tid);
  if (!(aid > 0) || !title || !(tid > 0)) return null;
  const videos: StudioVideo[] = [];
  for (const v of root.videos ?? []) {
    const filename = String(v.filename ?? "").trim();
    if (!filename) continue;
    const cid = Number(v.cid);
    videos.push({
      ...(cid > 0 ? { cid } : {}),
      filename,
      ...(typeof v.title === "string" && v.title ? { title: v.title } : {}),
      ...(typeof v.desc === "string" && v.desc ? { desc: v.desc } : {}),
    });
  }
  const tag = String(a.tag ?? "").trim();
  const desc = typeof a.desc === "string" ? a.desc : undefined;
  return {
    aid,
    ...(typeof a.bvid === "string" && a.bvid ? { bvid: a.bvid } : {}),
    title,
    tid,
    tag,
    ...(desc ? { desc } : {}),
    private: Number(a.is_only_self ?? 0) !== 0,
    videos,
  };
}

// Authenticated endpoints also see private/auditing drafts that public archive APIs cannot.
// Transport failure may try the compatible endpoint; caller cancellation must never fall through.
export async function lookupArchive(o: {
  cookiesPath: string;
  bvid?: string;
  aid?: number;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<LookupArchiveResult> {
  o.signal?.throwIfAborted();
  const doFetch = o.fetchImpl ?? fetch;
  const cookie = cookieHeaderOrThrow(o.cookiesPath);
  const vid = o.aid && o.aid > 0 ? `aid=${o.aid}` : o.bvid ? `bvid=${encodeURIComponent(o.bvid)}` : "";
  if (!vid) throw new Error("lookupArchive 需要 bvid 或 aid");
  const endpoints = [
    `https://member.bilibili.com/x/vupre/web/archive/view?${vid}`,
    `https://member.bilibili.com/x/client/archive/view?${vid}`,
  ];
  let lastRaw: Record<string, unknown> = {};
  let transportFailures = 0;
  for (const url of endpoints) {
    o.signal?.throwIfAborted();
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://member.bilibili.com/" },
        signal: controlSignal(o.signal),
      });
    } catch {
      o.signal?.throwIfAborted();
      transportFailures++;
      continue;
    }
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    o.signal?.throwIfAborted();
    lastRaw = raw;
    if (res.ok && raw.code === 0) {
      const archive = archiveFromViewData(raw.data);
      if (archive) return { ok: true, archive, raw };
    }
  }
  if (transportFailures === endpoints.length) {
    return { ok: false, raw: { error: "archive view transport failed" } };
  }
  return { ok: false, raw: lastRaw };
}

interface ArchiveSummary {
  aid: number;
  bvid?: string;
  title: string;
}

function archiveSummaries(data: unknown): ArchiveSummary[] {
  const out: ArchiveSummary[] = [];
  for (const row of archiveSummaryRows(data)) {
    const aid = Number(row.aid);
    const title = String(row.title ?? "").trim();
    if (!(aid > 0) || !title) continue;
    out.push({
      aid,
      ...(typeof row.bvid === "string" && row.bvid ? { bvid: row.bvid } : {}),
      title,
    });
  }
  return out;
}

/** The member API uses both flat archives and nested audit records. */
function archiveSummaryRows(data: unknown): Array<Record<string, unknown>> {
  const d = data as {
    archives?: Array<Record<string, unknown>>;
    arc_audits?: Array<Record<string, unknown> & { Archive?: Record<string, unknown> }>;
  } | null;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of d?.archives ?? []) rows.push(row);
  for (const row of d?.arc_audits ?? []) {
    if (row.Archive && typeof row.Archive === "object") rows.push(row.Archive);
    else rows.push(row);
  }
  return rows;
}

/** Recover only one exact title; prefix collisions remain ambiguous rather than guessed. */
export async function findArchiveByTitle(o: {
  cookiesPath: string;
  title: string;
  fetchImpl?: typeof fetch;
}): Promise<FindArchiveResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const cookie = cookieHeaderOrThrow(o.cookiesPath);
  const wanted = o.title.trim();
  if (!wanted) return { ok: false, matches: 0, raw: { error: "empty title" } };
  const summaries = new Map<number, ArchiveSummary>();
  let lastRaw: Record<string, unknown> = {};
  let successfulLookups = 0;
  for (const status of ["is_only_self", "all"]) {
    let res: Response;
    try {
      res = await doFetch(`https://member.bilibili.com/x/web/archives?status=${status}&pn=1`, {
        headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://member.bilibili.com/" },
        signal: controlSignal(),
      });
    } catch {
      continue;
    }
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    lastRaw = raw;
    if (!res.ok || raw.code !== 0) continue;
    successfulLookups++;
    for (const s of archiveSummaries(raw.data)) {
      if (s.title === wanted || s.title.startsWith(wanted) || wanted.startsWith(s.title)) {
        summaries.set(s.aid, s);
      }
    }
  }
  if (successfulLookups === 0) {
    return { ok: false, matches: 0, searched: false, raw: { ...lastRaw, reason: "archive list unavailable" } };
  }
  const matches = [...summaries.values()];
  if (matches.length !== 1) {
    return { ok: false, matches: matches.length, searched: true, raw: lastRaw };
  }
  if (matches[0]!.title !== wanted) {
    return { ok: false, matches: 1, searched: true, raw: { ...lastRaw, reason: "title differs after normalization" } };
  }
  const found = await lookupArchive({
    cookiesPath: o.cookiesPath,
    aid: matches[0]!.aid,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  return { ok: found.ok, ...(found.archive ? { archive: found.archive } : {}), matches: 1, searched: true, raw: found.raw };
}
