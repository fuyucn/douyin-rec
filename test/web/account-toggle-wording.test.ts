/**
 * account-toggle-wording.test.ts — issue #85: the per-task "use account" toggle is named by what it does
 * (gifts / entries, stream quality), not by the stored field (useCookie); the lock reason names the
 * danmu toggle exactly as it is labelled.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(__dirname, "..", "..", "packages", "web", "src");

/** Same DICT extraction as archive-wording / scripts/check-i18n (i18n.tsx depends on React). */
function loadDict(): Record<"zh" | "en", Record<string, unknown>> {
  const src = readFileSync(join(WEB, "lib", "i18n.tsx"), "utf-8");
  const eq = src.indexOf("=", src.indexOf("const DICT"));
  const open = src.indexOf("{", eq);
  let depth = 0;
  let end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
  }
  return (0, eval)("(" + src.slice(open, end) + ")");
}

function get(o: Record<string, unknown>, key: string): string {
  const v = key.split(".").reduce<unknown>((acc, k) => (acc as Record<string, unknown>)?.[k], o);
  if (typeof v !== "string") throw new Error(`missing i18n key ${key}`);
  return v;
}

/** Keys rendered on or for the account toggle in the task, room and hub rule forms. */
const TOGGLE_KEYS = [
  "rooms.useCookie",
  "rooms.useCookieHintDouyin",
  "rooms.useCookieHintOther",
  "rooms.useCookieNeedCookie",
  "roomForm.useCookieStream",
  "dialog.danmuGift",
  "dialog.giftNeedCookie",
  "dialog.giftOn",
  "tasks.giftCookie",
];

describe("account toggle wording (#85)", () => {
  const dict = loadDict();
  for (const lang of ["zh", "en"] as const) {
    it(`${lang}: toggle copy says account, not cookie`, () => {
      const bad = TOGGLE_KEYS.map((k) => [k, get(dict[lang], k)]).filter(([, v]) => /cookie/i.test(v));
      expect(bad).toEqual([]);
    });
  }
  it("zh: labels name the function (gifts / entries) and the account", () => {
    for (const k of ["rooms.useCookie", "dialog.danmuGift", "roomForm.useCookieStream"]) {
      expect(get(dict.zh, k)).toMatch(/账号信息/);
      expect(get(dict.zh, k)).toMatch(/礼物/);
    }
  });
  it("zh: the needs-danmu lock quotes the danmu toggle label verbatim", () => {
    expect(get(dict.zh, "roomForm.lock.needDanmu")).toContain(`「${get(dict.zh, "rooms.danmu")}」`);
  });
});
