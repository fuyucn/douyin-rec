import { describe, expect, it } from "vitest";
import { parseDanmuFlag, rejectsNoSpoolFlag } from "../../packages/cli/src/cli-flags.js";

describe("--danmu flag (issue #472)", () => {
  it("absent / blank keeps the historical default (on)", () => {
    expect(parseDanmuFlag(undefined)).toBe(true);
    expect(parseDanmuFlag("")).toBe(true);
  });

  it("regression: --danmu no turns danmu off", () => {
    for (const v of ["no", "n", "off", "false", "0", "none", " NO "]) {
      expect(parseDanmuFlag(v), v).toBe(false);
    }
  });

  it("explicit on values stay on", () => {
    for (const v of ["yes", "y", "true", "1", "on"]) expect(parseDanmuFlag(v), v).toBe(true);
  });

  it("legacy provider names / unknown values still mean on", () => {
    for (const v of ["flv", "webcast", "auto"]) expect(parseDanmuFlag(v), v).toBe(true);
  });
});

describe("--stream-upload-spool none (issue #537)", () => {
  it("rejects an explicit none even without --stream-upload 1", () => {
    // The v1 gate only fired when both flags were present, so a lone `none` was silently
    // ignored and the pump still kept a fallback while the operator thought otherwise.
    for (const v of ["none", "NONE", " none "]) expect(rejectsNoSpoolFlag(v), v).toBe(true);
  });

  it("keeps accepting full and absent values", () => {
    for (const v of ["full", "FULL", "", undefined]) expect(rejectsNoSpoolFlag(v), String(v)).toBe(false);
  });
});
