/**
 * danmu-cookie.ts — 弹幕 WS 连接用的 cookie 处理（移植自 Python origin/main
 * src/danmu/client.py 的 _filter_danmu_cookies + _get_cookie 合并逻辑）。
 *
 * 背景（2026-06-14 实测定位）：直接把用户【完整】抖音 cookie 灌进弹幕 WS 会触发
 * 抖音「异地登录」把用户手机踢下线。Python 生产版（VPS 跑一个多月不踢）的关键做法：
 *   1. 白名单过滤：丢弃 sid_guard / sid_ucp_v1 / ssid_ucp_v1 / login_time /
 *      passport_assist_user 等「设备/登录守卫」token，只留 sessionid/uid_tt/sid_tt
 *      （够推送礼物）；
 *   2. 用一份【新拉的匿名 guest cookie】覆盖设备指纹字段（ttwid/msToken/s_v_web_id/
 *      odin_ttid/__ac_nonce），即不用用户真实浏览器的设备指纹。
 * 二者合一 → 抖音视为「一个 guest 设备挂着会话在看直播」，不踢主号。
 */

/** 弹幕 WS 允许保留的 cookie 字段白名单（与 Python _DANMU_COOKIE_KEYS 对齐）。 */
const DANMU_COOKIE_KEYS = new Set<string>([
  "ttwid",
  "sessionid",
  "sessionid_ss",
  "uid_tt",
  "uid_tt_ss",
  "sid_tt",
  "sid_tt_ss",
  "msToken",
  "__ac_nonce",
  "__ac_signature",
  "s_v_web_id",
  "odin_ttid",
  "passport_csrf_token",
  "passport_csrf_token_default",
  "LOGIN_STATUS",
  "passport_auth_status",
  "n_mh",
  "d_ticket",
]);

/** 把 "k=v; k2=v2" 解析成对象（保留首次出现）。 */
function parseCookie(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const p = part.trim();
    if (!p) continue;
    const i = p.indexOf("=");
    if (i <= 0) continue;
    const k = p.slice(0, i).trim();
    if (!(k in out)) out[k] = p.slice(i + 1);
  }
  return out;
}

/** 按白名单过滤；丢弃 sid_guard/sid_ucp_v1 等踢人 token。 */
export function filterDanmuCookies(raw: string): string {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((p) => DANMU_COOKIE_KEYS.has(p.split("=")[0].trim()))
    .join("; ");
}

/**
 * 拉一份匿名 guest cookie（live.douyin.com 的 set-cookie，含 ttwid/s_v_web_id 等设备字段）。
 * 与同目录 ./api.js 的 getCookie 同源。失败返回 ""。
 */
export async function fetchGuestCookie(): Promise<string> {
  try {
    const res = await fetch("https://live.douyin.com/", { method: "GET" });
    const sc = res.headers.get("set-cookie");
    if (!sc) return "";
    return sc
      .split(", ")
      .map((c) => c.split(";")[0])
      .join("; ");
  } catch {
    return "";
  }
}

/**
 * 构造弹幕 WS 用的安全 cookie：白名单过滤用户 cookie + 用匿名 guest 设备字段覆盖。
 * - userCookie 为空 → 返回 undefined（让 client 自己走匿名）。
 * - 拉匿名失败 → 退回仅过滤后的用户 cookie（已去掉 guard/ucp，仍比完整 cookie 安全）。
 */
export async function buildDanmuCookie(userCookie: string | undefined): Promise<string | undefined> {
  if (!userCookie) return undefined;
  const filtered = filterDanmuCookies(userCookie);
  const anon = await fetchGuestCookie();
  if (!filtered) return anon || undefined;
  if (!anon) return filtered;
  // anon 覆盖：guest 的 ttwid/msToken/s_v_web_id/odin_ttid/__ac_nonce 盖掉用户真实设备指纹。
  const merged = { ...parseCookie(filtered), ...parseCookie(anon) };
  return Object.entries(merged)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}
