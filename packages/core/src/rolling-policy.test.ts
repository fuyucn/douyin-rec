import { describe, it, expect } from "vitest";
import { resolveRollingPolicy, normalizeUploadMode, isUploadingMode } from "./rolling-policy.js";

describe("normalizeUploadMode / isUploadingMode", () => {
  it("三个合法值原样;未配置 → undefined;其它(含旧 stage-only)→ stage", () => {
    expect(normalizeUploadMode("rolling")).toBe("rolling");
    expect(normalizeUploadMode("upload")).toBe("upload");
    expect(normalizeUploadMode("stage")).toBe("stage");
    expect(normalizeUploadMode(undefined)).toBeUndefined();
    expect(normalizeUploadMode(null)).toBeUndefined();
    expect(normalizeUploadMode("  ")).toBeUndefined();
    expect(normalizeUploadMode("stage-only")).toBe("stage");
  });
  it("upload 与 rolling 都算「会上传」,stage/未配置不算", () => {
    expect(isUploadingMode("upload")).toBe(true);
    expect(isUploadingMode("rolling")).toBe(true);
    expect(isUploadingMode("stage")).toBe(false);
    expect(isUploadingMode(undefined)).toBe(false);
    expect(isUploadingMode("stage-only")).toBe(false);
  });
});

describe("resolveRollingPolicy — 唯一判定(规则优先级 / 旧开关迁移 / 单节点闸门)", () => {
  it("规则 mode=rolling + 恰好 1 个节点 → 生效(不需要旧开关)", () => {
    expect(resolveRollingPolicy({ mode: "rolling", workers: ["vps2"] }, false)).toEqual({ effective: true, reason: "rule-rolling" });
  });
  it("规则 mode=rolling 但未勾选 workers(= 全部)/ 多节点 → 不生效(防重复投稿)", () => {
    expect(resolveRollingPolicy({ mode: "rolling" }, false)).toEqual({ effective: false, reason: "multi-node" });
    expect(resolveRollingPolicy({ mode: "rolling", workers: [] }, true)).toEqual({ effective: false, reason: "multi-node" });
    expect(resolveRollingPolicy({ mode: "rolling", workers: ["a", "b"] }, false).effective).toBe(false);
  });
  it("规则显式 stage → 压过旧开关(旧开关不得绕过规则去上传)", () => {
    expect(resolveRollingPolicy({ mode: "stage", workers: ["a"] }, true)).toEqual({ effective: false, reason: "rule-stage" });
    expect(resolveRollingPolicy({ mode: "stage-only", workers: ["a"] }, true).effective).toBe(false);
  });
  it("旧开关 true 的迁移:无规则(单机任务)≡ rolling", () => {
    expect(resolveRollingPolicy(null, true)).toEqual({ effective: true, reason: "legacy-task-flag" });
    expect(resolveRollingPolicy(undefined, true).effective).toBe(true);
  });
  it("旧开关 true 的迁移:规则存在但未配 mode / mode=upload ≡ rolling(与改前行为一致),仍过单节点闸门", () => {
    expect(resolveRollingPolicy({ workers: ["a"] }, true).effective).toBe(true);
    expect(resolveRollingPolicy({ mode: "upload", workers: ["a"] }, true).effective).toBe(true);
    expect(resolveRollingPolicy({ mode: "upload" }, true)).toEqual({ effective: false, reason: "multi-node" });
    expect(resolveRollingPolicy({ mode: "upload", workers: ["a", "b"] }, true).effective).toBe(false);
  });
  it("旧开关 false 且规则不是 rolling → 不生效", () => {
    expect(resolveRollingPolicy(null, false)).toEqual({ effective: false, reason: "not-requested" });
    expect(resolveRollingPolicy({ mode: "upload", workers: ["a"] }, false)).toEqual({ effective: false, reason: "not-requested" });
  });
  it("无规则时 workers 无意义(单机恒单节点)", () => {
    expect(resolveRollingPolicy(null, true).effective).toBe(true);
  });
});

describe("resolveRollingPolicy — 规则停用视为关闭(issue #40 返工)", () => {
  it("enabled=false:mode=rolling / 旧开关 true / mode=upload 一律不生效", () => {
    expect(resolveRollingPolicy({ enabled: false, mode: "rolling", workers: ["a"] }, false)).toEqual({ effective: false, reason: "rule-disabled" });
    expect(resolveRollingPolicy({ enabled: false, workers: ["a"] }, true).effective).toBe(false);
    expect(resolveRollingPolicy({ enabled: false, mode: "upload", workers: ["a"] }, true).effective).toBe(false);
  });
  it("enabled=true / 未给 enabled(旧调用方)照常判定", () => {
    expect(resolveRollingPolicy({ enabled: true, mode: "rolling", workers: ["a"] }, false).effective).toBe(true);
    expect(resolveRollingPolicy({ mode: "rolling", workers: ["a"] }, false).effective).toBe(true);
  });
});

