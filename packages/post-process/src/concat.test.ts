// ts/test/post/concat.test.ts
import { describe, it, expect } from "vitest";
import { groupSessions, sortSegments } from "./concat.js";

describe("会话分组 / 分段排序", () => {
  it("sortSegments 按段号数字排序（非字典序）", () => {
    const files = ["a_PART010.ts", "a_PART002.ts", "a_PART000.ts"];
    expect(sortSegments(files)).toEqual(["a_PART000.ts", "a_PART002.ts", "a_PART010.ts"]);
  });
  it("groupSessions 按会话基名聚合 .ts 与 .xml", () => {
    const g = groupSessions([
      "野原_2026-06-10_00-23-33-PART000.ts",
      "野原_2026-06-10_00-23-33-PART001.ts",
      "野原_2026-06-10_00-23-33.xml",
      "别人_2026-06-10_01-00-00.ts",
    ]);
    expect(g["野原_2026-06-10_00-23-33"].ts).toHaveLength(2);
    expect(g["野原_2026-06-10_00-23-33"].xml).toBe("野原_2026-06-10_00-23-33.xml");
    expect(g["野原_2026-06-10_00-23-33"].segmentXmls).toEqual([]);
    expect(g["别人_2026-06-10_01-00-00"].ts).toHaveLength(1);
  });

  it("groupSessions 收集 DLR per-segment xml，与 ts 按段号对齐", () => {
    const g = groupSessions([
      "主播_2026-06-11_15-01-27_002.ts",
      "主播_2026-06-11_15-01-27_000.ts",
      "主播_2026-06-11_15-01-27_001.ts",
      "主播_2026-06-11_15-01-27_002.xml",
      "主播_2026-06-11_15-01-27_000.xml",
      "主播_2026-06-11_15-01-27_001.xml",
    ]);
    const s = g["主播_2026-06-11_15-01-27"];
    expect(s.ts).toEqual([
      "主播_2026-06-11_15-01-27_000.ts",
      "主播_2026-06-11_15-01-27_001.ts",
      "主播_2026-06-11_15-01-27_002.ts",
    ]);
    expect(s.segmentXmls).toEqual([
      "主播_2026-06-11_15-01-27_000.xml",
      "主播_2026-06-11_15-01-27_001.xml",
      "主播_2026-06-11_15-01-27_002.xml",
    ]);
    expect(s.xml).toBeNull(); // 无会话级 {base}.xml
  });

  it("groupSessions 认 .flv 分段（mesio 引擎,低配无 ffmpeg 路径）", () => {
    const g = groupSessions([
      "mesio测试_2026-06-15_21-09-37_001.flv",
      "mesio测试_2026-06-15_21-09-37_000.flv",
      "mesio测试_2026-06-15_21-09-37_002.flv",
    ]);
    const s = g["mesio测试_2026-06-15_21-09-37"];
    expect(s.ts).toEqual([
      "mesio测试_2026-06-15_21-09-37_000.flv",
      "mesio测试_2026-06-15_21-09-37_001.flv",
      "mesio测试_2026-06-15_21-09-37_002.flv",
    ]);
  });

  it("sortSegments 对 .flv 同样按段号排序", () => {
    const files = ["a_010.flv", "a_002.flv", "a_000.flv"];
    expect(sortSegments(files)).toEqual(["a_000.flv", "a_002.flv", "a_010.flv"]);
  });

  it("groupSessions 同时存在会话级 xml 与 per-segment xml（向后兼容）", () => {
    const g = groupSessions([
      "主播_2026-06-11_15-01-27_000.ts",
      "主播_2026-06-11_15-01-27_000.xml",
      "主播_2026-06-11_15-01-27.xml",          // 合并产物会话级 xml
    ]);
    const s = g["主播_2026-06-11_15-01-27"];
    expect(s.xml).toBe("主播_2026-06-11_15-01-27.xml");
    expect(s.segmentXmls).toEqual(["主播_2026-06-11_15-01-27_000.xml"]);
  });
});
