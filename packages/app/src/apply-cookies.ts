/**
 * apply-cookies.ts — decode + apply the master's platform credential push (`_apply-cookies`, issue #563).
 *
 * master 是唯一登录源:worker 不再需要逐节点扫码登录。两条不变量:
 *
 *  1. **空值/缺省一律忽略,永不删除**。master 未登录(master 侧读不到串)时,节点必须保留还能用的登录态;
 *     把「读不到」当成「清空」会让节点静默降级成匿名(丢礼物/入场,且没有任何告警)。与 `_apply-tasks`
 *     的「期望为空」安全阀同类风险,这里取相反口径:宁可不写。
 *  2. 写路径只走 `store.setPlatformCookies`:它同时维护 `platformCookies` map 与抖音兼容键
 *     `defaultCookies`(两次 setSetting,不是单事务;两份极端情况下可分叉,但读侧一律先读 map,
 *     实际生效值仍是同一个)。看门狗与录制取值都读这一处,分头写才会让「告警的串」和
 *     「实际用的串」再次分叉。
 */
import { listPlatforms, type ApplyCookiesPayload, type ApplyCookiesResult } from "@drec/core";
import type { TaskStore } from "./store.js";

/** Store surface this module needs (TaskStore satisfies it; tests can use a stub). */
export type CookieStore = Pick<TaskStore, "getPlatformCookies" | "setPlatformCookies">;

/** Decoded push: usable values + per-key classification the master needs to decide "recorded or retry". */
export interface DecodedApplyCookies extends ApplyCookiesPayload {
  /** Platforms this bundle does not know at all (never applicable, not a failure). */
  unsupported: string[];
  /** Delivered but unusable values (corrupted/truncated payload → retry). */
  rejected: string[];
}

/**
 * Build the payload the master pushes to a worker: every platform whose **effective** credential is set.
 *
 * Platforms without a value are omitted (not sent as empty) — the node never deletes anything, and an
 * omitted key keeps whatever it already has.
 */
export function collectPlatformCookies(store: Pick<TaskStore, "getPlatformCookies">): ApplyCookiesPayload {
  const platformCookies: Record<string, string> = {};
  for (const platform of listPlatforms()) {
    const value = store.getPlatformCookies(platform.id)?.trim();
    if (value) platformCookies[platform.id] = value;
  }
  return { platformCookies };
}

/** Upper bound on a delivered value. A real platform session is a few KB; anything larger is a bug. */
const MAX_VALUE_LEN = 64 * 1024;

/**
 * Decode the base64 JSON payload sent by the master.
 *
 * **Malformed payloads throw.** Returning an empty payload would be reported back as a success, and the
 * master would record that fingerprint (issue #563 review F2): the node would stay logged-out until the
 * next master login, with nothing but a silent "0 danmaku" to show for it. Throwing makes the ssh call
 * fail, so the round is retried and the failure is visible.
 *
 * Result classification (consumed by the master's `cookiesPushVerdict`):
 *   - empty/blank value → dropped silently (deliberate no-op; never a delete);
 *   - platform this bundle does not register → `unsupported` (never applicable here, so it **counts as
 *     accounted for**; otherwise the master would re-send the whole payload every tick);
 *   - non-string / oversized → `rejected` (corrupted or truncated payload → the master retries).
 */
export function decodeApplyCookies(b64: string): DecodedApplyCookies {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    throw new Error("登录态下发 payload 不是合法 base64/JSON");
  }
  if (!raw || typeof raw !== "object") throw new Error("登录态下发 payload 不是对象");
  const delivered = (raw as Partial<ApplyCookiesPayload>).platformCookies;
  if (!delivered || typeof delivered !== "object") throw new Error("登录态下发 payload 缺 platformCookies");
  const known = new Set(listPlatforms().map((p) => p.id));
  const platformCookies: Record<string, string> = {};
  const unsupported: string[] = [];
  const rejected: string[] = [];
  for (const [platform, value] of Object.entries(delivered as Record<string, unknown>)) {
    // Unknown platform = this bundle has no such platform at all (version skew). Never applicable here,
    // so it must not make the master re-send the whole payload every tick — report it as `unsupported`.
    if (!known.has(platform)) { unsupported.push(platform); continue; }
    // Empty is a deliberate no-op (never delete); master never sends it.
    if (typeof value === "string" && value.trim() === "") continue;
    // Corrupted/truncated value: the master must retry instead of recording a half-apply.
    if (typeof value !== "string") { rejected.push(platform); continue; }
    const trimmed = value.trim();
    if (trimmed.length > MAX_VALUE_LEN) { rejected.push(platform); continue; }
    platformCookies[platform] = trimmed;
  }
  return { platformCookies, unsupported, rejected };
}

/**
 * Apply one decoded payload to the node's settings. Values already in effect are not rewritten
 * (settings writes are cheap individually but this runs on every sync tick).
 *
 * Comparison uses the **effective** value (`getPlatformCookies`), so a douyin node whose compat key
 * already holds the delivered string reports `unchanged` instead of churning both keys every minute.
 */
export function applyPlatformCookies(store: CookieStore, payload: DecodedApplyCookies): ApplyCookiesResult {
  const applied: string[] = [];
  const unchanged: string[] = [];
  for (const [platform, value] of Object.entries(payload.platformCookies)) {
    if (store.getPlatformCookies(platform) === value) {
      unchanged.push(platform);
      continue;
    }
    store.setPlatformCookies(platform, value);
    applied.push(platform);
  }
  const result: ApplyCookiesResult = { applied, unchanged };
  if (payload.unsupported.length > 0) result.unsupported = payload.unsupported;
  if (payload.rejected.length > 0) result.rejected = payload.rejected;
  return result;
}
