/**
 * Issue #479: the Douyin API mode resolver — an explicit per-call value (the live gate's option) wins over
 * the process env (the record child's `DOUYIN_REC_API_MODE`), and an unknown value never selects a bogus
 * endpoint. Only the pure resolver is covered here (its own precedence rules); that the platform actually
 * forwards the per-call value to getInfo is pinned separately in platform-getliving.test.ts, where the
 * sm-crypto-heavy `./stream/index.js` is mocked so `douyin-live`'s entry can be imported.
 */
import { afterEach, describe, expect, it } from "vitest";
import { resolveApiMode } from "../../packages/douyin-live/src/api-mode.js";
import { DEFAULT_DOUYIN_API_MODE } from "@drec/core";

const KEY = "DOUYIN_REC_API_MODE";
afterEach(() => { delete process.env[KEY]; });

describe("resolveApiMode precedence (issue #479)", () => {
  it("per-call value wins over the env", () => {
    process.env[KEY] = "mobile";
    expect(resolveApiMode("web")).toBe("web");
    expect(resolveApiMode()).toBe("mobile"); // omitted → env, exactly as before
  });

  it("no per-call value and no env → the default", () => {
    expect(resolveApiMode()).toBe(DEFAULT_DOUYIN_API_MODE);
    expect(resolveApiMode(undefined)).toBe(DEFAULT_DOUYIN_API_MODE);
    expect(resolveApiMode("  ")).toBe(DEFAULT_DOUYIN_API_MODE); // blank is not a mode
  });

  it("an unknown per-call value normalizes to the default instead of reaching the platform", () => {
    process.env[KEY] = "mobile";
    expect(resolveApiMode("bogus")).toBe(DEFAULT_DOUYIN_API_MODE); // explicit garbage wins the precedence…
    expect(resolveApiMode("WEB")).toBe(DEFAULT_DOUYIN_API_MODE); // …and is matched exactly (no case folding)
  });

  it("an unknown env value normalizes to the default", () => {
    process.env[KEY] = "bogus";
    expect(resolveApiMode()).toBe(DEFAULT_DOUYIN_API_MODE);
  });
});

