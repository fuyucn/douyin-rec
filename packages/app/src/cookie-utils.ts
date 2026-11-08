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
  // 手工粘贴/二次编码残留的游离 `%` 会让 decodeURIComponent 抛 URIError:一个坏串不能让整轮
  // 看门狗(以及 /api/cookie 的状态计算)直接 500,按「解析不出」处理。
  let decoded: string;
  try {
    decoded = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const parts = decoded.split(/\||%7C/i);
  if (parts.length < 3) return null;
  const loginTs = Number(parts[1]);
  const maxAge = Number(parts[2]);
  if (!Number.isFinite(loginTs) || !Number.isFinite(maxAge) || loginTs <= 0) return null;
  return (loginTs + maxAge) * 1000;
}

/** 一条「登录态即将过期」判定(供 serve 看门狗直接发告警)。 */
export interface CookieDueAlert {
  /** 平台 id(douyin / bilibili / ...)。 */
  platform: string;
  /** 取整后的剩余天数;负数 = 已过期。 */
  days: number;
  /** 该条串的到期时刻(epoch ms)。用来区分「同一临期串」与「续期后的新串」。 */
  expiry: number;
}

/**
 * 哪些平台的有效登录态已到/超过阈值(issue #563)。
 *
 * 纯函数,输入是**实际生效**的那份串(`store.getPlatformCookies(platform)`) —— 看门狗只读兼容键时
 * 会漏掉/误报 `platformCookies` 里真正在用的那份。目前只有抖音的串带到期信息,其余平台解析不出
 * (`parseCookieExpiry` 返回 null) → 不参与判定。
 */
export function dueCookieAlerts(
  cookies: ReadonlyArray<{ platform: string; value: string | null }>,
  nowMs: number,
  warnDays: number,
): CookieDueAlert[] {
  const due: CookieDueAlert[] = [];
  for (const { platform, value } of cookies) {
    if (!value) continue;
    const exp = parseCookieExpiry(value);
    if (exp == null) continue;
    const days = Math.floor((exp - nowMs) / 86_400_000);
    if (days <= warnDays) due.push({ platform, days, expiry: exp });
  }
  return due;
}

/** Persisted "already warned" markers: platform → `"<expiry>:<severity>"`. */
export type CookieWarnMarkers = Record<string, string>;

/** One marker key. Severity is part of it, so crossing into "expired" alerts once more (see below). */
const warnKey = (d: CookieDueAlert): string => `${d.expiry}:${d.days < 0 ? "expired" : "soon"}`;

/** Parse the settings row; bad JSON/garbage reads as "nothing warned" (never silence a real alert). */
function parseWarnedMarkers(raw: string | null): CookieWarnMarkers {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const out: CookieWarnMarkers = {};
    for (const [platform, value] of Object.entries(parsed)) {
      if (typeof value === "string" && value.length > 0) out[platform] = value;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Decide this round's alerts and the settings value to persist (issue #563 deployment finding)。
 *
 * 进程内 latch 在重启时归零,而节点重启很频繁——升级后每次 start 都会把同一条旧串再报一遍。
 * 把「已报过的那条」落进 settings,比较键 = 到期时刻 + 严重度:
 *   - 同一到期时刻的重复采样 → 不再报;
 *   - 串续期(到期时刻变了)→ 照常报;
 *   - 从「N 天后过期」跨到「已过期」→ 严重度变化,再报一次(否则真过期时反而静默)。
 * 纯函数:读坏值按「没报过」处理;`changed=false` 时调用方不必写 DB。
 */
export function planCookieAlerts(
  due: readonly CookieDueAlert[],
  warnedRaw: string | null,
): { alerts: CookieDueAlert[]; nextRaw: string; changed: boolean } {
  const warned = parseWarnedMarkers(warnedRaw);
  const alerts = due.filter((d) => warned[d.platform] !== warnKey(d));
  const next: CookieWarnMarkers = {};
  // 只保留**当前临期**的平台:续期/健康后 marker 自动失效,下一次真临期不会被误抑制。
  for (const d of due) next[d.platform] = warnKey(d);
  const nextRaw = due.length > 0 ? JSON.stringify(next) : "";
  return { alerts, nextRaw, changed: nextRaw !== (warnedRaw ?? "") };
}
