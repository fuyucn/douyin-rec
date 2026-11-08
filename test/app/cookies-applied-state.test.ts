/**
 * cookies-applied-state.test.ts — master-side bookkeeping for the credential push (issue #563 review F3/F4).
 *
 * The fingerprint lives on the master, so a worker that was reinstalled still looks "already applied".
 * `COOKIE_REVERIFY_MS` bounds that: the same content is re-sent every 6h regardless of the fingerprint.
 */
import { describe, it, expect } from "vitest";
import {
  COOKIE_REVERIFY_MS, cookiesAppliedKey, cookiesPushVerdict, readCookiesApplied, recordCookiesApplied, shouldPushCookies,
} from "../../packages/app/src/sync-receipt.js";

const settings = () => {
  const m = new Map<string, string>();
  return {
    m,
    getSetting: (k: string) => m.get(k) ?? null,
    setSetting: (k: string, v: string) => void m.set(k, v),
  };
};

const HOUR = 60 * 60 * 1000;
const NOW = 1_760_000_000_000;

describe("cookiesApplied state", () => {
  it("round-trips fingerprint + timestamp under the per-worker key", () => {
    const s = settings();
    recordCookiesApplied(s, "vps2", "fp-1", NOW);
    expect(readCookiesApplied(s, "vps2")).toEqual({ fingerprint: "fp-1", at: NOW });
    expect(s.m.has(cookiesAppliedKey("vps2"))).toBe(true);
  });

  it("legacy bare-fingerprint value (or garbage) parses as unknown → push", () => {
    const s = settings();
    s.setSetting(cookiesAppliedKey("vps2"), "fp-legacy");
    expect(readCookiesApplied(s, "vps2")).toBeUndefined();
    expect(shouldPushCookies(readCookiesApplied(s, "vps2"), "fp-legacy", NOW)).toBe(true);
  });
});

describe("shouldPushCookies", () => {
  it("never confirmed → push", () => {
    expect(shouldPushCookies(undefined, "fp", NOW)).toBe(true);
  });

  it("same content inside the re-verify window → skip", () => {
    expect(shouldPushCookies({ fingerprint: "fp", at: NOW - HOUR }, "fp", NOW)).toBe(false);
  });

  it("different content → push immediately", () => {
    expect(shouldPushCookies({ fingerprint: "old", at: NOW - 1000 }, "new", NOW)).toBe(true);
  });

  it("same content but older than the window → push anyway (re-verify)", () => {
    expect(shouldPushCookies({ fingerprint: "fp", at: NOW - COOKIE_REVERIFY_MS - 1 }, "fp", NOW)).toBe(true);
  });

  it("the window is overridable (tests / future tuning)", () => {
    expect(shouldPushCookies({ fingerprint: "fp", at: NOW - 5 * HOUR }, "fp", NOW, 4 * HOUR)).toBe(true);
    expect(shouldPushCookies({ fingerprint: "fp", at: NOW - 5 * HOUR }, "fp", NOW, 6 * HOUR)).toBe(false);
  });
});

describe("cookiesPushVerdict（记指纹 vs 重试）", () => {
  const payload = { platformCookies: { douyin: "D", bilibili: "B" } };

  it("all delivered platforms applied → record", () => {
    expect(cookiesPushVerdict(payload, { applied: ["douyin", "bilibili"], unchanged: [] }))
      .toMatchObject({ ok: true, missing: [], rejected: [] });
  });

  it("unchanged counts as delivered", () => {
    expect(cookiesPushVerdict(payload, { applied: [], unchanged: ["douyin", "bilibili"] }))
      .toMatchObject({ ok: true });
  });

  it("a platform the node does not have is accounted for (no endless re-send)", () => {
    const r = cookiesPushVerdict(payload, { applied: ["douyin"], unchanged: [], unsupported: ["bilibili"] });
    expect(r).toMatchObject({ ok: true, missing: [], unsupported: ["bilibili"] });
  });

  it("a delivered platform the node never acknowledged → retry", () => {
    const r = cookiesPushVerdict(payload, { applied: ["douyin"], unchanged: [] });
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["bilibili"]);
  });

  it("a rejected value → retry even when everything else applied", () => {
    const r = cookiesPushVerdict(payload, { applied: ["douyin", "bilibili"], unchanged: [], rejected: ["bilibili"] });
    expect(r.ok).toBe(false);
    expect(r.rejected).toEqual(["bilibili"]);
  });
});
