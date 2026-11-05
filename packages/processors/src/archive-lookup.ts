/**
 * Archive lookup for archive proof (plan 038 T07).
 *
 * biliup exposes three separate state filters, so the finder queries all three and unions them.
 * Production list output is tab-separated text preceded by a colored log line, while show output
 * supplies creation time and duration for exact-title candidates. A failed or unparsable query
 * returns unknown; absent hits are also unknown unless a caller explicitly opts into trusting
 * the negative result. Bilibili data is delayed, so only positive evidence is reliable by default.
 */
import { spawn } from "node:child_process";

export interface ArchiveHit {
  bv: string;
  title: string;
  createdAt?: number;
  durationSec?: number;
  parts?: number;
}

export type ArchiveLookup = "yes" | "no" | "unknown";

export interface ArchiveQuery {
  /** Injected for tests; default runs the biliup CLI. */
  run?: (argv: string[]) => Promise<string>;
  /** How far back to look; default 48h. */
  windowMs?: number;
  now?: () => number;
  /** Explicit opt-in to treat an absent archive as proof that no archive exists. Default false. */
  trustNo?: boolean;
  /** Diagnostic log. Default writes to stderr. */
  log?: (message: string) => void;
}

const FILTERS = ["--is-pubing", "--pubed", "--not-pubed"] as const;
const MAX_DETAIL_QUERIES = 3;
const ANSI_ESCAPE = String.fromCharCode(27);
const ANSI_RE = new RegExp(ANSI_ESCAPE + "\\[[0-?]*[ -/]*[@-~]", "g");
const BV_RE = /^BV[0-9A-Za-z]{10}$/;
const LIST_LOG_RE = /^\d{4}-\d{2}-\d{2}T\S+\s+(?:INFO|WARN|ERROR|DEBUG|TRACE)\s+biliup_cli::/;

const logDiagnostic = (q: ArchiveQuery, message: string): void => {
  try {
    (q.log ?? ((line: string): void => console.error(line)))(message);
  } catch {
    // Logging must never change the lookup result.
  }
};

const stripAnsi = (text: string): string => text.replace(ANSI_RE, "");

const positiveNumber = (value: unknown): number | undefined => {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
};

const createdAtOf = (value: unknown): number | undefined => {
  const number = positiveNumber(value);
  return number === undefined ? undefined : number < 1e12 ? number * 1000 : number;
};

const nestedObject = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;

const jsonHit = (row: unknown): ArchiveHit | null => {
  const record = nestedObject(row);
  if (!record) return null;
  const archive = nestedObject(record.archive);
  const bv = String(record.bvid ?? record.bv ?? archive?.bvid ?? archive?.bv ?? "");
  if (!BV_RE.test(bv)) return null;
  const pages = record.pages ?? archive?.pages;
  return {
    bv,
    title: String(record.title ?? archive?.title ?? ""),
    createdAt: createdAtOf(record.createdAt ?? record.ctime ?? record.pubtime ?? archive?.ctime),
    durationSec: positiveNumber(record.duration ?? archive?.duration),
    parts: Array.isArray(pages) ? pages.length : positiveNumber(record.videos ?? archive?.videos),
  };
};

