import { describe, it, expect } from "vitest";
import { isSameChild } from "@drec/core";

describe("child identity (plan 038 T07)", () => {
  it("same pid but different startedAt is not the same child (pid reuse)", () => {
    expect(isSameChild({ pid: 42, startedAt: "t1" }, { pid: 42, startedAt: "t2", cmdline: "biliup" })).toBe(false);
  });
  it("matching pid and startedAt is the same child", () => {
    expect(isSameChild({ pid: 42, startedAt: "t1" }, { pid: 42, startedAt: "t1", cmdline: "biliup" })).toBe(true);
  });
  it("missing process or record -> false (callers must go uncertain)", () => {
    expect(isSameChild({ pid: 42, startedAt: "t1" }, null)).toBe(false);
    expect(isSameChild({ pid: null, startedAt: null }, { pid: 42, startedAt: "t1", cmdline: "" })).toBe(false);
  });
});
