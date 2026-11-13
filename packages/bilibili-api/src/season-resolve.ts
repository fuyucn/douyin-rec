/**
 * bili-season-resolve.ts — resolve the configured season number to a section id (issue #460).
 *
 * The creator center shows the SEASON id (合集 ID), while `season/section/episodes/add` needs a
 * SECTION id. The existing config key is reused unchanged (its value now means "合集 ID"; a legacy
 * section id is still accepted), so no upload call site has to change: everything happens behind
 * `addArchiveToSeasonIfConfigured`.
 *
 * Resolution of the configured number N, using the UPLOADING account's login file:
 *   1. N is one of the account's own seasons -> its single section
 *   2. else N is a section id inside one of the account's own seasons -> N as is (legacy)
 *   3. else -> definite failure (not this account's season, not its section)
 * Network / HTTP / budget failures are retryable so the next run can try again.
 *
 * Results are cached per (account, N) in memory and in a JSON file NEXT TO the login file, so no
 * caller needs to know a data root. Nothing here throws into an upload path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { biliAccountKeyFromCookiesJson, biliupCookieHeader } from "./credential.js";

const MEMBER = "https://member.bilibili.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Per-request budget for one seasons page (also the default overall budget). */
export const SEASON_RESOLVE_TIMEOUT_MS = 10_000;
/** Appended when the configured number is neither this account's season nor its section. */
export const SEASON_ID_HINT = "请确认填写的是本账号的合集 ID";
/** Account key of a login file without DedeUserID: such results are NOT cached (unattributable). */
const UNKNOWN_ACCOUNT_KEY = "bilibili:unknown";
/** File written next to the login file; keeps the cache with zero call-site plumbing. */
const CACHE_FILE = "season-cache.json";

export type SeasonSectionLookup =
  | { status: "resolved"; sectionId: number; fromCache: boolean }
  | { status: "failed"; error: string; retryable: boolean };

interface CacheEntry { sectionId: number; writtenAt: number }
type DiskCacheData = Record<string, CacheEntry>;

const memCache = new Map<string, CacheEntry>();

/** Test seam: drop every in-memory entry so cases cannot leak into each other. */
export function __resetSeasonMemCache(): void { memCache.clear(); }

function cacheKey(accountKey: string, configured: number): string {
  return accountKey + "||" + String(configured);
}

/** Cache file path for a login file (same directory). Undefined when the path has no directory. */
export function seasonCacheFile(cookiesPath: string): string | undefined {
  const dir = dirname(cookiesPath);
  return dir ? join(dir, CACHE_FILE) : undefined;
}

/** Plain, non-array objects only: a JSON `null`/array/scalar is treated as "no cache". */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Read + validate the cache file. Any malformed shape or entry is dropped, never thrown. */
function readCache(cookiesPath: string): DiskCacheData {
  const p = seasonCacheFile(cookiesPath);
  if (!p || !existsSync(p)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"));
    if (!isPlainObject(parsed)) return {};
    const out: DiskCacheData = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!isPlainObject(v)) continue;
      const sectionId = Number(v.sectionId);
      if (!Number.isSafeInteger(sectionId) || sectionId <= 0) continue;
      const writtenAt = Number(v.writtenAt);
      out[k] = { sectionId, writtenAt: Number.isFinite(writtenAt) ? writtenAt : 0 };
    }
    return out;
  } catch { return {}; }
}

/**
 * Atomic write: re-read first (another process may have written since), merge, then write a
 * pid-suffixed temp file and rename it over the target. Failures are non-fatal.
 */
