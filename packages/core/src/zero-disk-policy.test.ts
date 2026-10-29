import { describe, expect, it } from "vitest";
import { zeroDiskRuleError } from "./zero-disk-policy.js";

const RULE = { enabled: true, mode: "rolling", workers: ["local"], steps: { burnDanmu: false, burnLivechat: false } };

describe("zeroDiskRuleError — zero-disk is a rolling sub-mode", () => {
  it("allows rolling + no burn + a single local node", () => {
    expect(zeroDiskRuleError(true, RULE)).toBeNull();
  });
  it("a disabled rule is allowed (pausing a room must not force zero-disk off)", () => {
    expect(zeroDiskRuleError(true, { ...RULE, enabled: false })).toBeNull();
  });
  it("allows exactly one side node (issue #331)", () => {
    expect(zeroDiskRuleError(true, { ...RULE, workers: ["vps1"] })).toBeNull();
    expect(zeroDiskRuleError(true, { ...RULE, workers: ["worker-2"] })).toBeNull();
  });
  it("non-rolling / burning / multi-node / no-node are rejected with an accurate reason", () => {
    expect(zeroDiskRuleError(true, { ...RULE, mode: "upload" })).toContain("rolling");
    expect(zeroDiskRuleError(true, { ...RULE, mode: "stage" })).toContain("rolling");
    expect(zeroDiskRuleError(true, { ...RULE, steps: { burnDanmu: true, burnLivechat: false } })).toContain("烧录");
    expect(zeroDiskRuleError(true, { ...RULE, workers: ["local", "vps1"] })).toContain("只能勾选一个节点");
    expect(zeroDiskRuleError(true, { ...RULE, workers: ["vps1", "vps2"] })).toContain("只能勾选一个节点");
    expect(zeroDiskRuleError(true, { ...RULE, workers: [] })).toContain("恰好勾选一个节点");
    expect(zeroDiskRuleError(true, { ...RULE, workers: undefined })).toContain("恰好勾选一个节点");
  });
  it("a task without a rule is left alone (manual/debug compatibility)", () => {
    expect(zeroDiskRuleError(true, null)).toBeNull();
    expect(zeroDiskRuleError(false, RULE)).toBeNull();
  });
});