/** Parse one biliup list output page; null means no known structure was recognizable. */
export function parseArchiveList(out: string): ArchiveHit[] | null {
  const text = stripAnsi(out).trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const textRows = lines.flatMap((line) => {
    const match = /^(BV[0-9A-Za-z]{10})\t([^\t]*)\t([^\t]*)(?:\t|$)/.exec(line);
    return match ? [{ bv: match[1]!, title: match[2]!.trim() }] : [];
  });
  if (textRows.length > 0) {
    const seen = new Set<string>();
    return textRows
      .filter((row) => (seen.has(row.bv) ? false : (seen.add(row.bv), true)))
      .map((row) => ({ ...row }));
  }
  if (lines.every((line) => line.trim() === "" || LIST_LOG_RE.test(line))) return [];
  const jsonStart = text.search(/^[\t ]*[\[{]/m);
  if (jsonStart < 0) return null;
  try {
    const value = JSON.parse(text.slice(jsonStart)) as unknown;
    const object = nestedObject(value);
    const data = object?.data;
    const rows = Array.isArray(value) ? value
      : Array.isArray(data) ? data
        : nestedObject(data)?.list ?? object?.list;
    if (!Array.isArray(rows)) return null;
    return rows.map(jsonHit).filter((row): row is ArchiveHit => row !== null);
  } catch {
    return null;
  }
}

/** Parse biliup show <BV> output; its JSON object follows a colored log line. */
export function parseArchiveShow(out: string): ArchiveHit | null {
  const text = stripAnsi(out);
  const start = text.search(/^[\t ]*\{/m);
  if (start < 0) return null;
  try {
    const object = nestedObject(JSON.parse(text.slice(start)) as unknown);
    const archive = nestedObject(object?.archive);
    if (!archive) return null;
    const bv = String(archive.bvid ?? archive.bv ?? object?.bvid ?? object?.bv ?? "");
    if (!BV_RE.test(bv)) return null;
    const pages = archive.pages ?? archive.videos;
    return {
      bv,
      title: String(archive.title ?? ""),
      createdAt: createdAtOf(archive.ctime ?? archive.pubtime ?? archive.createdAt),
      durationSec: positiveNumber(archive.duration),
      parts: Array.isArray(pages) ? pages.length : positiveNumber(archive.videos),
    };
  } catch {
    return null;
  }
}

const defaultRun = (cookiesPath: string) => (argv: string[]): Promise<string> => new Promise((resolve, reject) => {
  const child = spawn("biliup", ["-u", cookiesPath, ...argv]);
  let out = "", err = "";
  child.stdout.on("data", (chunk: Buffer) => { out += String(chunk); });
  child.stderr.on("data", (chunk: Buffer) => { err += String(chunk); });
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolve(out) : reject(new Error("biliup " + (argv[0] ?? "command") + " rc=" + code + ": " + err.slice(-500))));
});

/** Query all three states; null on any failure or unrecognized output. */
export async function listAllArchives(cookiesPath: string, q: ArchiveQuery = {}): Promise<ArchiveHit[] | null> {
  const run = q.run ?? defaultRun(cookiesPath);
  const all: ArchiveHit[] = [];
  for (const filter of FILTERS) {
    let out: string;
    try { out = await run(["list", filter, "-m", "3"]); }
    catch (error) {
      logDiagnostic(q, "[archive-lookup] " + filter + " query failed: " + String((error as Error)?.message ?? error));
      return null;
    }
    const parsed = parseArchiveList(out);
    if (parsed === null) {
      logDiagnostic(q, "[archive-lookup] " + filter + " output has no recognized archive structure; treating as unknown");
      return null;
    }
    all.push(...parsed);
  }
  const seen = new Set<string>();
  return all.filter((h) => (seen.has(h.bv) ? false : (seen.add(h.bv), true)));
}

/** Title key that survives server-side rewrites: NFKC, case-folded, letters and digits only. */
export function looseTitleKey(title: string): string {
  return title.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Compare a candidate against an expected duration; tolerance is max(60s, 2%). */
export function durationMatches(hit: ArchiveHit, expectedSec: number): boolean {
  if (!hit.durationSec || !(expectedSec > 0)) return false;
  return Math.abs(hit.durationSec - expectedSec) <= Math.max(60, expectedSec * 0.02);
}

/** Read details for exact-title candidates, bounded to avoid a large list causing a show storm. */
async function withDetails(
  cookiesPath: string,
  candidates: ArchiveHit[],
  q: ArchiveQuery,
): Promise<ArchiveHit[] | null> {
  const run = q.run ?? defaultRun(cookiesPath);
  const detailed: ArchiveHit[] = [];
  for (const candidate of candidates.slice(0, MAX_DETAIL_QUERIES)) {
    const hasWindow = candidate.createdAt !== undefined;
    const hasDuration = candidate.durationSec !== undefined;
    if (hasWindow && hasDuration) {
      detailed.push(candidate);
      continue;
    }
    let out: string;
    try { out = await run(["show", candidate.bv]); }
    catch (error) {
      logDiagnostic(q, "[archive-lookup] show failed: " + String((error as Error)?.message ?? error));
      return null;
    }
    const detail = parseArchiveShow(out);
    if (!detail) {
      logDiagnostic(q, "[archive-lookup] show output has no recognized archive structure; treating as unknown");
      return null;
    }
    if (detail.bv !== candidate.bv || detail.title.trim() !== candidate.title.trim()) {
      logDiagnostic(q, "[archive-lookup] show output does not match its candidate; treating as unknown");
      return null;
    }
    detailed.push({
      ...candidate,
      ...detail,
      bv: candidate.bv,
      title: candidate.title,
      createdAt: detail.createdAt ?? candidate.createdAt,
      durationSec: detail.durationSec ?? candidate.durationSec,
      parts: detail.parts ?? candidate.parts,
    });
  }
  return [...detailed, ...candidates.slice(MAX_DETAIL_QUERIES)];
}

/**
 * Proof used before any transfer retry: does an archive with this title already exist in the window?
 * Returns unknown whenever a query fails, a title match cannot be disambiguated, or a negative
 * result is not explicitly trusted. Bilibili data is delayed; only positive evidence is reliable.
 */
export async function findRecentArchive(
  cookiesPath: string,
  title: string,
  expectedDurationSec: number,
  q: ArchiveQuery = {},
): Promise<ArchiveLookup> {
  if (!title.trim()) return "unknown";
  const hits = await listAllArchives(cookiesPath, q);
  if (hits === null) return "unknown";
  const now = (q.now ?? Date.now)();
  const windowMs = q.windowMs ?? 48 * 3600_000;
  const exactTitle = title.trim();
  const sameTitle = hits.filter((hit) => hit.title.trim() === exactTitle);
  const otherTitle = hits.filter((hit) => hit.title.trim() !== exactTitle);
  const detailed = sameTitle.length > 0 ? await withDetails(cookiesPath, sameTitle, q) : [];
  if (detailed === null) return "unknown";
  const detailedRecent = detailed.filter((hit) => hit.createdAt === undefined
    || (now - hit.createdAt >= 0 && now - hit.createdAt <= windowMs));
  const key = looseTitleKey(title);
  const looseMatch = otherTitle.some((hit) => looseTitleKey(hit.title) === key);
  if (sameTitle.length === 0) {
    // Bilibili may normalize emoji / full-width characters in stored titles. A loose-only match could be
    // our own archive under a rewritten title, so never answer "no" for it (that would re-upload).
    if (looseMatch) return "unknown";
    if (q.trustNo !== true) {
      logDiagnostic(q, "proof would be: no(未启用)");
      return "unknown";
    }
    return "no";
  }
  if (detailedRecent.some((hit) => durationMatches(hit, expectedDurationSec))) return "yes";
  // Title matches but duration or creation time cannot prove this is the same session.
  return "unknown";
}
