/**
 * qr-login-cookie.test.ts — pure cookie helpers (no Playwright / no browser).
 *
 * Mirrors the Python reference whitelist + harvesting behaviour.
 */
import { describe, it, expect } from "vitest";
import {
  harvestCookieString,
  hasSessionCookie,
  WANTED_COOKIE_KEYS,
} from "../../packages/app/src/login/qr-login.js";

describe("harvestCookieString", () => {
  it("keeps only the whitelist and joins as k=v; k=v", () => {
    const cookies = [
      { name: "sessionid", value: "S1" },
      { name: "ttwid", value: "T1" },
      { name: "random_unwanted", value: "X" },
      { name: "msToken", value: "M1" },
    ];
    const s = harvestCookieString(cookies, true);
    expect(s).toBe("sessionid=S1; ttwid=T1; msToken=M1");
    expect(s).not.toContain("random_unwanted");
  });

  it("filter=false keeps everything", () => {
    const cookies = [
      { name: "a", value: "1" },
      { name: "b", value: "2" },
    ];
    expect(harvestCookieString(cookies, false)).toBe("a=1; b=2");
  });

  it("whitelist includes the key login-state cookies", () => {
    for (const k of ["sessionid", "sessionid_ss", "ttwid", "msToken", "s_v_web_id"]) {
      expect(WANTED_COOKIE_KEYS.has(k)).toBe(true);
    }
  });
});

describe("hasSessionCookie", () => {
  it("true when sessionid present", () => {
    expect(hasSessionCookie([{ name: "sessionid", value: "x" }])).toBe(true);
  });
  it("true when sessionid_ss present", () => {
    expect(hasSessionCookie([{ name: "sessionid_ss", value: "x" }])).toBe(true);
  });
  it("false otherwise", () => {
    expect(hasSessionCookie([{ name: "ttwid", value: "x" }])).toBe(false);
    expect(hasSessionCookie([])).toBe(false);
  });
});
