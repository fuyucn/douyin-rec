/**
 * bili-season-resolve.ts — resolve a Bilibili season (collection) id to its section id.
 *
 * Issue #460: the creator center only shows the SEASON id (合集 ID), not the SECTION id required by
 * `season/section/episodes/add`. This module resolves seasonId -> sectionId with the UPLOADING
 * account's own login file (GET /x2/creative/web/seasons, paginated) and caches the result per
 * (account, seasonId) in memory and on disk.
 *
 * Best effort by design: cache IO, JSON parsing and network errors all collapse into a typed
 * outcome, so nothing here can throw into an upload path.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { biliAccountKeyFromCookiesJson, biliupCookieHeader } from "./upload-gate.js";

const MEMBER = "https://member.bilibili.com";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/** Per-request budget for one seasons page. */
export const SEASON_RESOLVE_TIMEOUT_MS = 10_000;
/** Save-time hint budget: short, so a UI hint can never hang a page. */
export const SEASON_HINT_TIMEOUT_MS = 8_000;
/** Appended when a section call is rejected for good. */
export const SEASON_ID_HINT = "请确认填写的是本账号的合集 ID";
/** Account key of a login file without DedeUserID: such results must NOT be cached (unattributable). */
const UNKNOWN_ACCOUNT_KEY = "bilibili:unknown";

export type SeasonResolveOutcome =
  | { status: "resolved"; sectionId: number; seasonTitle: string; sectionTitle: string; fromCache: boolean }
  | { status: "failed"; error: string; retryable: boolean };

interface CacheEntry { sectionId: number; writtenAt: number }
type DiskCacheData = Record<string, CacheEntry>;

const memCache = new Map<string, CacheEntry>();

/** Test seam: drop every in-memory entry so cases cannot leak into each other. */
export function __resetSeasonMemCache(): void { memCache.clear(); }

function cacheKey(accountKey: string, seasonId: number): string { return accountKey + "||" + String(seasonId); }

function diskCachePath(dataRoot: string | undefined): string | undefined {
  return dataRoot ? join(dataRoot, "db", "season-id-cache.json") : undefined;
}

