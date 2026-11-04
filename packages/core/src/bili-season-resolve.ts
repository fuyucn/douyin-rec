import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { biliAccountKeyFromCookiesJson, biliupCookieHeader } from "./upload-gate.js";

const MEMBER = "https://member.bilibili.com";
export const SEASON_RESOLVE_TIMEOUT_MS = 10_000;
export const SEASON_ID_HINT = "请确认填写的是本账号的合集 ID";

export type SeasonResolveOutcome =
  | { status: "resolved"; sectionId: number; seasonTitle: string; sectionTitle: string }
  | { status: "failed"; error: string; retryable: boolean };

interface CacheEntry { sectionId: number; writtenAt: number }
type DiskCacheData = Record<string, CacheEntry>;
const memCache = new Map();

function cacheKey(accountKey: string, seasonId: number): string { return accountKey + "||" + String(seasonId); }
function diskCachePath(dataRoot: string | undefined): string | undefined { return dataRoot ? join(dataRoot, "db", "season-id-cache.json") : undefined; }

function readDiskCache(dataRoot: string | undefined): DiskCacheData {
  const p = diskCachePath(dataRoot);
  if (!p || !existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, "utf-8")) as DiskCacheData; }
  catch { return {}; }
}

function writeDiskCache(dataRoot: string | undefined, data: DiskCacheData): void {
  const p = diskCachePath(dataRoot);
  if (!p) return;
  try { mkdirSync(join(dataRoot!, "db"), { recursive: true }); writeFileSync(p, JSON.stringify(data), "utf-8"); }
  catch { /* non-fatal */ }
}

export function seasonSectionCacheGet(accountKey: string, seasonId: number, dataRoot: string | undefined): number | undefined {
  const k = cacheKey(accountKey, seasonId);
  const m = memCache.get(k);
  if (m) return m.sectionId;
  const d = readDiskCache(dataRoot);
  const e = d[k];
  if (e && typeof e.sectionId === "number" && e.sectionId > 0) { memCache.set(k, e); return e.sectionId; }
  return undefined;
}

function cacheSet(accountKey: string, seasonId: number, sectionId: number, dataRoot: string | undefined): void {
  const k = cacheKey(accountKey, seasonId);
  const entry: CacheEntry = { sectionId, writtenAt: Date.now() };
  memCache.set(k, entry);
  const disk = readDiskCache(dataRoot);
  disk[k] = entry;
  writeDiskCache(dataRoot, disk);
}

export function seasonSectionCacheClear(accountKey: string, seasonId: number, dataRoot: string | undefined): void {
  const k = cacheKey(accountKey, seasonId);
  memCache.delete(k);
  const disk = readDiskCache(dataRoot);
  if (k in disk) { delete disk[k]; writeDiskCache(dataRoot, disk); }
}

export function seasonAccountKey(cookiesPath: string): string {
  try { return biliAccountKeyFromCookiesJson(readFileSync(cookiesPath, "utf-8")); }
  catch { return biliAccountKeyFromCookiesJson(null); }
}

function cookieHeader(cookiesPath: string): string | null {
  try { return biliupCookieHeader(JSON.parse(readFileSync(cookiesPath, "utf-8"))); }
  catch { return null; }
}

function headers(cookie: string): Record<string, string> {
  return { Accept: "application/json", "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36", Cookie: cookie, Referer: "https://member.bilibili.com/" };
}

function timeoutSignal(ms: number): AbortSignal | undefined {
  const factory = (AbortSignal as any).timeout;
  return typeof factory === "function" ? factory(ms) : undefined;
}

async function requestJson(doFetch: typeof fetch, url: string, init: RequestInit, timeoutMs: number): Promise<{ raw: Record<string, unknown>; ok: boolean; status?: number; error?: string }> {
  try {
    const res = await doFetch(url, { ...init, signal: timeoutSignal(timeoutMs) });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) return { raw, ok: false, status: res.status, error: "HTTP " + String(res.status) };
    return { raw, ok: true, status: res.status };
  } catch (e) { return { raw: {}, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) }; }
}

