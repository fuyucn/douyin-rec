import { describe, it, expect } from "vitest";
import {
  EXPERIMENTAL_FEATURES, getExperimentalFeature, isExperimental, experimentalByLayer, experimentalDefaultKey, isGraduated,
} from "./experimental.js";

describe("experimental 注册表", () => {
  it("id 唯一、非空、kebab-case", () => {
    const ids = EXPERIMENTAL_FEATURES.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });
  it("i18n key 全部合规且互不重复;默认状态明确为布尔,首批均默认关闭", () => {
    const keys = EXPERIMENTAL_FEATURES.flatMap((f) => [f.nameKey, f.descKey, f.riskKey, f.whereKey, f.graduationKey]);
    for (const k of keys) expect(k).toMatch(/^experimental\.\w+\.\w+$/);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of EXPERIMENTAL_FEATURES) {
      expect(typeof f.defaultEnabled).toBe("boolean");
      expect(f.defaultEnabled).toBe(false);
      expect(["hub", "task", "global"]).toContain(f.layer);
    }
  });
  it("首批登记 rolling-upload / node-side-upload / segment-part-xml", () => {
    expect(isExperimental("rolling-upload")).toBe(true);
    expect(isExperimental("node-side-upload")).toBe(true);
    expect(isExperimental("segment-part-xml")).toBe(true);
    expect(getExperimentalFeature("rolling-upload")?.layer).toBe("hub");
  });
  it("未登记 id → undefined / false;按层过滤", () => {
    expect(getExperimentalFeature("nope")).toBeUndefined();
    expect(isExperimental("nope")).toBe(false);
    expect(experimentalByLayer("hub").length).toBe(EXPERIMENTAL_FEATURES.length);
    expect(experimentalByLayer("global")).toEqual([]);
  });
  it("默认策略 key 随 defaultEnabled", () => {
    expect(experimentalDefaultKey({ defaultEnabled: false })).toBe("experimental.defaultOff");
    expect(experimentalDefaultKey({ defaultEnabled: true })).toBe("experimental.defaultOn");
  });
  it("每项都有退役口径(观察时长 > 0)与跟踪票(正整数或 null);rolling / 分段 xml 有票号", () => {
    for (const f of EXPERIMENTAL_FEATURES) {
      expect(f.graduation.observeHours).toBeGreaterThan(0);
      expect(f.trackingIssue === null || (Number.isInteger(f.trackingIssue) && f.trackingIssue > 0)).toBe(true);
    }
    expect(getExperimentalFeature("rolling-upload")?.trackingIssue).toBe(40);
    expect(getExperimentalFeature("segment-part-xml")?.trackingIssue).toBe(7);
  });
  it("isGraduated:观察满 48h 且票已关才退役;票未关或不足时长都不退", () => {
    const f = { graduation: { observeHours: 48, closeTrackingIssue: true } };
    expect(isGraduated(f, { observedHours: 48, trackingIssueClosed: true })).toBe(true);
    expect(isGraduated(f, { observedHours: 47, trackingIssueClosed: true })).toBe(false);
    expect(isGraduated(f, { observedHours: 100, trackingIssueClosed: false })).toBe(false);
    expect(isGraduated({ graduation: { observeHours: 48, closeTrackingIssue: false } }, { observedHours: 48, trackingIssueClosed: false })).toBe(true);
  });
});