/** Plain, non-array objects only: a JSON `null`/array/other scalar is treated as "no cache". */
function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/** Read + validate the on-disk cache. Any malformed shape or entry is dropped, never thrown. */
function readDiskCache(dataRoot: string | undefined): DiskCacheData {
  const p = diskCachePath(dataRoot);
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
 * Atomic write: re-read the file first (another process may have written since we read it), merge,
 * then write a pid-suffixed temp file and rename it over the target. Failures are non-fatal.
 */
function writeDiskCache(dataRoot: string | undefined, patch: DiskCacheData, removeKeys: readonly string[] = []): void {
  const p = diskCachePath(dataRoot);
  if (!p) return;
  try {
    mkdirSync(join(dataRoot!, "db"), { recursive: true });
    const merged = readDiskCache(dataRoot);
    for (const k of removeKeys) delete merged[k];
    for (const [k, v] of Object.entries(patch)) merged[k] = v;
    const tmp = p + ".tmp-" + String(process.pid);
    writeFileSync(tmp, JSON.stringify(merged), "utf-8");
    renameSync(tmp, p);
  } catch { /* cache write failure is non-fatal */ }
}

/** Cached sectionId for (account, seasonId); undefined on miss (or for an unattributable account). */
export function seasonSectionCacheGet(accountKey: string, seasonId: number, dataRoot: string | undefined): number | undefined {
  if (accountKey === UNKNOWN_ACCOUNT_KEY) return undefined;
  const k = cacheKey(accountKey, seasonId);
  const mem = memCache.get(k);
  if (mem) return mem.sectionId;
  const disk = readDiskCache(dataRoot);
  const entry = disk[k];
  if (entry && entry.sectionId > 0) {
    memCache.set(k, entry);
    return entry.sectionId;
  }
  return undefined;
}

function cacheSet(accountKey: string, seasonId: number, sectionId: number, dataRoot: string | undefined): void {
  // No DedeUserID -> the entry cannot be attributed to an account, so it is never cached.
  if (accountKey === UNKNOWN_ACCOUNT_KEY) return;
  const k = cacheKey(accountKey, seasonId);
  const entry: CacheEntry = { sectionId, writtenAt: Date.now() };
  memCache.set(k, entry);
  writeDiskCache(dataRoot, { [k]: entry });
}

/** Drop one entry from memory and disk. */
export function seasonSectionCacheClear(accountKey: string, seasonId: number, dataRoot: string | undefined): void {
  const k = cacheKey(accountKey, seasonId);
  memCache.delete(k);
  writeDiskCache(dataRoot, {}, [k]);
}

/** Account key of a login file: `bilibili:<mid>`, or `bilibili:unknown` when it has no DedeUserID. */
export function seasonAccountKey(cookiesPath: string): string {
  try { return biliAccountKeyFromCookiesJson(readFileSync(cookiesPath, "utf-8")); }
  catch { return biliAccountKeyFromCookiesJson(null); }
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
  season?: { id?: unknown; title?: unknown };
  sections?: { sections?: Array<{ id?: unknown; title?: unknown }> };
}

/**
 * Scan the account's seasons (paginated) for `seasonId` and return its single section id.
 *
 * - exactly 1 section -> resolved (cached unless `noCache`)
 * - more than 1 section -> failed non-retryable (合集有多个小节,需指定)
 * - season absent from the account's list -> failed non-retryable (合集不属于当前上传账号)
 * - network / HTTP / budget exhaustion -> failed retryable
 *
 * `deadlineMs` is the caller's overall budget: pagination stops (and each request is capped) once it
 * passes, so resolve + add + retry share one wall-clock limit.
 */
export async function resolveSeasonIdToSectionId(opts: {
  seasonId: number;
  cookiesPath: string;
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Absolute deadline (epoch ms) shared with the caller's overall budget. */
  deadlineMs?: number;
  /** Page cap (safety + test seam). */
  maxPages?: number;
  /** Hint mode: read nothing, write nothing. */
  noCache?: boolean;
}): Promise<SeasonResolveOutcome> {
  const { seasonId, cookiesPath } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const perRequest = opts.timeoutMs ?? SEASON_RESOLVE_TIMEOUT_MS;
  const deadline = opts.deadlineMs ?? Date.now() + perRequest;
  const maxPages = opts.maxPages ?? 100;
  const noCache = opts.noCache === true;

  const cookie = cookieHeader(cookiesPath);
  if (!cookie) return { status: "failed", error: "登录态不完整 (缺少 Cookie)", retryable: true };
  const accountKey = seasonAccountKey(cookiesPath);

  const ps = 30;
  for (let pn = 1; pn <= maxPages; pn++) {
    const left = deadline - Date.now();
    if (left <= 0) return { status: "failed", error: "解析合集超时(预算耗尽)", retryable: true };
    const url = MEMBER + "/x2/creative/web/seasons?pn=" + String(pn) + "&ps=" + String(ps);
    const r = await requestJson(doFetch, url, { headers: headers(cookie) }, Math.min(perRequest, left));
    if (!r.ok) return { status: "failed", error: "获取合集列表失败: " + (r.error ?? "unknown"), retryable: true };
    if (r.raw.code !== 0) return { status: "failed", error: "获取合集列表失败:code=" + String(r.raw.code), retryable: true };

    const data = (r.raw.data ?? {}) as { seasons?: SeasonListItem[]; total?: number };
    const seasons = data.seasons ?? [];
    for (const item of seasons) {
      const id = Number(item.season?.id ?? 0);
      if (id !== seasonId) continue;
      const seasonTitle = String(item.season?.title ?? "");
      const sects = item.sections?.sections ?? [];
      if (sects.length === 0) {
        return { status: "failed", error: "合集 " + String(seasonId) + " 没有小节", retryable: false };
      }
      if (sects.length > 1) {
        return {
          status: "failed",
          error: "合集有多个小节,需指定(合集 " + String(seasonId) + " 有 " + String(sects.length) + " 个小节)",
          retryable: false,
        };
      }
      const sectionId = Number(sects[0]!.id ?? 0);
      if (!(sectionId > 0)) {
        return { status: "failed", error: "合集 " + String(seasonId) + " 的小节 ID 无效", retryable: false };
      }
      if (!noCache) cacheSet(accountKey, seasonId, sectionId, opts.dataRoot);
      return { status: "resolved", sectionId, seasonTitle, sectionTitle: String(sects[0]!.title ?? ""), fromCache: false };
    }

    const total = Number(data.total ?? 0);
    if (seasons.length < ps || (total > 0 && pn * ps >= total)) break;
  }
  return {
    status: "failed",
    error: "合集 " + String(seasonId) + " 不属于当前上传账号;" + SEASON_ID_HINT,
    retryable: false,
  };
}

/**
 * Cache-first lookup. A cache hit issues no request and reports `fromCache: true` so callers can
 * decide whether a later definite rejection is worth a re-resolve.
 */
export async function resolveSectionIdFromSeasonId(opts: {
  seasonId: number;
  cookiesPath: string;
  dataRoot?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  deadlineMs?: number;
  noCache?: boolean;
}): Promise<SeasonResolveOutcome> {
  if (opts.noCache !== true) {
    const cached = seasonSectionCacheGet(seasonAccountKey(opts.cookiesPath), opts.seasonId, opts.dataRoot);
    if (cached !== undefined) {
      return { status: "resolved", sectionId: cached, seasonTitle: "", sectionTitle: "", fromCache: true };
    }
  }
  return resolveSeasonIdToSectionId(opts);
}

/** Drop the cache entry for a login file's account + seasonId (called on a definite rejection). */
export function clearSeasonIdCachePath(cookiesPath: string, seasonId: number, dataRoot: string | undefined): void {
  seasonSectionCacheClear(seasonAccountKey(cookiesPath), seasonId, dataRoot);
}

/**
 * Save-time, non-blocking master hint. Never throws and never persists anything (no cache read, no
 * cache write), so it cannot influence the authoritative resolution on the recording node.
 * Distinct messages for "has multiple sections" / "cannot verify" vs "not in this account".
 */
export async function hintSeasonTitleForMaster(opts: {
  seasonId: number;
  cookiesPath: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const notFound = "master 账号下没有该合集,将由录制节点用自己的账号获取";
  const unavailable = "master 账号暂时无法验证该合集(网络或登录态),将由录制节点用自己的账号获取";
  const ambiguous = "该合集有多个小节,无法自动确定;将由录制节点用自己的账号获取";
  try {
    const r = await resolveSectionIdFromSeasonId({
      seasonId: opts.seasonId,
      cookiesPath: opts.cookiesPath,
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      noCache: true,
      timeoutMs: SEASON_HINT_TIMEOUT_MS,
      deadlineMs: Date.now() + SEASON_HINT_TIMEOUT_MS,
    });
    if (r.status === "resolved") {
      const section = r.sectionTitle || "小节 " + String(r.sectionId);
      return r.seasonTitle ? r.seasonTitle + " / " + section : section;
    }
    if (/多个小节/.test(r.error)) return ambiguous;
    if (r.retryable) return unavailable;
    return notFound;
  } catch {
    return unavailable;
  }
}

// ── config precedence ────────────────────────────────────────────────────────

/** Normalize a configured season/section id: positive safe integer (numeric strings accepted). */
export function normalizeSeasonValue(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

export type SeasonTarget =
  | { kind: "seasonId"; seasonId: number }
  | { kind: "sectionId"; sectionId: number };

/**
 * The single precedence rule for the two season config keys (issue #460), used by every config
 * reader (CLI global config, CLI per-rule config, rolling upload):
 *
 *   rule.seasonId (null = explicit off)
 * > rule.seasonSectionId (null = explicit off)
 * > defaults.seasonId
 * > defaults.seasonSectionId
 *
 * A rule-level `seasonSectionId` (a number OR an explicit null) therefore blocks an INHERITED
 * default `seasonId`. Returns undefined when no season is configured.
 */
export function resolveSeasonTarget(
  ruleSeasonId: unknown,
  ruleSeasonSectionId: unknown,
  defaultSeasonId: unknown,
  defaultSeasonSectionId: unknown,
): SeasonTarget | undefined {
  const fromRuleSeason = normalizeSeasonValue(ruleSeasonId);
  if (fromRuleSeason !== undefined) return { kind: "seasonId", seasonId: fromRuleSeason };
  if (ruleSeasonId === null) return undefined;

  const fromRuleSection = normalizeSeasonValue(ruleSeasonSectionId);
  if (fromRuleSection !== undefined) return { kind: "sectionId", sectionId: fromRuleSection };
  if (ruleSeasonSectionId === null) return undefined;

  const fromDefaultSeason = normalizeSeasonValue(defaultSeasonId);
  if (fromDefaultSeason !== undefined) return { kind: "seasonId", seasonId: fromDefaultSeason };

  const fromDefaultSection = normalizeSeasonValue(defaultSeasonSectionId);
  if (fromDefaultSection !== undefined) return { kind: "sectionId", sectionId: fromDefaultSection };

  return undefined;
}
