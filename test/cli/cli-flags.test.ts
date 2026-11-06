import { describe, expect, it } from "vitest";
import { parseDanmuFlag } from "../../packages/cli/src/cli-flags.js";

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
