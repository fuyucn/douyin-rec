/**
 * web/auth.ts — 远程 Web 访问的共享密钥鉴权（issue #600 / #419 P1）。
 *
 * 默认只监听回环；一旦监听非回环地址，就必须有共享密钥，否则拒绝启动（fail closed）。
 * 密钥来源：环境变量 DREC_WEB_TOKEN > <root>/config/web-token；远程模式缺失时首启生成 0600 文件。
 * 浏览器登录后种 HttpOnly + SameSite=Strict 会话票据；API 客户端可用 Authorization: Bearer
 * 或 X-DREC-Token。
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { IncomingMessage } from "node:http";

export const WEB_TOKEN_ENV = "DREC_WEB_TOKEN";
export const SESSION_COOKIE = "drec_session";
const SESSION_MAX_AGE_SEC = 7 * 24 * 3600;
const SESSION_DIGEST_SALT = "drec-web-session:";

export interface WebAuthConfig {
  token: string;
  cookieName: string;
  maxAgeSec: number;
}

export interface ResolveWebAuthOpts {
  /** `--host` 的实际监听地址；缺省回环。 */
  host: string;
  /** 数据根（密钥文件放在 `<root>/config/web-token`）。 */
  root: string;
  env?: Record<string, string | undefined>;
  log?: (m: string) => void;
}

/** 回环判定：localhost / IPv4 loopback / IPv6 loopback（含 IPv4-mapped）。 */
const LOOPBACK_V4 = [127, 0, 0, 1].join(".");
const LOOPBACK_V4_MAPPED = "::ffff:" + LOOPBACK_V4;
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === LOOPBACK_V4 || h === "::1" || h === LOOPBACK_V4_MAPPED
    || h === "0:0:0:0:0:0:0:1";
}

/** `<root>/config/web-token`。 */
export function webTokenPath(root: string): string {
  return join(root, "config", "web-token");
}

function configOf(token: string): WebAuthConfig {
  return { token, cookieName: SESSION_COOKIE, maxAgeSec: SESSION_MAX_AGE_SEC };
}

/**
 * 解析/生成鉴权配置。回环且没有任何密钥 → undefined（本机信任，行为与旧版一致）；
 * 非回环且没有密钥 → 生成并写盘（失败即抛，绝不无鉴权监听）。
 */
export function resolveWebAuth(o: ResolveWebAuthOpts): WebAuthConfig | undefined {
  const env = o.env ?? process.env;
  const envToken = (env[WEB_TOKEN_ENV] ?? "").trim();
  if (envToken) return configOf(envToken);

  const file = webTokenPath(o.root);
  if (existsSync(file)) {
    try {
      const token = readFileSync(file, "utf-8").trim();
      if (token) {
        try { chmodSync(file, 0o600); } catch { /* 权限收紧失败不影响读取；日志在启动侧 */ }
        return configOf(token);
      }
    } catch (e) {
      throw new Error(`读取 Web 访问密钥失败（${file}）：${(e as Error).message}`);
    }
  }

  if (isLoopbackHost(o.host)) return undefined;

  const token = randomBytes(32).toString("base64url");
  try {
    mkdirSync(dirname(file), { recursive: true });
    // wx：两个进程同时首启时只有一个能创建，另一个读赢家的密钥，不会互相覆盖。
    writeFileSync(file, token + "\n", { mode: 0o600, flag: "wx" });
    chmodSync(file, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") {
      const existing = readFileSync(file, "utf-8").trim();
      if (existing) return configOf(existing);
    }
    throw new Error(
      `非回环监听必须配置 Web 访问密钥，但无法写入 ${file}：${(e as Error).message}。` +
      `请设置环境变量 ${WEB_TOKEN_ENV} 或确保数据根可写。`,
    );
  }
  o.log?.(`已生成 Web 访问密钥：${file}（远程访问首次打开时输入该文件内容）`);
  return configOf(token);
}

/**
 * Existing credential of this data root: env first, then the 0600 token file. Never generates.
 * Internal node calls (stop/drain/anchor refresh/log tail) use it so enabling Web auth needs no
 * manual token copying; a credential-free legacy service keeps answering (undefined -> no header).
 */
export function readWebToken(root: string, env: Record<string, string | undefined> = process.env): string | undefined {
  const envToken = (env[WEB_TOKEN_ENV] ?? "").trim();
  if (envToken) return envToken;
  const file = webTokenPath(root);
  try {
    if (!existsSync(file)) return undefined;
    const token = readFileSync(file, "utf-8").trim();
    return token || undefined;
  } catch {
    // Unreadable file: behave like "no credential" instead of failing the command.
    return undefined;
  }
}

/** 该请求路径是否受鉴权保护；登录/版本/静态资源公开。 */
export function authRequiredFor(pathname: string, _method: string, auth: WebAuthConfig | undefined): boolean {
  if (!auth) return false;
  if (pathname === "/api/session" || pathname === "/api/version") return false;
  return pathname.startsWith("/api/");
}

function digestOf(token: string): string {
  return createHash("sha256").update(SESSION_DIGEST_SALT).update(token).digest("base64url");
}

/** 定长比较；长度不等直接 false（不泄漏内容）。 */
export function tokenMatches(candidate: string, expected: string): boolean {
  if (candidate.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(candidate, "utf-8");
  const b = Buffer.from(expected, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers.cookie;
  if (!raw) return undefined;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

/** Bearer / X-DREC-Token / 会话票据三选一。 */
export function isAuthorized(req: IncomingMessage, auth: WebAuthConfig): boolean {
  const bearer = headerValue(req, "authorization");
  if (bearer && /^Bearer\s+/i.test(bearer)) {
    if (tokenMatches(bearer.replace(/^Bearer\s+/i, "").trim(), auth.token)) return true;
  }
  const xToken = headerValue(req, "x-drec-token");
  if (xToken && tokenMatches(xToken.trim(), auth.token)) return true;
  const cookie = cookieValue(req, auth.cookieName);
  return cookie !== undefined && tokenMatches(cookie, digestOf(auth.token));
}

/** 登录成功后种会话票据；反代 TLS 终止时加 Secure。 */
export function sessionCookieHeader(auth: WebAuthConfig, secure: boolean): string {
  const attrs = [
    `${auth.cookieName}=${digestOf(auth.token)}`,
    "HttpOnly",
    "SameSite=Strict",
    "Path=/",
    `Max-Age=${auth.maxAgeSec}`,
    ...(secure ? ["Secure"] : []),
  ];
  return attrs.join("; ");
}

/** 退出登录：立即过期。 */
export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

/** 测试/启动诊断用：只返回密钥文件权限是否安全。 */
export function tokenFileModeIsPrivate(path: string): boolean {
  try { return (statSync(path).mode & 0o077) === 0; } catch { return false; }
}
