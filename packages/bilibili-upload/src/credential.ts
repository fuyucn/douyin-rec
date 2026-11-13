/**
 * credential.ts — B 站上传凭据的定位与账号键(plans/049 stage 2)。
 *
 * 两条传输读的是**同一份** cookies.json:biliup 子进程与进程内 UPOS HTTP。解析顺序、缺失判定
 * 和账号分键必须一致——否则同一个账号会在 `UploadGate` 里分出两个槽位,限流计算随之翻倍。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** 凭据环境变量:与 app 的既有默认同口径,不新造第二套命名。 */
export const COOKIE_ENV = "BILIUP_COOKIE";

export interface CredentialDeps {
  env?: (key: string) => string | undefined;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string | null;
}

/** Resolve the cookies path for a target: explicit > env > data-root default. */
export function cookieLocator(
  targetId: string,
  o: { dataRoot: string; explicitPath?: string },
  deps: CredentialDeps = {},
): string {
  const env = deps.env ?? ((k: string) => process.env[k]);
  const exists = deps.exists ?? existsSync;
  // 环境变量为空串/纯空格时按「没给」处理,回落到数据根默认(与仓库既有实现同口径)。
  const fromEnv = env(COOKIE_ENV)?.trim() || undefined;
  const locator = o.explicitPath ?? fromEnv ?? join(o.dataRoot, "config", "biliup", "cookies.json");
  if (!exists(locator)) throw new Error(`bilibili 上传凭据不存在(target=` + targetId + `)`);
  return locator;
}

/** accountKey 对外只暴露不可逆短哈希:Gate 需要稳定分键,日志不需要路径。 */
function shortHash(s: string): string {
  return createHash("sha1").update(s).digest("hex").slice(0, 12);
}

/** 从 biliup cookies JSON 取 B 站 `DedeUserID`:同一账号换路径仍是同一个分键。 */
function dedeUserId(text: string | null): string | null {
  if (!text) return null;
  try {
    const j = JSON.parse(text) as { cookie_info?: { cookies?: Array<{ name?: string; value?: string }> } };
    const hit = j.cookie_info?.cookies?.find((c) => c.name === "DedeUserID");
    return hit?.value?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Stable per-account key for the upload gate. Falls back to the path hash when the account id
 * cannot be read: still stable, but a different path yields a different key (visible, not merged).
 */
export function accountKeyFor(
  targetId: string,
  locator: string,
  deps: CredentialDeps = {},
): string {
  const readText = deps.readText ?? ((p: string) => (existsSync(p) ? readFileSync(p, "utf-8") : null));
  let uid: string | null = null;
  try {
    uid = dedeUserId(readText(locator));
  } catch {
    // File removed or permissions changed between exists and read: accountKey is synchronous,
    // so fall back instead of throwing at the caller.
    uid = null;
  }
  return `${targetId}:${shortHash(uid ?? locator)}`;
}
