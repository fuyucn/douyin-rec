/**
 * Resolve the Bilibili upload credential for the zero-disk pump.
 *
 * `--cookies-file` is the platform recording credential (Douyin/Bilibili live). It is not
 * necessarily a biliup cookies.json file and must never be reused as the UPOS upload login.
 * Upload authentication has one source: BILIUP_COOKIE or the configured biliup cookies path.
 */
export function zeroDiskUploadCookie(env: NodeJS.ProcessEnv, biliupCookiesPath: string): string {
  return env.BILIUP_COOKIE?.trim() || biliupCookiesPath;
}
