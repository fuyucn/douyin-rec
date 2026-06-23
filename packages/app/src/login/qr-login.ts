/**
 * app/login/qr-login.ts — headless Douyin QR-login, Playwright isolated HERE.
 *
 * A real headless Chromium runs Douyin's own webmssdk anti-bot JS (which mints
 * msToken / s_v_web_id — impossible from pure Node), loads www.douyin.com, and
 * surfaces a scannable login QR as a `data:image/png;base64` <img>. We extract
 * that QR, relay it to the user (web console), and poll context.cookies() until
 * a `sessionid` appears (user scanned + confirmed on the phone app). Then we
 * harvest a whitelist of `.douyin.com` cookies into a "k=v; k=v" string,
 * mirroring the Python src/cookie/playwright_login.py reference.
 *
 * IMPORTANT: Playwright is imported lazily (dynamic import) so the rest of the
 * app — and the esbuild single-file bundle (which marks playwright external) —
 * never hard-depends on it. Everything outside this file talks to the QrLogin
 * interface only, so the feature is mockable + the app stays Playwright-free.
 */

/** Login lifecycle states surfaced to the caller / UI. */
export type QrLoginState = "pending" | "scanned" | "confirmed" | "expired";

/** Result of a poll(): the current state, plus the harvested cookie on confirm. */
export interface QrPollResult {
  state: QrLoginState;
  /** Present only when state === "confirmed": harvested "k=v; k=v" cookie string. */
  cookie?: string;
}

/** Result of start(): the QR to relay to the user as a base64 PNG (no data: prefix). */
export interface QrStartResult {
  /** base64-encoded PNG bytes (caller wraps as data:image/png;base64,<qrPng>). */
  qrPng: string;
}

/**
 * One QR-login session. Owns a browser/context/page lifecycle internally.
 * Implementations MUST be safe to `cancel()` at any time (idempotent).
 */
export interface QrLogin {
  /** Launch browser, navigate, extract the login QR. Throws if no QR appears. */
  start(): Promise<QrStartResult>;
  /** Check progress: cookies for sessionid (→ confirmed+cookie), expiry, etc. */
  poll(): Promise<QrPollResult>;
  /** Close the browser + free resources. Idempotent. */
  cancel(): Promise<void>;
}

/**
 * Cookie keys 录制 / 弹幕 WS actually need. Mirrors the Python reference
 * `_WANTED_KEYS` whitelist so we don't dump all ~50 cookies (6000+ chars).
 */
export const WANTED_COOKIE_KEYS: ReadonlySet<string> = new Set([
  "sessionid",
  "sessionid_ss",
  "uid_tt",
  "uid_tt_ss",
  "sid_tt",
  "sid_guard",
  "ttwid",
  "passport_csrf_token",
  "passport_csrf_token_default",
  "s_v_web_id",
  "odin_tt",
  "msToken",
  "__ac_nonce",
  "sid_ucp_v1",
  "ssid_ucp_v1",
  "login_time",
  "passport_assist_user",
  "n_mh",
  "d_ticket",
]);

/** A cookie record as Playwright's context.cookies() returns it (narrowed). */
export interface CookieRecord {
  name: string;
  value: string;
}

/**
 * Harvest a "k=v; k=v" cookie string from raw cookie records, keeping only the
 * whitelist when filter=true. Pure + exported for unit testing without a browser.
 */
export function harvestCookieString(
  cookies: readonly CookieRecord[],
  filter = true,
): string {
  const items = filter
    ? cookies.filter((c) => WANTED_COOKIE_KEYS.has(c.name))
    : cookies.slice();
  return items.map((c) => `${c.name}=${c.value}`).join("; ");
}

/** True when a sessionid-class cookie is present (login complete). */
export function hasSessionCookie(cookies: readonly CookieRecord[]): boolean {
  return cookies.some((c) => c.name === "sessionid" || c.name === "sessionid_ss");
}

const LOGIN_URL = "https://www.douyin.com/";
const COOKIE_DOMAIN_URL = "https://www.douyin.com/";
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/** Options for PlaywrightQrLogin (mostly for tests / tuning). */
export interface PlaywrightQrLoginOpts {
  /** Headless launch (default true). Spike confirmed headless mints a real QR. */
  headless?: boolean;
  /** Optional Playwright channel, e.g. "chrome" to use the system browser. */
  channel?: string;
  /** Max ms to wait for the QR <img> to appear after navigation (default 25s). */
  qrTimeoutMs?: number;
  /** Whole-session lifetime before auto-expire (default 4 min, matches Python). */
  sessionTtlMs?: number;
  /** Optional logger. */
  log?: (m: string) => void;
}

/**
 * Minimal structural types for the slice of the Playwright API we use. Declared
 * locally so this file does NOT need a top-level `import type` from playwright
 * (keeps typecheck working even if @types resolution differs, and documents the
 * exact surface area we depend on).
 */
interface PwBrowser {
  newContext(opts: unknown): Promise<PwContext>;
  close(): Promise<void>;
}
interface PwContext {
  newPage(): Promise<PwPage>;
  cookies(urls?: string): Promise<CookieRecord[]>;
}
interface PwPage {
  goto(url: string, opts: unknown): Promise<unknown>;
  $(selector: string): Promise<PwElement | null>;
  waitForFunction(fn: unknown, arg: unknown, opts: unknown): Promise<{ jsonValue(): Promise<unknown> }>;
  evaluate(fn: unknown): Promise<unknown>;
}
interface PwElement {
  click(opts?: unknown): Promise<void>;
}

