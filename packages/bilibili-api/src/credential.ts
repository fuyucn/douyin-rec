/**
 * credential.ts — Bilibili login-file helpers (cookies.json → account key / headers / CSRF).
 *
 * These used to live in @drec/core, which the audit (2026-11-10, P1-6) called out: the general
 * layer had no business knowing what a "DedeUserID", a "biliup cookies.json" or a `bili_jct` is.
 * They moved here verbatim so every caller (app / orchestrator / processors / zero-upload /
 * bilibili-upload) shares one implementation instead of growing a second copy.
 *
 * Nothing here does I/O: callers read the file and hand the parsed object (or its text) in.
 */

/**
 * Account key — the single source of truth for the upload rate-limit bucket.
 * `bilibili:<DedeUserID>`; a missing mid falls back to `bilibili:unknown` (conservative: one bucket,
 * wait longer rather than run unthrottled).
 */
export function biliAccountKey(dedeUserId?: string | number | null): string {
  const id = String(dedeUserId ?? "").trim();
  return id.length > 0 ? `bilibili:${id}` : "bilibili:unknown";
}

/**
 * Parse the account key out of a biliup `cookies.json` **text** (cookie values never leave this
 * function). Accepts both `{cookie_info:{cookies:[{name,value}]}}` and `{cookies:[...]}`.
 * Unparseable / no DedeUserID → `bilibili:unknown` (never throws).
 */
export function biliAccountKeyFromCookiesJson(text: string | null | undefined): string {
  if (!text) return biliAccountKey(null);
  try {
    const data = JSON.parse(text) as { cookie_info?: { cookies?: unknown }; cookies?: unknown };
    const raw = data?.cookie_info?.cookies ?? data?.cookies ?? [];
    if (Array.isArray(raw)) {
      for (const c of raw) {
        const o = c as { name?: unknown; value?: unknown };
        if (String(o?.name ?? "").toLowerCase() === "dedeuserid") return biliAccountKey(String(o?.value ?? ""));
      }
    }
  } catch {
    /* bad JSON → conservative unknown bucket */
  }
  return biliAccountKey(null);
}

/**
 * Build the Cookie request header from a biliup `cookies.json` **parsed object** (pure: no disk,
 * no provenance). Accepts both the wrapped and the bare shapes. No usable pair → null.
 */
export function biliupCookieHeader(data: unknown): string | null {
  const root = data as { cookie_info?: { cookies?: unknown }; cookies?: unknown } | null;
  const raw = root?.cookie_info?.cookies ?? root?.cookies ?? data;
  if (!Array.isArray(raw)) return null;
  const pairs = raw
    .map((item) => {
      const c = item as { name?: unknown; value?: unknown };
      const name = String(c?.name ?? "").trim();
      const value = String(c?.value ?? "").trim();
      return name && value ? `${name}=${value}` : "";
    })
    .filter(Boolean);
  return pairs.length > 0 ? pairs.join("; ") : null;
}

/** Read the CSRF token (`bili_jct`) from a parsed biliup login file, or null when absent. */
export function biliupCsrf(data: unknown): string | null {
  const root = data as { cookie_info?: { cookies?: unknown }; cookies?: unknown } | null;
  const raw = root?.cookie_info?.cookies ?? root?.cookies ?? data;
  if (!Array.isArray(raw)) return null;
  const value = raw
    .map((item) => item as { name?: unknown; value?: unknown })
    .find((c) => c?.name === "bili_jct")?.value;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

