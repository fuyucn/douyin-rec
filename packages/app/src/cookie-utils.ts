/**
 * cookie-utils.ts — 平台 cookie 的纯解析工具(无状态、无 IO)。
 *
 * 从 web/api.ts 下沉:命令层(cli-task.ts 的 cookie 临期看门狗)需要 `parseCookieExpiry`,
 * 若继续从 `web/api.js` 取,就形成「命令层 → web 层」的反向依赖(T-22 第 2 步)。
 * 放这里两边都能用,方向干净。
 */

/** 某平台的 cookie 串是否含可用登录态(会话 cookie)。 */
export function hasSessionCookie(cookie: string, platform: string): boolean {
  if (platform === "bilibili") return /(?:^|;\s*)SESSDATA=/.test(cookie);
  if (platform === "kuaishou")
    return /(?:^|;\s*)kuaishou\.web\.cp\.api_st=|(?:^|;\s*)passToken=|(?:^|;\s*)userId=/.test(cookie);
  return /(?:^|;\s*)sessionid(?:_ss)?=/.test(cookie);
}

/**
 * 抖音登录态过期时间（epoch ms）从 `sid_guard` 字段解析。
 * sid_guard = `<token>|<登录时间戳秒>|<有效期秒>|<过期GMT串>`（`|` 可能被 URL 编码为 %7C）。
 * 取 (登录时间戳 + 有效期) ；解析不出返回 null。
 */
export function parseCookieExpiry(cookie: string): number | null {
  const m = cookie.match(/(?:^|;\s*)sid_guard=([^;]+)/);
  if (!m) return null;
  const parts = decodeURIComponent(m[1]).split(/\||%7C/i);
  if (parts.length < 3) return null;
  const loginTs = Number(parts[1]);
  const maxAge = Number(parts[2]);
  if (!Number.isFinite(loginTs) || !Number.isFinite(maxAge) || loginTs <= 0) return null;
  return (loginTs + maxAge) * 1000;
}
