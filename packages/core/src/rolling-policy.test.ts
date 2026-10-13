import { describe, it, expect } from "vitest";
import { resolveRollingPolicy, normalizeUploadMode, isUploadingMode, burnFlags, pipelineBurns, rollingReasonText } from "./rolling-policy.js";

/** 不烧录:rolling 生效的前提(issue #48);旧用例都在测「别的闸门」,统一关烧录。 */
const NB = { burnDanmu: false, burnLivechat: false };

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
    expect(resolveRollingPolicy({ steps: NB, mode: "rolling", workers: ["vps2"] }, false)).toEqual({ effective: true, reason: "rule-rolling" });
  });
  it("规则 mode=rolling 但未勾选 workers(= 全部)/ 多节点 → 不生效(防重复投稿)", () => {
    expect(resolveRollingPolicy({ steps: NB, mode: "rolling" }, false)).toEqual({ effective: false, reason: "multi-node" });
    expect(resolveRollingPolicy({ steps: NB, mode: "rolling", workers: [] }, true)).toEqual({ effective: false, reason: "multi-node" });
    expect(resolveRollingPolicy({ steps: NB, mode: "rolling", workers: ["a", "b"] }, false).effective).toBe(false);
  });
  it("规则显式 stage → 压过旧开关(旧开关不得绕过规则去上传)", () => {
    expect(resolveRollingPolicy({ steps: NB, mode: "stage", workers: ["a"] }, true)).toEqual({ effective: false, reason: "rule-stage" });
    expect(resolveRollingPolicy({ steps: NB, mode: "stage-only", workers: ["a"] }, true).effective).toBe(false);
  });
  it("旧开关 true 的迁移:无规则(单机任务)≡ rolling", () => {
    expect(resolveRollingPolicy(null, true)).toEqual({ effective: true, reason: "legacy-task-flag" });
    expect(resolveRollingPolicy(undefined, true).effective).toBe(true);
  });
  it("旧开关 true 的迁移:规则存在但未配 mode / mode=upload ≡ rolling(与改前行为一致),仍过单节点闸门", () => {
    expect(resolveRollingPolicy({ steps: NB, workers: ["a"] }, true).effective).toBe(true);
    expect(resolveRollingPolicy({ steps: NB, mode: "upload", workers: ["a"] }, true).effective).toBe(true);
    expect(resolveRollingPolicy({ steps: NB, mode: "upload" }, true)).toEqual({ effective: false, reason: "multi-node" });
    expect(resolveRollingPolicy({ steps: NB, mode: "upload", workers: ["a", "b"] }, true).effective).toBe(false);
  });
  it("旧开关 false 且规则不是 rolling → 不生效", () => {
    expect(resolveRollingPolicy(null, false)).toEqual({ effective: false, reason: "not-requested" });
    expect(resolveRollingPolicy({ steps: NB, mode: "upload", workers: ["a"] }, false)).toEqual({ effective: false, reason: "not-requested" });
  });
  it("无规则时 workers 无意义(单机恒单节点)", () => {
    expect(resolveRollingPolicy(null, true).effective).toBe(true);
  });
});

describe("resolveRollingPolicy — 规则停用视为关闭(issue #40 返工)", () => {
  it("enabled=false:mode=rolling / 旧开关 true / mode=upload 一律不生效", () => {
    expect(resolveRollingPolicy({ steps: NB, enabled: false, mode: "rolling", workers: ["a"] }, false)).toEqual({ effective: false, reason: "rule-disabled" });
    expect(resolveRollingPolicy({ steps: NB, enabled: false, workers: ["a"] }, true).effective).toBe(false);
    expect(resolveRollingPolicy({ steps: NB, enabled: false, mode: "upload", workers: ["a"] }, true).effective).toBe(false);
  });
  it("enabled=true / 未给 enabled(旧调用方)照常判定", () => {
    expect(resolveRollingPolicy({ steps: NB, enabled: true, mode: "rolling", workers: ["a"] }, false).effective).toBe(true);
    expect(resolveRollingPolicy({ steps: NB, mode: "rolling", workers: ["a"] }, false).effective).toBe(true);
  });
});


