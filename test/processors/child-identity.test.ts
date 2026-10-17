import { describe, it, expect } from "vitest";
import { isSameChild } from "../../packages/processors/src/child-identity.js";

describe("child identity (plan 038 T07)", () => {
  it("pid 相同但 startedAt 不同 → 不是同一个子进程(pid 复用)", () => {
    expect(isSameChild({ pid: 42, startedAt: "t1" }, { pid: 42, startedAt: "t2", cmdline: "biliup" })).toBe(false);
  });
  it("pid 与 startedAt 都匹配 → 是同一个", () => {
    expect(isSameChild({ pid: 42, startedAt: "t1" }, { pid: 42, startedAt: "t1", cmdline: "biliup" })).toBe(true);
  });
  it("进程不在 / 记录缺失 → false(调用方须转 uncertain)", () => {
    expect(isSameChild({ pid: 42, startedAt: "t1" }, null)).toBe(false);
    expect(isSameChild({ pid: null, startedAt: null }, { pid: 42, startedAt: "t1", cmdline: "" })).toBe(false);
  });
});
