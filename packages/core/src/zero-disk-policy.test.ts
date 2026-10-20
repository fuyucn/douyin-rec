import { describe, expect, it } from "vitest";
import { zeroDiskRuleError } from "./zero-disk-policy.js";

const RULE = { enabled: true, mode: "rolling", workers: ["local"], steps: { burnDanmu: false, burnLivechat: false } };

describe("zeroDiskRuleError — zero-disk is a rolling sub-mode", () => {
  it("allows rolling + no burn + local-only", () => {
    expect(zeroDiskRuleError(true, RULE)).toBeNull();
  });
  it("a disabled rule is allowed (pausing a room must not force zero-disk off)", () => {
    expect(zeroDiskRuleError(true, { ...RULE, enabled: false })).toBeNull();
  });
  it("non-rolling / burning / multi-node are rejected with a reason", () => {
    expect(zeroDiskRuleError(true, { ...RULE, mode: "upload" })).toContain("rolling");
    expect(zeroDiskRuleError(true, { ...RULE, mode: "stage" })).toContain("rolling");
    expect(zeroDiskRuleError(true, { ...RULE, steps: { burnDanmu: true, burnLivechat: false } })).toContain("烧录");
    expect(zeroDiskRuleError(true, { ...RULE, workers: ["local", "vps1"] })).toContain("local");
    expect(zeroDiskRuleError(true, { ...RULE, workers: ["vps1"] })).toContain("local");
    expect(zeroDiskRuleError(true, { ...RULE, workers: [] })).toContain("local");
  });
  it("a task without a rule is left alone (manual/debug compatibility)", () => {
    expect(zeroDiskRuleError(true, null)).toBeNull();
    expect(zeroDiskRuleError(false, RULE)).toBeNull();
  });
});
