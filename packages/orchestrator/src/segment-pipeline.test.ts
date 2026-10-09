// 分段上传路径的弹幕窗口/分组纯函数回归(2026-10-09「什么鱼」livechat 分 P 缺失根因)。
import { describe, it, expect } from "vitest";
import { sessionWindowOffsets, splitGroupsBySession } from "./segment-pipeline.js";

describe("sessionWindowOffsets：弹幕窗口按会话分开累计", () => {
  it("单会话:窗口连续累计(与旧行为一致)", () => {
    const off = sessionWindowOffsets();
    expect(off("/s/a.xml", 3600)).toEqual({ startSec: 0, endSec: 3600 });
    expect(off("/s/a.xml", 3600)).toEqual({ startSec: 3600, endSec: 7200 });
    expect(off("/s/a.xml", 600)).toEqual({ startSec: 7200, endSec: 7800 });
  });

  it("断流重连(两会话):新会话从 0 重新计,不沿用上一会话的 offset", () => {
    // 复现 2026-10-09 什么鱼:会话1 三段 ~10128s → 会话2 三段。
    // 旧实现整场累计 → 会话2 窗口 [10128..20178],远超会话2 xml 时长(~10050s)→ 0 条命中。
    const off = sessionWindowOffsets();
    const s1 = "/s/什么鱼_2026-10-09_07-21-26.xml";
    const s2 = "/s/什么鱼_2026-10-09_10-12-24.xml";
    expect(off(s1, 3602)).toEqual({ startSec: 0, endSec: 3602 });
    expect(off(s1, 3600)).toEqual({ startSec: 3602, endSec: 7202 });
    expect(off(s1, 2926)).toEqual({ startSec: 7202, endSec: 10128 });
    // 新会话:必须从 0 起(修复点;旧实现会是 10128)
    expect(off(s2, 3601)).toEqual({ startSec: 0, endSec: 3601 });
    expect(off(s2, 3601)).toEqual({ startSec: 3601, endSec: 7202 });
    expect(off(s2, 2848)).toEqual({ startSec: 7202, endSec: 10050 });
  });

  it("交错出现(会话A→B→A):各会话各自独立计数,不串台", () => {
    const off = sessionWindowOffsets();
    expect(off("a", 100)).toEqual({ startSec: 0, endSec: 100 });
    expect(off("b", 50)).toEqual({ startSec: 0, endSec: 50 });
    expect(off("a", 100)).toEqual({ startSec: 100, endSec: 200 });
    expect(off("b", 50)).toEqual({ startSec: 50, endSec: 100 });
  });
});

describe("splitGroupsBySession：分 P 不跨会话", () => {
  it("组内同会话 → 原样保留", () => {
    const xml = (i: number) => (i < 3 ? "a" : "b");
    expect(splitGroupsBySession([[0, 1], [2], [3, 4]], xml)).toEqual([[0, 1], [2], [3, 4]]);
  });

  it("跨会话的组被按边界切开(每份只含一个会话)", () => {
    // 旧实现:[[2,3]] 一个组跨会话 → spanWindow 并集 + 只取首个 xml → 时间轴错位。
    const xml = (i: number) => (i < 3 ? "a" : "b");
    expect(splitGroupsBySession([[2, 3]], xml)).toEqual([[2], [3]]);
    expect(splitGroupsBySession([[0, 1, 2, 3, 4]], xml)).toEqual([[0, 1, 2], [3, 4]]);
  });

  it("无 xml 的段(空串)自成一档,不与有 xml 的段混组", () => {
    const xml = (i: number) => (i === 1 ? "" : "a");
    expect(splitGroupsBySession([[0, 1, 2]], xml)).toEqual([[0], [1], [2]]);
  });

  it("空计划 → 空", () => {
    expect(splitGroupsBySession([], () => "a")).toEqual([]);
  });
});
