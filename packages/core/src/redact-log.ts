/**
 * 日志脱敏(唯一真理源)。为什么需要:节点日志会经 F3 代查送到浏览器,
 * 而 vendored 抖音取流代码在异常信息里会打印整串 cookie(实测 `cookies: ttwid=…; UIFID=…`)。
 * 不脱敏就等于把凭证从节点内存搬到浏览器和 HTTP 日志里 —— 代查功能不能顺带扩大凭证暴露面。
 *
 * 口径(保守:宁可多遮):已识别的凭证键值对整段替换为 `<redacted>`;`cookie`/`cookies` 之后的
 * 长串一并遮掉(那是 `cookies: k=v; k=v` 这种形态)。
 */
const CRED_KEYS = [
  "sessionid", "sessionid_ss", "sid_tt", "sid_guard", "uid_tt", "uid_tt_ss", "passport_csrf_token",
  "SESSDATA", "bili_jct", "DedeUserID", "DedeUserID__ckMd5", "buvid3", "buvid4",
  "ttwid", "UIFID", "UIFID_TEMP", "odin_tt", "msToken", "access_token", "refresh_token",
];
const KEY_RE = new RegExp(`\\b(${CRED_KEYS.join("|")})=("[^"]*"|[^;,\\s"\\]]+)`, "g");
// `cookies: k=v; k=v; …` / `cookie=…` 之后的连续串(直到引号/换行/右括号)。
const RUN_RE = /\b(cookies?)\s*[:=]\s*("[^"]*"|[^\n")\]]+)/gi;

/** 单行脱敏;非字符串入参原样返回(调用方传日志行)。 */
export function redactLogLine(line: string): string {
  if (typeof line !== "string" || line === "") return line;
  return line.replace(RUN_RE, (_m, k: string) => `${k}: <redacted>`).replace(KEY_RE, (_m, k: string) => `${k}=<redacted>`);
}

/** 批量脱敏(保序)。 */
export function redactLogLines(lines: readonly string[]): string[] {
  return lines.map(redactLogLine);
}
