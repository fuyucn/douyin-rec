import { describe, it, expect } from "vitest";
import { parseSchedule, toDanmuFlag, parseBoolFlag } from "../../packages/app/src/task-input.js";

describe("parseSchedule", () => {
  it("parses HH:MM-HH:MM with optional leading zero", () => {
    expect(parseSchedule("08:00-12:00")).toEqual(["08:00", "12:00"]);
    expect(parseSchedule("8:00-9:30")).toEqual(["8:00", "9:30"]);
  });

  it("trims surrounding whitespace", () => {
    expect(parseSchedule("  20:15-23:45  ")).toEqual(["20:15", "23:45"]);
  });

  it("throws on empty or malformed input", () => {
    expect(() => parseSchedule("")).toThrow(/HH:MM-HH:MM/);
    expect(() => parseSchedule("8-12")).toThrow(/HH:MM-HH:MM/);
    expect(() => parseSchedule("08:00 12:00")).toThrow(/HH:MM-HH:MM/);
    expect(() => parseSchedule("08:00-12")).toThrow(/HH:MM-HH:MM/);
  });
});

describe("toDanmuFlag", () => {
  it("defaults to 1 when undefined", () => {
    expect(toDanmuFlag(undefined)).toBe(1);
  });

  it("maps booleans and numbers", () => {
    expect(toDanmuFlag(true)).toBe(1);
    expect(toDanmuFlag(false)).toBe(0);
    expect(toDanmuFlag(1)).toBe(1);
    expect(toDanmuFlag(0)).toBe(0);
  });

  it("maps flag strings case/space-insensitively", () => {
    expect(toDanmuFlag("1")).toBe(1);
    expect(toDanmuFlag("on")).toBe(1);
    expect(toDanmuFlag("TRUE")).toBe(1);
    expect(toDanmuFlag(" 0 ")).toBe(0);
    expect(toDanmuFlag("off")).toBe(0);
    expect(toDanmuFlag("false")).toBe(0);
    expect(toDanmuFlag("no")).toBe(0);
    expect(toDanmuFlag("none")).toBe(0);
  });
});

describe("parseBoolFlag", () => {
  it("returns the default when undefined", () => {
    expect(parseBoolFlag(undefined, true)).toBe(true);
    expect(parseBoolFlag(undefined, false)).toBe(false);
  });

  it("treats 0/off/false/no/none as false and the rest as true", () => {
    expect(parseBoolFlag("1", false)).toBe(true);
    expect(parseBoolFlag("yes", false)).toBe(true);
    expect(parseBoolFlag("0", true)).toBe(false);
    expect(parseBoolFlag(" OFF ", true)).toBe(false);
    expect(parseBoolFlag("False", true)).toBe(false);
    expect(parseBoolFlag("no", true)).toBe(false);
    expect(parseBoolFlag("none", true)).toBe(false);
  });
});