/** PlaywrightQrLogin — the only place that touches Playwright. */
export class PlaywrightQrLogin implements QrLogin {
  private readonly headless: boolean;
  private readonly channel?: string;
  private readonly qrTimeoutMs: number;
  private readonly sessionTtlMs: number;
  private readonly log: (m: string) => void;

  private browser: PwBrowser | null = null;
  private ctx: PwContext | null = null;
  private page: PwPage | null = null;
  private startedAt = 0;
  private closed = false;
  /** Once we've seen any sessionid we latch "confirmed" so repeated polls are stable. */
  private confirmedCookie: string | null = null;

  constructor(opts: PlaywrightQrLoginOpts = {}) {
    this.headless = opts.headless ?? true;
    this.channel = opts.channel;
    this.qrTimeoutMs = opts.qrTimeoutMs ?? 25_000;
    this.sessionTtlMs = opts.sessionTtlMs ?? 4 * 60_000;
    this.log = opts.log ?? ((): void => {});
  }

  async start(): Promise<QrStartResult> {
    if (this.browser) throw new Error("QrLogin.start() 已调用过");

    // Lazy import: keeps playwright off the import graph for the bundle + tests.
    let chromium: { launch(opts: unknown): Promise<PwBrowser> };
    try {
      ({ chromium } = (await import("playwright")) as {
        chromium: { launch(opts: unknown): Promise<PwBrowser> };
      });
    } catch {
      throw new Error(
        "未安装 playwright。扫码登录需要完整安装：pnpm add playwright && npx playwright install chromium",
      );
    }

    const launchOpts: Record<string, unknown> = {
      headless: this.headless,
      args: ["--disable-blink-features=AutomationControlled"],
    };
    if (this.channel) launchOpts.channel = this.channel;

    this.log(`[login] 启动 chromium headless=${this.headless}…`);
    this.browser = await chromium.launch(launchOpts);
    this.startedAt = Date.now();
    try {
      this.ctx = await this.browser.newContext({
        userAgent: USER_AGENT,
        viewport: { width: 1280, height: 900 },
        locale: "zh-CN",
      });
      this.page = await this.ctx.newPage();
      this.log(`[login] 打开 ${LOGIN_URL}`);
      await this.page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45_000 });

      // The login modal usually auto-opens; clicking 登录 makes it deterministic.
      const trigger = await this.page.$("text=登录");
      if (trigger) await trigger.click().catch(() => {});

      const qrPng = await this.extractQrPng();
      this.log(`[login] 已提取登录二维码（${qrPng.length} base64 字符）`);
      return { qrPng };
    } catch (e) {
      await this.cancel();
      throw e;
    }
  }

  /** Wait for the square data-URI PNG QR, return its base64 (no data: prefix). */
  private async extractQrPng(): Promise<string> {
    const page = this.page;
    if (!page) throw new Error("page 未初始化");
    const handle = await page.waitForFunction(
      () => {
        const imgs = Array.from(
          document.querySelectorAll('img[src^="data:image/png;base64,"]'),
        ) as HTMLImageElement[];
        for (const img of imgs) {
          const r = img.getBoundingClientRect();
          if (r.width > 120 && Math.abs(r.width - r.height) < 30) {
            return img.getAttribute("src");
          }
        }
        return null;
      },
      undefined,
      { timeout: this.qrTimeoutMs, polling: 500 },
    );
    const dataUri = (await handle.jsonValue()) as string | null;
    if (!dataUri) {
      throw new Error("未能在登录页找到二维码（可能被风控拦截或页面结构变化）");
    }
    const comma = dataUri.indexOf(",");
    return comma >= 0 ? dataUri.slice(comma + 1) : dataUri;
  }

  async poll(): Promise<QrPollResult> {
    if (this.confirmedCookie !== null) {
      return { state: "confirmed", cookie: this.confirmedCookie };
    }
    if (this.closed || !this.ctx) {
      return { state: "expired" };
    }
    if (Date.now() - this.startedAt > this.sessionTtlMs) {
      this.log("[login] 会话超时，关闭浏览器");
      await this.cancel();
      return { state: "expired" };
    }

    let cookies: CookieRecord[];
    try {
      cookies = await this.ctx.cookies(COOKIE_DOMAIN_URL);
    } catch {
      // Browser/context may have been torn down between checks.
      return { state: "expired" };
    }

    if (hasSessionCookie(cookies)) {
      const cookie = harvestCookieString(cookies, true);
      this.confirmedCookie = cookie;
      this.log(`[login] ✅ 登录成功，收割 cookie（${cookie.length} 字符）`);
      // Login complete — the browser is no longer needed.
      await this.cancel();
      return { state: "confirmed", cookie };
    }

    // We can't reliably distinguish "scanned but not confirmed" without the page
    // QR-status DOM (it varies); report "pending" until the cookie lands. The
    // "scanned" state stays in the interface for callers/mocks that can detect it.
    return { state: "pending" };
  }

  async cancel(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.page = null;
    this.ctx = null;
    const b = this.browser;
    this.browser = null;
    if (b) {
      try {
        await b.close();
      } catch {
        /* already gone */
      }
    }
  }
}
