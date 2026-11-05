/**
 * bili-season.ts — add an already submitted archive to a Bilibili season section.
 *
 * Bilibili's normal submit request has no season field; only paid seasons carry one. The creator
 * center therefore submits first and then calls `season/section/episodes/add`. This module mirrors
 * that flow. The first part's cid is resolved through the creator-center view endpoint on purpose:
 * the public view endpoint answers -404 while a draft is still under review, and this project
 * uploads private drafts by default, so the season call runs exactly in that window.
 */
import { readFileSync } from "node:fs";
import { biliupCookieHeader, biliupCsrf } from "./upload-gate.js";
import {
  SEASON_ID_HINT,
  clearSeasonIdCachePath,
  normalizeSeasonValue,
  resolveSectionIdFromSeasonId,
} from "./bili-season-resolve.js";

/** Normalize a configured section id (alias of the resolver's helper; one rule, one place). */
export { normalizeSeasonValue as normalizeSeasonSectionId };
/** Local alias so this module's own call sites read the same as the public name. */
const normalizeSeasonSectionId = normalizeSeasonValue;

const MEMBER = "https://member.bilibili.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export const SEASON_API_TIMEOUT_MS = 10_000;
/** Overall wall-clock budget for one association attempt (view + add + membership check). */
export const SEASON_TOTAL_TIMEOUT_MS = 25_000;

export type SeasonAddOutcome =
  | { status: "added"; sectionId: number; aid: number; cid: number; title: string }
  | { status: "already"; sectionId: number; aid: number }
  | { status: "skipped"; reason: string }
  | { status: "failed"; sectionId: number; error: string; retryable: boolean };