describe("burnFlags / pipelineBurns — 烧录开关唯一口径(issue #48)", () => {
  it("缺省都是开(与 orchestrator `!== false` 同口径);只有显式 false 才关", () => {
    expect(burnFlags(undefined)).toEqual({ burnDanmu: true, burnLivechat: true });
    expect(burnFlags(null)).toEqual({ burnDanmu: true, burnLivechat: true });
    expect(burnFlags({})).toEqual({ burnDanmu: true, burnLivechat: true });
    expect(burnFlags({ burnDanmu: false })).toEqual({ burnDanmu: false, burnLivechat: true });
    expect(burnFlags({ burnLivechat: false })).toEqual({ burnDanmu: true, burnLivechat: false });
  });
  it("任一烧录开 → pipelineBurns;两个都显式关才不烧", () => {
    expect(pipelineBurns(undefined)).toBe(true);
    expect(pipelineBurns({ burnDanmu: false })).toBe(true);
    expect(pipelineBurns({ burnLivechat: false })).toBe(true);
    expect(pipelineBurns({ burnDanmu: false, burnLivechat: false })).toBe(false);
  });
});

describe("resolveRollingPolicy — rolling × 烧录 × 节点数 矩阵(issue #48)", () => {
  const steps = {
    "烧录全开(缺省)": undefined,
    "只烧弹幕": { burnDanmu: true, burnLivechat: false },
    "只烧互动": { burnDanmu: false, burnLivechat: true },
    "全不烧": { burnDanmu: false, burnLivechat: false },
  } as const;
  const nodes = { "单节点": ["a"], "多节点": ["a", "b"], "未勾选(全部)": undefined } as const;

  for (const [sn, st] of Object.entries(steps)) {
    for (const [nn, workers] of Object.entries(nodes)) {
      const burns = sn !== "全不烧";
      const single = nn === "单节点";
      const expected = burns
        ? { effective: false, reason: "needs-burn" }
        : single ? { effective: true, reason: "rule-rolling" } : { effective: false, reason: "multi-node" };
      it(`规则 rolling · ${sn} · ${nn} → ${expected.reason}`, () => {
        expect(resolveRollingPolicy({ mode: "rolling", workers, steps: st }, false)).toEqual(expected);
      });
    }
  }

  it("needs-burn 先于 multi-node(烧录是更根本的原因)", () => {
    expect(resolveRollingPolicy({ mode: "rolling", workers: ["a", "b"] }, false).reason).toBe("needs-burn");
  });
  it("旧开关迁移(规则 upload / 无 mode)+ 烧录开 → 同样 needs-burn,不得靠旧开关绕过", () => {
    expect(resolveRollingPolicy({ mode: "upload", workers: ["a"] }, true)).toEqual({ effective: false, reason: "needs-burn" });
    expect(resolveRollingPolicy({ workers: ["a"], steps: { burnDanmu: true, burnLivechat: false } }, true).reason).toBe("needs-burn");
  });
  it("未请求 rolling 时烧录不改变原因:stage → rule-stage;旧开关 false → not-requested;停用 → rule-disabled", () => {
    expect(resolveRollingPolicy({ mode: "stage", workers: ["a"] }, true).reason).toBe("rule-stage");
    expect(resolveRollingPolicy({ mode: "upload", workers: ["a"] }, false).reason).toBe("not-requested");
    expect(resolveRollingPolicy({ enabled: false, mode: "rolling", workers: ["a"] }, false).reason).toBe("rule-disabled");
  });
  it("无规则(单机任务,无后处理管线)不涉及烧录:旧开关 true 仍 legacy-task-flag 生效", () => {
    expect(resolveRollingPolicy(null, true)).toEqual({ effective: true, reason: "legacy-task-flag" });
  });
  it("rollingReasonText 覆盖所有 reason,needs-burn 文案点明互斥原因", () => {
    for (const r of ["rule-rolling", "legacy-task-flag", "rule-disabled", "rule-stage", "not-requested", "needs-burn", "multi-node"] as const) {
      expect(rollingReasonText(r).length).toBeGreaterThan(0);
    }
    expect(rollingReasonText("needs-burn")).toContain("烧录");
  });
});
