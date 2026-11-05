import { describe, expect, it } from "vitest";
import { parseBoolFlag } from "./bool-flag.js";

describe("parseBoolFlag", () => {
  it("keeps the call site's default for undefined / blank values", () => {
    expect(parseBoolFlag(undefined, true)).toBe(true);
    expect(parseBoolFlag(undefined, false)).toBe(false);
    expect(parseBoolFlag("", true)).toBe(true);
    expect(parseBoolFlag("   ", false)).toBe(false);
  });

  it("recognises the off vocabulary", () => {
    for (const v of ["no", "n", "false", "0", "off", "none", " NO ", "N", " 0 "]) {
      expect(parseBoolFlag(v, true), v).toBe(false);
      expect(parseBoolFlag(v, false), v).toBe(false);
    }
  });

  it("recognises the on vocabulary", () => {
    for (const v of ["yes", "y", "true", "1", "on", " YES ", "Y", " 1 "]) {
      expect(parseBoolFlag(v, true), v).toBe(true);
      expect(parseBoolFlag(v, false), v).toBe(true);
    }
  });

  it("keeps the historical meaning of unknown values (on)", () => {
    for (const v of ["flv", "auto", "maybe", "2", "enabled"]) {
      expect(parseBoolFlag(v, true), v).toBe(true);
      expect(parseBoolFlag(v, false), v).toBe(true);
    }
  });
});