function writeCache(cookiesPath: string, patch: DiskCacheData, removeKeys: readonly string[] = []): void {
  const p = seasonCacheFile(cookiesPath);
  if (!p) return;
  const tmp = p + ".tmp-" + String(process.pid);
  try {
    mkdirSync(dirname(p), { recursive: true });
    const merged = readCache(cookiesPath);
    for (const k of removeKeys) delete merged[k];
    for (const [k, v] of Object.entries(patch)) merged[k] = v;
    // Owner-only: the file sits next to the login file and holds account-scoped ids.
    writeFileSync(tmp, JSON.stringify(merged), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, p);
  } catch {
    // Cache write failure is non-fatal, but never leave a temp file behind.
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
}

/** Account key of a login file: `bilibili:<mid>`, or `bilibili:unknown` when it has no DedeUserID. */
export function seasonAccountKey(cookiesPath: string): string {
  try { return biliAccountKeyFromCookiesJson(readFileSync(cookiesPath, "utf-8")); }
  catch { return biliAccountKeyFromCookiesJson(null); }
}

/** Cached sectionId for (account, N); undefined on miss (or for an unattributable account). */
export function seasonCacheGet(accountKey: string, configured: number, cookiesPath: string): number | undefined {
  if (accountKey === UNKNOWN_ACCOUNT_KEY) return undefined;
  const k = cacheKey(accountKey, configured);
  const mem = memCache.get(k);
  if (mem) return mem.sectionId;
  const disk = readCache(cookiesPath);
  const entry = disk[k];
  if (entry && entry.sectionId > 0) {
    memCache.set(k, entry);
    return entry.sectionId;
  }
  return undefined;
}

function cacheSet(accountKey: string, configured: number, sectionId: number, cookiesPath: string): void {
  // No DedeUserID -> the entry cannot be attributed to an account, so it is never cached.
  if (accountKey === UNKNOWN_ACCOUNT_KEY) return;
  const k = cacheKey(accountKey, configured);
  const entry: CacheEntry = { sectionId, writtenAt: Date.now() };
  memCache.set(k, entry);
  writeCache(cookiesPath, { [k]: entry });
}

/**
 * Remember a section that the ADD step confirmed (added/already). Resolution itself never writes:
 * caching a section before the add succeeds would keep a rejected section around.
 */
export function rememberConfiguredSeasonSection(cookiesPath: string, configured: number, sectionId: number): void {
  cacheSet(seasonAccountKey(cookiesPath), configured, sectionId, cookiesPath);
}

/** Drop the (account, N) entry from memory and disk (called when that section is rejected). */
export function seasonCacheClear(accountKey: string, configured: number, cookiesPath: string): void {
  const k = cacheKey(accountKey, configured);
  memCache.delete(k);
  writeCache(cookiesPath, {}, [k]);
}

/** Path-only variant used by the add path (derives the account key from the login file). */
export function clearConfiguredSeasonCache(cookiesPath: string, configured: number): void {
  seasonCacheClear(seasonAccountKey(cookiesPath), configured, cookiesPath);
}

function cookieHeader(cookiesPath: string): string | null {
  try { return biliupCookieHeader(JSON.parse(readFileSync(cookiesPath, "utf-8"))); }
  catch { return null; }
}

function headers(cookie: string): Record<string, string> {
  return { Accept: "application/json", "User-Agent": USER_AGENT, Cookie: cookie, Referer: "https://member.bilibili.com/" };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const factory = (AbortSignal as unknown as { timeout?: (n: number) => AbortSignal }).timeout;
  return typeof factory === "function" ? factory(ms) : undefined;
}

async function requestJson(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ raw: Record<string, unknown>; ok: boolean; status?: number; error?: string }> {
  try {
    const res = await doFetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { raw, ok: false, status: res.status, error: "HTTP " + String(res.status) };
    return { raw, ok: true, status: res.status };
  } catch (e) {
    return { raw: {}, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

interface SeasonListItem {
  season?: { id?: unknown };
  sections?: { sections?: Array<{ id?: unknown }> };
}

/**
 * Resolve the configured number N to a section id.
 *
 * `deadlineMs` is the caller's overall budget: pagination stops (and each request is capped) once it
 * passes, so resolve + add + retry share one wall-clock limit.
 */
export async function resolveConfiguredSeasonSection(opts: {
  configured: number;
  cookiesPath: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Absolute deadline (epoch ms). */
  deadlineMs?: number;
  /** Page cap (safety + test seam). */
  maxPages?: number;
}): Promise<SeasonSectionLookup> {
  try {
    const { configured, cookiesPath } = opts;
    if (!(Number.isSafeInteger(configured) && configured > 0)) {
      return { status: "failed", error: "合集 ID 无效", retryable: false };
    }

    // Cache first: a hit issues no seasons request at all.
    const accountKey = seasonAccountKey(cookiesPath);
    const cached = seasonCacheGet(accountKey, configured, cookiesPath);
    if (cached !== undefined) return { status: "resolved", sectionId: cached, fromCache: true };

    const cookie = cookieHeader(cookiesPath);
    if (!cookie) return { status: "failed", error: "登录态不完整(缺少 Cookie)", retryable: true };

    const doFetch = opts.fetchImpl ?? fetch;
    const perRequest = opts.timeoutMs ?? SEASON_RESOLVE_TIMEOUT_MS;
    const deadline = opts.deadlineMs ?? Date.now() + perRequest;
    const maxPages = opts.maxPages ?? 100;
    const ps = 30;
    /** Section ids seen across the account's own seasons (used for the legacy check). */
    const accountSections = new Set<number>();
    /** Season ids already listed; a duplicate page must not look like progress. */
    const listedSeasons = new Set<number>();
    /** How many seasons the response reports (0 when it omits the field). */
    let reportedTotal = 0;
    /** True only once the listing is known to be complete. */
    let listingComplete = false;

    for (let pn = 1; pn <= maxPages; pn++) {
      const left = deadline - Date.now();
      if (left <= 0) break; // incomplete -> retryable below

      const url = MEMBER + "/x2/creative/web/seasons?pn=" + String(pn) + "&ps=" + String(ps);
      const r = await requestJson(doFetch, url, { headers: headers(cookie) }, Math.min(perRequest, left));
      if (!r.ok) return { status: "failed", error: "获取合集列表失败: " + (r.error ?? "unknown"), retryable: true };
      if (r.raw.code !== 0) {
        return { status: "failed", error: "获取合集列表失败:code=" + String(r.raw.code), retryable: true };
      }

      const data = (r.raw.data ?? {}) as { seasons?: SeasonListItem[]; total?: number };
      const seasons = Array.isArray(data.seasons) ? data.seasons : [];
      // A past-the-end page is empty: that is how pagination ends when `total` is unavailable.
      if (seasons.length === 0) { listingComplete = true; break; }

      const pageTotal = Number(data.total ?? 0);
      if (Number.isSafeInteger(pageTotal) && pageTotal > 0) reportedTotal = pageTotal;

      let added = 0;
      for (const item of seasons) {
        const seasonId = Number(item.season?.id ?? 0);
        if (seasonId > 0 && !listedSeasons.has(seasonId)) { listedSeasons.add(seasonId); added++; }

        const sects = Array.isArray(item.sections?.sections) ? item.sections!.sections! : [];
        for (const s of sects) {
          const id = Number(s?.id ?? 0);
          if (id > 0) accountSections.add(id);
        }
        if (seasonId !== configured) continue;

        if (sects.length === 0) {
          return { status: "failed", error: "合集 " + String(configured) + " 没有小节", retryable: false };
        }
        if (sects.length > 1) {
          return {
            status: "failed",
            error: "合集有多个小节,需指定(合集 " + String(configured) + " 有 " + String(sects.length) + " 个小节)",
            retryable: false,
          };
        }
        const sectionId = Number(sects[0]?.id ?? 0);
        if (!(sectionId > 0)) {
          return { status: "failed", error: "合集 " + String(configured) + " 的小节 ID 无效", retryable: false };
        }
        // Caller persists this only after the add confirms it.
        return { status: "resolved", sectionId, fromCache: false };
      }

      // Stop only on real completeness: the reported season count is covered, or the page brought
      // no new season ids. (A page shorter than `ps` is NOT sufficient: the server may cap `ps`.)
      if (reportedTotal > 0 && listedSeasons.size >= reportedTotal) { listingComplete = true; break; }
      if (added === 0) { listingComplete = true; break; }
    }

    // Not one of the account's seasons: a legacy section id inside one of them is still accepted.
    if (accountSections.has(configured)) {
      return { status: "resolved", sectionId: configured, fromCache: false };
    }

    if (!listingComplete) {
      // Page cap / budget ran out with pages still unread: the answer may be on one of them.
      // Retryable — never "not this account".
      return { status: "failed", error: "合集列表未读完(稍后重试)", retryable: true };
    }

    return {
      status: "failed",
      error: "合集 " + String(configured) + " 不是本账号的合集或小节;" + SEASON_ID_HINT,
      retryable: false,
    };
  } catch (e) {
    return { status: "failed", error: String((e as Error)?.message ?? e).slice(0, 200), retryable: true };
  }
}
