import { describe, expect, it } from "vitest";
import { zeroDiskUploadCookie } from "../../packages/cli/src/zero-disk-upload-cookie.js";

describe("zeroDiskUploadCookie", () => {
  it("uses BILIUP_COOKIE when configured", () => {
    expect(zeroDiskUploadCookie({ BILIUP_COOKIE: "/run/biliup.json" }, "/root/config/biliup/cookies.json"))
      .toBe("/run/biliup.json");
  });

  it("falls back to the configured biliup cookies path", () => {
    expect(zeroDiskUploadCookie({}, "/root/config/biliup/cookies.json"))
      .toBe("/root/config/biliup/cookies.json");
  });

  it("ignores an empty BILIUP_COOKIE", () => {
    expect(zeroDiskUploadCookie({ BILIUP_COOKIE: "  " }, "/root/config/biliup/cookies.json"))
      .toBe("/root/config/biliup/cookies.json");
  });
});
