import { readFileSync } from "node:fs";
import { biliupCookieHeader, biliupCsrf } from "@drec/bilibili-api";

// Keep cookie parsing in this package; processors re-exports it, never the other way round.
export function readBiliupCookieHeader(cookiesPath: string): string | null {
  try {
    return biliupCookieHeader(JSON.parse(readFileSync(cookiesPath, "utf-8")));
  } catch {
    return null;
  }
}

export const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const CONTROL_TIMEOUT_MS = 60_000;

/** Bound each metadata request while preserving caller cancellation. */
export function controlSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(CONTROL_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function csrfOf(data: unknown): string {
  const jct = biliupCsrf(data);
  if (!jct) throw new Error("cookies 里没有 bili_jct,无法提交(登录态不完整)");
  return jct;
}

export function cookieHeaderOrThrow(cookiesPath: string): string {
  const cookie = readBiliupCookieHeader(cookiesPath);
  if (!cookie) throw new Error(`无法从 cookies 解析登录态: ${cookiesPath}`);
  return cookie;
}
