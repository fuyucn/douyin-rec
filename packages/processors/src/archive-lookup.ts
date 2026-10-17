/**
 * Archive lookup for no-draft proof (plan 038 T07).
 *
 * biliup exposes three separate state filters (in review / published / rejected), so the finder
 * queries all three and unions them. Any failed or unparsable query returns `unknown` — callers
 * must never treat `unknown` as "no draft exists".
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
}

const FILTERS = ["--is-pubing", "--pubed", "--not-pubed"] as const;

/** Parse one `biliup list` output page. Returns null when the JSON shape is not understood. */
export function parseArchiveList(out: string): ArchiveHit[] | null {
  const text = out.trim();
  if (!text) return [];
  try {
    const v = JSON.parse(text) as unknown;
    const direct = Array.isArray(v) ? v : null;
    const data = (!direct && v && typeof v === "object" ? (v as { data?: unknown }).data : undefined);
    const rows = direct ?? (Array.isArray(data) ? data : (data as { list?: unknown } | undefined)?.list);
    if (!Array.isArray(rows)) return null;
    const hits: ArchiveHit[] = [];
    for (const row of rows) {
      const r = row as Record<string, unknown>;
      const bv = String(r.bvid ?? r.bv ?? "");
      if (!/^BV[0-9A-Za-z]{10}$/.test(bv)) continue;
      hits.push({
        bv,
        title: String(r.title ?? ""),
        createdAt: (() => { const n = Number(r.createdAt ?? r.ctime ?? r.pubtime ?? 0); return n > 0 ? (n < 1e12 ? n * 1000 : n) : undefined; })(),
        durationSec: Number(r.duration ?? 0) || undefined,
        parts: Array.isArray(r.pages) ? r.pages.length : Number(r.videos ?? 0) || undefined,
      });
    }
    return hits;
  } catch {
    return null;
  }
}

const defaultRun = (cookiesPath: string) => (argv: string[]): Promise<string> => new Promise((resolve, reject) => {
  const p = spawn("biliup", ["-u", cookiesPath, ...argv]);
  let out = "", err = "";
  p.stdout.on("data", (c: Buffer) => { out += String(c); });
  p.stderr.on("data", (c: Buffer) => { err += String(c); });
  p.on("error", reject);
  p.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`biliup list rc=${code}: ${err.slice(-500)}`)));
});

/** Query all three states; `unknown` on any failure. */
export async function listAllArchives(cookiesPath: string, q: ArchiveQuery = {}): Promise<ArchiveHit[] | null> {
  const run = q.run ?? defaultRun(cookiesPath);
  const all: ArchiveHit[] = [];
  for (const filter of FILTERS) {
    let out: string;
    try { out = await run(["list", filter, "-m", "3"]); } catch { return null; }
    const parsed = parseArchiveList(out);
    if (parsed === null) return null;
    all.push(...parsed);
  }
  const seen = new Set<string>();
  return all.filter((h) => (seen.has(h.bv) ? false : (seen.add(h.bv), true)));
}

/** Compare a candidate against an expected duration; tolerance is max(60s, 2%). */
export function durationMatches(hit: ArchiveHit, expectedSec: number): boolean {
  if (!hit.durationSec || !(expectedSec > 0)) return false;
  return Math.abs(hit.durationSec - expectedSec) <= Math.max(60, expectedSec * 0.02);
}

/**
 * Proof used before any transfer retry: does an archive with this title already exist in the window?
 * `unknown` whenever a query fails or a title match cannot be disambiguated.
 */
export async function findRecentArchive(
  cookiesPath: string,
  title: string,
  expectedDurationSec: number,
  q: ArchiveQuery = {},
): Promise<ArchiveLookup> {
  if (!title.trim()) return "unknown";
  const hits = await listAllArchives(cookiesPath, { ...q, now: q.now });
  if (hits === null) return "unknown";
  const now = (q.now ?? Date.now)();
  const windowMs = q.windowMs ?? 48 * 3600_000;
  const recent = hits.filter((h) => h.createdAt == null || now - h.createdAt <= windowMs);
  const sameTitle = recent.filter((h) => h.title.trim() === title.trim());
  if (sameTitle.length === 0) return "no";
  if (sameTitle.some((h) => durationMatches(h, expectedDurationSec))) return "yes";
  // Title matches but duration does not: we cannot tell whether this is the same session.
  return "unknown";
}