interface SeasonListItem { season?: { id?: unknown; title?: unknown }; sections?: { sections?: Array<{ id?: unknown; title?: unknown }> } }
export async function resolveSeasonIdToSectionId(opts: {
  seasonId: number; cookiesPath: string; dataRoot?: string; fetchImpl?: typeof fetch; timeoutMs?: number; maxPages?: number;
}): Promise<SeasonResolveOutcome> {
  const { seasonId, cookiesPath } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? SEASON_RESOLVE_TIMEOUT_MS;
  const maxPages = opts.maxPages ?? 100;
  const cookie = cookieHeader(cookiesPath);
  if (!cookie) return { status: "failed", error: "登录态不完整 (缺少 Cookie)", retryable: true };
  const accountKey = seasonAccountKey(cookiesPath);
  const ps = 30;
  for (let pn = 1; pn <= maxPages; pn++) {
    const url = MEMBER + "/x2/creative/web/seasons?pn=" + String(pn) + "&ps=" + String(ps);
    const r = await requestJson(doFetch, url, { headers: headers(cookie) }, timeoutMs);
    if (!r.ok) return { status: "failed", error: "获取合集列表失败：" + (r.error ?? "unknown"), retryable: true };
    if (r.raw.code !== 0) return { status: "failed", error: "获取合集列表失败：code=" + String(r.raw.code), retryable: true };
    const data = (r.raw.data ?? {}) as { seasons?: SeasonListItem[]; total?: number };
    const seasons = data.seasons ?? [];
    for (const item of seasons) {
      const id = Number(item.season?.id ?? 0);
      if (id !== seasonId) continue;
      const seasonTitle = String(item.season?.title ?? "");
      const sects = item.sections?.sections ?? [];
      if (sects.length === 0) return { status: "failed", error: "合集 " + String(seasonId) + " 没有小节", retryable: false };
      if (sects.length > 1) return { status: "failed", error: "合集有多个小节，需指定 (合集 " + String(seasonId) + " 有 " + String(sects.length) + " 个小节)", retryable: false };
      const sectionId = Number(sects[0]!.id ?? 0);
      if (!(sectionId > 0)) return { status: "failed", error: "合集 " + String(seasonId) + " 的小节 ID 无效", retryable: false };
      cacheSet(accountKey, seasonId, sectionId, opts.dataRoot);
      return { status: "resolved", sectionId, seasonTitle, sectionTitle: String(sects[0]!.title ?? "") };
    }
    const total = Number(data.total ?? 0);
    if (seasons.length < ps || (total > 0 && pn * ps >= total)) break;
  }
  return { status: "failed", error: "合集 " + String(seasonId) + " 不属于当前上传账号;" + SEASON_ID_HINT, retryable: false };
}

export async function resolveSectionIdFromSeasonId(opts: {
  seasonId: number; cookiesPath: string; dataRoot?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<{ sectionId: number } | { status: "failed"; error: string; retryable: boolean }> {
  const cached = seasonSectionCacheGet(seasonAccountKey(opts.cookiesPath), opts.seasonId, opts.dataRoot);
  if (cached !== undefined) return { sectionId: cached };
  const result = await resolveSeasonIdToSectionId(opts);
  if (result.status !== "resolved") return result;
  return { sectionId: result.sectionId };
}

export function clearSeasonIdCachePath(cookiesPath: string, seasonId: number, dataRoot: string | undefined): void {
  seasonSectionCacheClear(seasonAccountKey(cookiesPath), seasonId, dataRoot);
}

export async function hintSeasonTitleForMaster(opts: {
  seasonId: number; cookiesPath: string; dataRoot?: string; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<string> {
  const fallback = "master 账号下没有该合集，将由录制节点用自己的账号获取";
  try {
    const r = await resolveSeasonIdToSectionId(opts);
    if (r.status === "resolved") {
      const section = r.sectionTitle || "小节 " + String(r.sectionId);
      return r.seasonTitle ? r.seasonTitle + " / " + section : section;
    }
    return fallback;
  } catch { return fallback; }
}

