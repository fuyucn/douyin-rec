/**
 * app/login/login-manager.ts — QrLoginManager: at-most-one active QR-login.
 *
 * Sits between the web/CLI layer and a QrLogin session. It:
 *   - starts a session, assigns it a session id, returns {sessionId, qrPng},
 *   - polls a session by id, surfacing state transitions,
 *   - on "confirmed", persists the harvested cookie to settings
 *     (defaultCookies) AND returns it so a caller can drop it into a task,
 *   - auto-expires / cleans up stale sessions (and any browser they own).
 *
 * The QrLogin is created via an injected FACTORY so the manager is fully
 * testable with a mock session (no real browser). Playwright never enters this
 * file's import graph.
 */
import type { QrLogin, QrLoginState } from "./qr-login.js";

/** The narrow slice of TaskStore the manager needs (keeps it mockable). */
export interface SettingsStore {
  setSetting(key: string, value: string): void;
  getSetting(key: string): string | null;
}

/** Factory that mints a fresh QrLogin session. Injected for testability. */
export type QrLoginFactory = () => QrLogin;

/** Settings key under which the harvested login cookie is stored. */
export const DEFAULT_COOKIES_KEY = "defaultCookies";

/** Result of manager.start(). */
export interface StartResult {
  sessionId: string;
  qrPng: string;
}

/** Result of manager.poll(). cookie present only on confirmed. */
export interface PollResult {
  state: QrLoginState | "unknown";
  cookie?: string;
}

interface Session {
  id: string;
  login: QrLogin;
  /** Latched terminal cookie once confirmed (so repeated polls are stable). */
  cookie?: string;
}

export interface QrLoginManagerOpts {
  log?: (m: string) => void;
}

export class QrLoginManager {
  private readonly store: SettingsStore;
  private readonly factory: QrLoginFactory;
  private readonly log: (m: string) => void;
  private active: Session | null = null;
  private seq = 0;

  constructor(store: SettingsStore, factory: QrLoginFactory, opts: QrLoginManagerOpts = {}) {
    this.store = store;
    this.factory = factory;
    this.log = opts.log ?? ((): void => {});
  }

  /**
   * Start a new QR-login. Cancels any previous active session first (only one
   * headless browser at a time). Returns the session id + base64 QR PNG.
   */
  async start(): Promise<StartResult> {
    if (this.active) {
      this.log(`[login-mgr] 取消上一个会话 ${this.active.id}`);
      await this.cancelActive();
    }
    const login = this.factory();
    const { qrPng } = await login.start();
    const id = `login-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    this.active = { id, login };
    this.log(`[login-mgr] 新会话 ${id}`);
    return { sessionId: id, qrPng };
  }

  /**
   * Poll a session by id. On "confirmed", persists the cookie to settings and
   * returns it. Unknown / expired ids → { state: "unknown" } (404-able).
   */
  async poll(sessionId: string): Promise<PollResult> {
    const s = this.active;
    if (!s || s.id !== sessionId) return { state: "unknown" };

    if (s.cookie !== undefined) return { state: "confirmed", cookie: s.cookie };

    const r = await s.login.poll();
    if (r.state === "confirmed" && r.cookie) {
      s.cookie = r.cookie;
      this.store.setSetting(DEFAULT_COOKIES_KEY, r.cookie);
      this.log(`[login-mgr] 会话 ${sessionId} 已保存 defaultCookies`);
      return { state: "confirmed", cookie: r.cookie };
    }
    if (r.state === "expired") {
      // Drop the dead session so a fresh start() can take over.
      if (this.active?.id === sessionId) this.active = null;
    }
    return { state: r.state };
  }

  /** Cancel a session by id (or the active one if id omitted). */
  async cancel(sessionId?: string): Promise<void> {
    if (!this.active) return;
    if (sessionId && this.active.id !== sessionId) return;
    await this.cancelActive();
  }

  /** Currently-active session id, if any (for diagnostics / UI). */
  activeId(): string | null {
    return this.active?.id ?? null;
  }

  private async cancelActive(): Promise<void> {
    const s = this.active;
    this.active = null;
    if (s) {
      try {
        await s.login.cancel();
      } catch {
        /* best effort */
      }
    }
  }
}
