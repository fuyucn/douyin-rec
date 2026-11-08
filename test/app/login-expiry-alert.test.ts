/**
 * login-expiry-alert.test.ts — the expiry watchdog's due-alert decision (issue #563).
 *
 * The watchdog used to read only the douyin compat key, so a node whose `platformCookies` entry was the
 * one actually in effect could alert on a string nobody used. `dueCookieAlerts` takes the **effective**
 * strings and decides per platform; that is what this pins.
 */
import { describe, it, expect } from "vitest";
import { dueCookieAlerts, parseCookieExpiry, planCookieAlerts } from "../../packages/app/src/cookie-utils.js";

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
    expect(dueCookieAlerts([{ platform: "douyin", value: douyinExpiringIn(3) }], NOW, 3)).toMatchObject([
      { platform: "douyin", days: 3 },
    ]);
  });

  it("reports expired credentials with negative days", () => {
    expect(dueCookieAlerts([{ platform: "douyin", value: douyinExpiringIn(-2) }], NOW, 3)).toMatchObject([
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
    expect(alerts).toMatchObject([{ platform: "douyin", days: 1 }]);
  });

  it("an unparsable douyin string does not fabricate an alert", () => {
    expect(dueCookieAlerts([{ platform: "douyin", value: "sessionid=A" }], NOW, 3)).toEqual([]);
  });

  it("the expiry it judges is the sid_guard one (loginTs + maxAge, not loginTs)", () => {
    const value = douyinExpiringIn(5);
    expect(parseCookieExpiry(value)).toBeGreaterThan(NOW);
  });
});

describe("planCookieAlerts（跨重启去重，issue #563 部署实测）", () => {
  const due = (expiry: number, days = 2) => ({ platform: "douyin", days, expiry });

  it("same credential was already reported → no repeat after a restart, nothing to persist", () => {
    const raw = JSON.stringify({ douyin: "1000:soon" });
    const plan = planCookieAlerts([due(1000)], raw);
    expect(plan.alerts).toEqual([]);
    expect(plan.changed).toBe(false);
    expect(plan.nextRaw).toBe(raw);
  });

  it("first time (no marker) → alert and persist", () => {
    const plan = planCookieAlerts([due(1000)], null);
    expect(plan.alerts).toHaveLength(1);
    expect(plan.changed).toBe(true);
    expect(plan.nextRaw).toBe(JSON.stringify({ douyin: "1000:soon" }));
  });

  it("credential renewed (new expiry) → alerts again", () => {
    const plan = planCookieAlerts([due(2000)], JSON.stringify({ douyin: "1000:soon" }));
    expect(plan.alerts).toHaveLength(1);
    expect(plan.nextRaw).toBe(JSON.stringify({ douyin: "2000:soon" }));
  });

  it("crossing into expired → alerts once more (severity is part of the key)", () => {
    const plan = planCookieAlerts([due(1000, -2)], JSON.stringify({ douyin: "1000:soon" }));
    expect(plan.alerts).toHaveLength(1);
    expect(plan.nextRaw).toBe(JSON.stringify({ douyin: "1000:expired" }));
  });

  it("nothing due → markers are cleared so a later expiry is not suppressed", () => {
    const plan = planCookieAlerts([], JSON.stringify({ douyin: "1000:soon" }));
    expect(plan.alerts).toEqual([]);
    expect(plan.changed).toBe(true);
    expect(plan.nextRaw).toBe("");
  });

  it("bad JSON reads as 'nothing warned' → still alerts (never silences a real expiry)", () => {
    const plan = planCookieAlerts([due(1000)], "{not json");
    expect(plan.alerts).toHaveLength(1);
    expect(plan.changed).toBe(true);
  });

  it("已过期稳态不重报（marker 命中 expired）", () => {
    const plan = planCookieAlerts([due(1000, -3)], JSON.stringify({ douyin: "1000:expired" }));
    expect(plan.alerts).toEqual([]);
    expect(plan.changed).toBe(false);
  });

  it("sid_guard 含游离 % → 解析不出，不抛(一个坏串不能拖垮整轮)", () => {
    expect(parseCookieExpiry("sessionid=A; sid_guard=tok%ZZ100%7C2%7C3")).toBeNull();
    expect(dueCookieAlerts([{ platform: "douyin", value: "sessionid=A; sid_guard=tok%ZZ100" }], NOW, 3)).toEqual([]);
  });

  it("platforms are independent", () => {
    const plan = planCookieAlerts(
      [due(1000), { platform: "bilibili", days: 1, expiry: 777 }],
      JSON.stringify({ douyin: "1000:soon" }),
    );
    expect(plan.alerts.map((a) => a.platform)).toEqual(["bilibili"]);
    expect(JSON.parse(plan.nextRaw)).toEqual({ douyin: "1000:soon", bilibili: "777:soon" });
  });

  it("到期时刻就是 loginTs+maxAge（不是 loginTs，也不含毫秒误差）", () => {
    expect(parseCookieExpiry(douyinExpiringIn(5))).toBe(NOW + 5 * DAY);
  });
});
