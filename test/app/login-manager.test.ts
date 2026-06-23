/**
 * login-manager.test.ts — QrLoginManager over a MOCK QrLogin (no real browser).
 *
 * Verifies: start returns id+qr; poll transitions pending→confirmed; confirmed
 * persists the cookie to the (mock) settings store AND returns it; expiry drops
 * the session; only one active session at a time (start cancels the previous);
 * unknown ids report "unknown".
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  QrLoginManager,
  DEFAULT_COOKIES_KEY,
  type SettingsStore,
} from "../../packages/app/src/login/login-manager.js";
import type { QrLogin, QrPollResult, QrStartResult } from "../../packages/app/src/login/qr-login.js";

/** In-memory settings store (the slice the manager needs). */
class MemStore implements SettingsStore {
  private m = new Map<string, string>();
  setSetting(k: string, v: string): void {
    this.m.set(k, v);
  }
  getSetting(k: string): string | null {
    return this.m.get(k) ?? null;
  }
}

/** Scriptable mock QrLogin: feed it a queue of poll results. */
class MockQrLogin implements QrLogin {
  startCalls = 0;
  cancelCalls = 0;
  private queue: QrPollResult[];
  constructor(
    private readonly qrPng = "QQ==",
    queue: QrPollResult[] = [{ state: "pending" }],
  ) {
    this.queue = [...queue];
  }
  async start(): Promise<QrStartResult> {
    this.startCalls++;
    return { qrPng: this.qrPng };
  }
  async poll(): Promise<QrPollResult> {
    return this.queue.length > 1 ? this.queue.shift()! : this.queue[0];
  }
  async cancel(): Promise<void> {
    this.cancelCalls++;
  }
}

let store: MemStore;

beforeEach(() => {
  store = new MemStore();
});

describe("QrLoginManager.start", () => {
  it("returns a sessionId + the QR png from the login", async () => {
    const login = new MockQrLogin("ABCD");
    const mgr = new QrLoginManager(store, () => login);
    const r = await mgr.start();
    expect(r.qrPng).toBe("ABCD");
    expect(r.sessionId).toMatch(/^login-/);
    expect(login.startCalls).toBe(1);
    expect(mgr.activeId()).toBe(r.sessionId);
  });

  it("cancels the previous session when starting a new one", async () => {
    const first = new MockQrLogin();
    const second = new MockQrLogin();
    const sessions = [first, second];
    let i = 0;
    const mgr = new QrLoginManager(store, () => sessions[i++]);
    const a = await mgr.start();
    const b = await mgr.start();
    expect(first.cancelCalls).toBe(1);
    expect(a.sessionId).not.toBe(b.sessionId);
    // polling the old (cancelled) id is now unknown
    expect((await mgr.poll(a.sessionId)).state).toBe("unknown");
  });
});

describe("QrLoginManager.poll", () => {
  it("transitions pending → confirmed and persists+returns the cookie", async () => {
    const cookie = "sessionid=abc; ttwid=xyz";
    const login = new MockQrLogin("QR", [
      { state: "pending" },
      { state: "confirmed", cookie },
    ]);
    const mgr = new QrLoginManager(store, () => login);
    const { sessionId } = await mgr.start();

    const p1 = await mgr.poll(sessionId);
    expect(p1.state).toBe("pending");
    expect(p1.cookie).toBeUndefined();

    const p2 = await mgr.poll(sessionId);
    expect(p2.state).toBe("confirmed");
    expect(p2.cookie).toBe(cookie);
    // persisted to settings under defaultCookies
    expect(store.getSetting(DEFAULT_COOKIES_KEY)).toBe(cookie);
  });

  it("latches confirmed: repeated polls keep returning the cookie without re-polling login", async () => {
    const cookie = "sessionid=abc";
    const login = new MockQrLogin("QR", [{ state: "confirmed", cookie }]);
    const mgr = new QrLoginManager(store, () => login);
    const { sessionId } = await mgr.start();
    await mgr.poll(sessionId); // confirm
    const again = await mgr.poll(sessionId);
    expect(again.state).toBe("confirmed");
    expect(again.cookie).toBe(cookie);
  });

  it("expired drops the session (next poll → unknown)", async () => {
    const login = new MockQrLogin("QR", [{ state: "expired" }]);
    const mgr = new QrLoginManager(store, () => login);
    const { sessionId } = await mgr.start();
    expect((await mgr.poll(sessionId)).state).toBe("expired");
    expect((await mgr.poll(sessionId)).state).toBe("unknown");
    expect(mgr.activeId()).toBeNull();
  });

  it("unknown session id → unknown", async () => {
    const mgr = new QrLoginManager(store, () => new MockQrLogin());
    expect((await mgr.poll("nope")).state).toBe("unknown");
  });
});

describe("QrLoginManager.cancel", () => {
  it("cancels the active session", async () => {
    const login = new MockQrLogin();
    const mgr = new QrLoginManager(store, () => login);
    const { sessionId } = await mgr.start();
    await mgr.cancel(sessionId);
    expect(login.cancelCalls).toBe(1);
    expect(mgr.activeId()).toBeNull();
  });

  it("ignores cancel for a non-active id", async () => {
    const login = new MockQrLogin();
    const mgr = new QrLoginManager(store, () => login);
    await mgr.start();
    await mgr.cancel("other");
    expect(login.cancelCalls).toBe(0);
  });
});
