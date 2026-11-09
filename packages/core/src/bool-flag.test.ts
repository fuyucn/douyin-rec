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

// H-974: strict parser for the upload switches. Unknown values must be an explicit failure
// (never a silent "on" and never a throw); blank/absent keeps the call site's default.
import { parseStrictBoolFlag } from "./bool-flag.js";

describe("parseStrictBoolFlag", () => {
  it("keeps the call site's default for undefined / blank values (both defaults)", () => {
    for (const v of [undefined, "", "   ", "\t", " \n "]) {
      expect(parseStrictBoolFlag("--rolling-upload", v, false), String(v)).toEqual({ ok: true, value: false });
      expect(parseStrictBoolFlag("--rolling-upload", v, true), String(v)).toEqual({ ok: true, value: true });
    }
  });

  it("recognises the off vocabulary, ignoring case and surrounding whitespace", () => {
    for (const v of ["no", "n", "false", "0", "off", "none", " NO ", "N", " 0 ", "False", "\tnone\t"]) {
      expect(parseStrictBoolFlag("--rolling-upload", v, true), v).toEqual({ ok: true, value: false });
    }
  });

  it("recognises the on vocabulary, ignoring case and surrounding whitespace", () => {
    for (const v of ["yes", "y", "true", "1", "on", " YES ", "Y", " 1 ", "TRUE", " on "]) {
      expect(parseStrictBoolFlag("--rolling-upload", v, false), v).toEqual({ ok: true, value: true });
    }
  });

  it("fails on unknown values with the exact error text", () => {
    for (const v of ["enble", "2", "01", "是", "NOPE", " f ", "Disabled", "flv", "auto"]) {
      expect(parseStrictBoolFlag("--rolling-upload", v, false), v).toEqual({
        ok: false,
        error: `--rolling-upload 取值无效: "${v}"(可用 0/1、on/off、yes/no、true/false)`,
      });
    }
  });

  it("quotes the raw value as typed (not trimmed, original case)", () => {
    const r = parseStrictBoolFlag("--stream-upload", " NOPE ", false);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('" NOPE "');
  });

  it("failure results carry no value key", () => {
    const r = parseStrictBoolFlag("--rolling-upload", "enble", false);
    expect(r.ok).toBe(false);
    expect("value" in r).toBe(false);
    if (!r.ok) expect(r.error).toBeTypeOf("string");
  });

  it("error message names the flag", () => {
    const r = parseStrictBoolFlag("--stream-upload", "maybe", false);
    if (!r.ok) expect(r.error.startsWith("--stream-upload 取值无效")).toBe(true);
  });
});
