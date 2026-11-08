/**
 * login-expiry-alert.test.ts — the expiry watchdog's due-alert decision (issue #563).
 *
 * The watchdog used to read only the douyin compat key, so a node whose `platformCookies` entry was the
 * one actually in effect could alert on a string nobody used. `dueCookieAlerts` takes the **effective**
 * strings and decides per platform; that is what this pins.
 */
import { describe, it, expect } from "vitest";
import { dueCookieAlerts, parseCookieExpiry } from "../../packages/app/src/cookie-utils.js";

const DAY = 86_400_000;
const NOW = 1_760_000_000_000;
/** sid_guard = `<tok>|<loginTsSec>|<maxAgeSec>|<GMT>` (URL-encoded pipes, as platforms send them). */
const douyinExpiringIn = (days: number): string => {
  const loginTs = Math.floor(NOW / 1000) - 3600;
  const maxAge = Math.round((days * DAY) / 1000) + 3600;
  return `sessionid=A; sid_guard=tok%7C${loginTs}%7C${maxAge}%7CWed`;
};

describe("dueCookieAlerts", () => {
  it("no alert when the effective credential is beyond the threshold", () => {
    expect(dueCookieAlerts([{ platform: "douyin", value: douyinExpiringIn(30) }], NOW, 3)).toEqual([]);
  });

  it("alerts on the boundary day (<= N days, same floor() as the watchdog message)", () => {
    expect(dueCookieAlerts([{ platform: "douyin", value: douyinExpiringIn(3) }], NOW, 3)).toEqual([
      { platform: "douyin", days: 3 },
    ]);
  });

  it("reports expired credentials with negative days", () => {
    expect(dueCookieAlerts([{ platform: "douyin", value: douyinExpiringIn(-2) }], NOW, 3)).toEqual([
      { platform: "douyin", days: -2 },
    ]);
  });

  it("only platforms with a parsable expiry participate (bilibili stays quiet)", () => {
    const alerts = dueCookieAlerts(
      [
        { platform: "douyin", value: douyinExpiringIn(1) },
        { platform: "bilibili", value: "SESSDATA=ABC; bili_jct=DEF" },
        { platform: "kuaishou", value: null },
      ],
      NOW,
      3,
    );
    expect(alerts).toEqual([{ platform: "douyin", days: 1 }]);
  });

  it("an unparsable douyin string does not fabricate an alert", () => {
    expect(dueCookieAlerts([{ platform: "douyin", value: "sessionid=A" }], NOW, 3)).toEqual([]);
  });

  it("the expiry it judges is the sid_guard one (loginTs + maxAge, not loginTs)", () => {
    const value = douyinExpiringIn(5);
    expect(parseCookieExpiry(value)).toBeGreaterThan(NOW);
  });
});