interface SeasonTarget {
  sectionId: number;
  cookiesPath: string;
  aid?: number;
  bvid?: string;
  title?: string;
  /**
   * True when an earlier attempt may already have POSTed the add (resume/pending state).
   * In that case membership is checked before POSTing, so an applied-but-unconfirmed add is not repeated.
   */
  reconcileFirst?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** Overall deadline for the whole attempt; defaults to {@link SEASON_TOTAL_TIMEOUT_MS}. */
  totalTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolve a room rule against the global default.
 * `null` is an explicit "off" and must not fall back; `undefined` inherits.
 */
export function resolveSeasonSectionId(ruleValue: unknown, defaultValue: unknown): number | undefined {
  if (ruleValue === null) return undefined;
  const fromRule = normalizeSeasonSectionId(ruleValue);
  return fromRule ?? normalizeSeasonSectionId(defaultValue);
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
    if (!res.ok) return { raw, ok: false, status: res.status, error: `HTTP ${res.status}` };
    return { raw, ok: true, status: res.status };
  } catch (e) {
    return { raw: {}, ok: false, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

function cookieHeader(cookiesPath: string): string | null {
  try {
    return biliupCookieHeader(JSON.parse(readFileSync(cookiesPath, "utf-8")));
  } catch {
    return null;
  }
}

function csrf(cookiesPath: string): string | null {
  try {
    return biliupCsrf(JSON.parse(readFileSync(cookiesPath, "utf-8")));
  } catch {
    return null;
  }
}

function headers(cookie: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": UA,
    Cookie: cookie,
    Referer: "https://member.bilibili.com/",
  };
}

/** cid of the first part, covering the creator-center and client view shapes. */
function firstCid(data: Record<string, unknown>): number | undefined {
  const videos = data.videos;
  if (Array.isArray(videos)) {
    for (const v of videos) {
      const cid = Number((v as { cid?: unknown })?.cid);
      if (cid > 0) return cid;
    }
  }
  const pages = data.pages;
  if (Array.isArray(pages)) {
    for (const p of pages) {
      const cid = Number((p as { cid?: unknown })?.cid);
      if (cid > 0) return cid;
    }
  }
  const cid = Number(data.cid);
  return cid > 0 ? cid : undefined;
}

interface ViewInfo {
  aid: number;
  cid: number;
  title: string;
}

function viewInfo(raw: Record<string, unknown>, fallbackAid?: number, fallbackTitle?: string): ViewInfo | null {
  if (raw.code !== 0) return null;
  const data = (raw.data ?? {}) as Record<string, unknown>;
  const archive = (data.archive ?? data) as Record<string, unknown>;
  const aid = Number(archive.aid ?? fallbackAid);
  const cid = firstCid(data);
  const title = String(archive.title ?? fallbackTitle ?? "").trim();
  if (!(aid > 0) || !cid) return null;
  return { aid, cid, title };
}

async function resolveView(o: SeasonTarget, doFetch: typeof fetch, cookie: string, timeoutMs: number): Promise<ViewInfo | string> {
  const vid = o.aid && o.aid > 0 ? `aid=${o.aid}` : o.bvid ? `bvid=${encodeURIComponent(o.bvid)}` : "";
  if (!vid) return "需要 aid 或 bvid 才能加入合集";
  let last = "";
  for (const base of ["/x/vupre/web/archive/view", "/x/client/archive/view"]) {
    const r = await requestJson(doFetch, `${MEMBER}${base}?${vid}`, { headers: headers(cookie) }, timeoutMs);
    if (!r.ok) {
      last = r.error ?? "view request failed";
      continue;
    }
    const info = viewInfo(r.raw, o.aid, o.title);
    if (info) return info;
    last = `view code=${String(r.raw.code ?? "?")} ${String(r.raw.message ?? "")}`.trim();
  }
  return `无法读取稿件信息(${last || "unknown"})`;
}

async function sectionContainsAid(
  doFetch: typeof fetch,
  cookie: string,
  sectionId: number,
  aid: number,
  timeoutMs: number,
): Promise<boolean | null> {
  const r = await requestJson(doFetch, `${MEMBER}/x2/creative/web/season/section?id=${sectionId}`, { headers: headers(cookie) }, timeoutMs);
  if (!r.ok || r.raw.code !== 0) return null;
  const data = (r.raw.data ?? {}) as Record<string, unknown>;
  const episodes = Array.isArray(data.episodes) ? data.episodes : [];
  return episodes.some((e) => Number((e as { aid?: unknown })?.aid) === aid);
}

/**
 * Associate one submitted archive with a season section. Best effort: never throws, and an unknown
 * post result is reconciled against the section membership before reporting failure.
 */
export async function addArchiveToSeason(o: SeasonTarget): Promise<SeasonAddOutcome> {
  const sectionId = normalizeSeasonSectionId(o.sectionId);
  if (!sectionId) return { status: "skipped", reason: "合集小节 ID 未配置" };

  const deadline = Date.now() + (o.totalTimeoutMs ?? SEASON_TOTAL_TIMEOUT_MS);
  const remaining = (): number => deadline - Date.now();
  const budget = (): number | null => {
    const left = remaining();
    return left > 0 ? Math.min(o.timeoutMs ?? SEASON_API_TIMEOUT_MS, left) : null;
  };

  const cookie = cookieHeader(o.cookiesPath);
  const token = csrf(o.cookiesPath);
  if (!cookie || !token) {
    return { status: "failed", sectionId, error: "登录态不完整(缺少 Cookie 或 bili_jct)", retryable: true };
  }

  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const viewBudget = budget();
  if (viewBudget === null) return { status: "failed", sectionId, error: "加入合集超时(总预算耗尽)", retryable: true };
  const view = await resolveView(o, doFetch, cookie, viewBudget);
  if (typeof view === "string") return { status: "failed", sectionId, error: view, retryable: true };

  if (o.reconcileFirst) {
    const checkBudget = budget();
    if (checkBudget === null) return { status: "failed", sectionId, error: "加入合集超时(总预算耗尽)", retryable: true };
    const inSection = await sectionContainsAid(doFetch, cookie, sectionId, view.aid, checkBudget);
    if (inSection === true) return { status: "already", sectionId, aid: view.aid };
    if (inSection === null) {
      return { status: "failed", sectionId, error: "小节成员状态未知,未重复提交", retryable: true };
    }
  }

  const body = {
    sectionId,
    episodes: [{ aid: view.aid, cid: view.cid, title: view.title, charging_pay: 0 }],
    csrf: token,
  };
  const url = `${MEMBER}/x2/creative/web/season/section/episodes/add?csrf=${encodeURIComponent(token)}`;

  let last = "";
  let retryable = true;
  for (let attempt = 0; attempt < 2; attempt++) {
    const postBudget = budget();
    if (postBudget === null) return { status: "failed", sectionId, error: "加入合集超时(总预算耗尽)", retryable: true };
    const r = await requestJson(
      doFetch,
      url,
      { method: "POST", headers: headers(cookie), body: JSON.stringify(body) },
      postBudget,
    );
    if (r.ok && r.raw.code === 0) return { status: "added", sectionId, aid: view.aid, cid: view.cid, title: view.title };
    last = r.ok ? `code=${String(r.raw.code ?? "?")} ${String(r.raw.message ?? "")}`.trim() : (r.error ?? "request failed");
    // A lost response may still mean the server applied the add. Check before retrying or failing.
    const checkBudget = budget();
    if (checkBudget === null) return { status: "failed", sectionId, error: "加入合集超时(总预算耗尽)", retryable: true };
    const inSection = await sectionContainsAid(doFetch, cookie, sectionId, view.aid, checkBudget);
    if (inSection === true) return { status: "already", sectionId, aid: view.aid };
    const code = Number(r.raw.code);
    // Throttling and precondition answers are not rejections of the association: a cooled retry is
    // still able to add the archive, so they must stay retryable (601 / 21540 / 21566 / 21186 and
    // HTTP 429 / 412 / 403, where 403 usually means the login needs a refresh).
    const authError = r.status === 401 || r.status === 403 || Number(r.raw.code) === -101;
    const throttledStatus = r.status === 429 || r.status === 412 || authError;
    const rateLimited = throttledStatus || code === 601 || code === 21540 || code === 21566 || code === 21186
      || /上传过快|上传视频过快|投稿过于频繁|请求过于频繁/i.test(String(r.raw.message ?? ""));
    const definiteRejection = !rateLimited && (
      (r.status !== undefined && r.status >= 400 && r.status < 500)
      || (r.status !== undefined && r.status < 500 && r.raw.code !== undefined && r.raw.code !== 0)
    );
    retryable = !definiteRejection;
    if (definiteRejection) {
      // A definite API rejection will not become success by retrying.
      break;
    }
    if (inSection === null) {
      // The POST outcome is unknown and membership could not be checked. Re-posting here can turn
      // an already-applied add into a false "duplicate" failure, so stop and surface the uncertainty.
      return { status: "failed", sectionId, error: `${last};小节成员状态未知,未重复提交`, retryable: true };
    }
    if (attempt === 0 && remaining() > 1_500) await sleep(1_500).catch(() => {});
  }
  return { status: "failed", sectionId, error: last || "加入合集失败", retryable };
}

/** Checkpoint state for a configured season attempt: retryable failures stay pending. */
export function seasonCheckpointState(outcome: SeasonAddOutcome): "pending" | "done" | "failed" {
  if (outcome.status !== "failed") return "done";
  return outcome.retryable ? "pending" : "failed";
}

/**
 * Human-readable one-line outcome for job logs.
 * On the season-id path pass `seasonId` so the line names the configured 合集 instead of a bare
 * section id (and never the useless "小节 0" when resolution itself failed).
 */
export function describeSeasonOutcome(r: SeasonAddOutcome, seasonId?: number): string {
  // `skipped` carries no sectionId; every other variant does.
  const sectionId = r.status === "skipped" ? 0 : r.sectionId;
  const target = seasonId === undefined
    ? "合集小节 " + String(sectionId)
    : sectionId > 0
      ? "合集 " + String(seasonId) + " 的小节 " + String(sectionId)
      : "合集 " + String(seasonId);
  switch (r.status) {
    case "added":
      return "[season] 已加入" + target + "(av" + String(r.aid) + ", cid " + String(r.cid) + ")";
    case "already":
      return "[season] 稿件 av" + String(r.aid) + " 已在" + target + " 中";
    case "skipped":
      return "[season] 跳过:" + r.reason;
    case "failed":
      return "[season] 加入" + target + " 失败" + (r.retryable ? "(可重试)" : "") + ":" + r.error;
  }
}

/**
 * Best-effort wrapper used by every upload/resume path. Guarantees the season step never throws and
 * that its outcome reaches the job log through one place.
 */
export async function addArchiveToSeasonWithNote(
  o: SeasonTarget & { note?: (msg: string) => void; seasonId?: number | null },
): Promise<SeasonAddOutcome> {
  const loggingSeasonId = o.seasonId ?? undefined;
  let outcome: SeasonAddOutcome;
  try {
    outcome = await addArchiveToSeason(o);
  } catch (e) {
    outcome = { status: "failed", sectionId: o.sectionId, error: String((e as Error)?.message ?? e).slice(0, 200), retryable: true };
  }
  // Season-id path: a definite rejection is almost always a wrong 合集 ID (or one that belongs to
  // another account), so append the user-facing hint to the one log line for this attempt.
  if (loggingSeasonId !== undefined && outcome.status === "failed" && !outcome.retryable
      && !outcome.error.includes(SEASON_ID_HINT)) {
    outcome = { ...outcome, error: outcome.error + "; " + SEASON_ID_HINT };
  }
  try { o.note?.(describeSeasonOutcome(outcome, loggingSeasonId)); } catch { /* logging never fails an upload */ }
  return outcome;
}

/**
 * Call-site entry point: no configured section = a silent skip, otherwise the same best-effort
 * wrapper. Callers can invoke it unconditionally without repeating the config guard.
 */
export async function addArchiveToSeasonIfConfigured(
  o: Omit<SeasonTarget, "sectionId"> & {
    sectionId?: number | null;
    /** New-style season id (合集 ID from the creator center); wins over sectionId when set. */
    seasonId?: number | null;
    /** Node data root for the season-id -> section-id cache. */
    dataRoot?: string;
    note?: (msg: string) => void;
  },
): Promise<SeasonAddOutcome> {
  const seasonId = normalizeSeasonSectionId(o.seasonId);
  if (seasonId) return addArchiveToSeasonById({
    seasonId,
    cookiesPath: o.cookiesPath,
    ...(o.dataRoot ? { dataRoot: o.dataRoot } : {}),
    ...(o.aid ? { aid: o.aid } : {}),
    ...(o.bvid ? { bvid: o.bvid } : {}),
    ...(o.title ? { title: o.title } : {}),
    ...(o.reconcileFirst ? { reconcileFirst: o.reconcileFirst } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}),
    ...(o.totalTimeoutMs !== undefined ? { totalTimeoutMs: o.totalTimeoutMs } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.note ? { note: o.note } : {}),
  });
  const sectionId = normalizeSeasonSectionId(o.sectionId);
  if (!sectionId) return { status: "skipped", reason: "合集小节 ID 未配置" };
  return addArchiveToSeasonWithNote({ ...o, sectionId });
}

/**
 * Season-id entry point (issue #460): resolves seasonId -> sectionId (cache first), then adds.
 * A definite rejection drops the cache, re-resolves once, and retries once before giving up.
 */
export async function addArchiveToSeasonById(o: {
  seasonId: number;
  cookiesPath: string;
  dataRoot?: string;
  aid?: number;
  bvid?: string;
  title?: string;
  reconcileFirst?: boolean;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  note?: (msg: string) => void;
}): Promise<SeasonAddOutcome> {
  const { seasonId, cookiesPath, dataRoot } = o;
  const note = o.note;
  // This is the upload path: an exception here must never escape into it. Same contract as
  // addArchiveToSeasonWithNote: any failure becomes retryable "pending".
  try {
    // One wall-clock budget for resolve + add + (one) retry.
    const deadline = Date.now() + (o.totalTimeoutMs ?? SEASON_TOTAL_TIMEOUT_MS);

    const attempt = async (): Promise<{ outcome: SeasonAddOutcome; fromCache: boolean }> => {
      const resolved = await resolveSectionIdFromSeasonId({
        seasonId,
        cookiesPath,
        ...(dataRoot ? { dataRoot } : {}),
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        deadlineMs: deadline,
      });
      if (resolved.status === "failed") {
        // Resolution itself failed: no POST, and no second scan (a re-scan cannot help).
        const outcome: SeasonAddOutcome = { status: "failed", sectionId: 0, error: resolved.error, retryable: resolved.retryable };
        try { note?.(describeSeasonOutcome(outcome, seasonId)); } catch { /* logging never fails */ }
        return { outcome, fromCache: false };
      }
      const outcome = await addArchiveToSeasonWithNote({
        sectionId: resolved.sectionId,
        seasonId,
        cookiesPath,
        ...(o.aid ? { aid: o.aid } : {}),
        ...(o.bvid ? { bvid: o.bvid } : {}),
        ...(o.title ? { title: o.title } : {}),
        ...(o.reconcileFirst ? { reconcileFirst: o.reconcileFirst } : {}),
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
        // Share the one deadline: the add step gets whatever is left of resolve + add + retry.
        totalTimeoutMs: Math.max(1, deadline - Date.now()),
        ...(o.sleep ? { sleep: o.sleep } : {}),
        ...(note ? { note } : {}),
      });
      return { outcome, fromCache: resolved.fromCache };
    };

    const first = await attempt();
    // Re-resolve + retry ONCE, and only when the rejected section came from the cache: a stale
    // cached section is worth a fresh scan, while a fresh resolution (or a resolver failure) already
    // reflects the account's current state, so a second scan/POST there is pure extra risk.
    if (first.outcome.status === "failed" && !first.outcome.retryable && first.fromCache) {
      clearSeasonIdCachePath(cookiesPath, seasonId, dataRoot);
      return (await attempt()).outcome;
    }
    return first.outcome;
  } catch (e) {
    const outcome: SeasonAddOutcome = {
      status: "failed",
      sectionId: 0,
      error: String((e as Error)?.message ?? e).slice(0, 200),
      retryable: true,
    };
    try { note?.(describeSeasonOutcome(outcome, seasonId)); } catch { /* logging never fails an upload */ }
    return outcome;
  }
}
