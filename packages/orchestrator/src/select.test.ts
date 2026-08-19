import { describe, it, expect } from "vitest";
import { coverageOf, selectWinner } from "./select.js";
import type { Broadcast } from "./identity.js";
import type { NodeRecording } from "./transport.js";

const rec = (over: Partial<NodeRecording>): NodeRecording => ({
  roomSlug: "411", platform: "douyin", sessionBase: "s", tsFiles: [], durationSec: 1000,
  startMs: 0, endMs: 1_000_000, totalGapSec: 0, ...over,
});
const bc = (recs: NodeRecording[]): Broadcast => ({
  streamKey: "k", platform: "douyin", roomSlug: "411", startMs: 0,
  members: recs.map((r, i) => ({ workerId: `n${i}`, rec: r })),
});

describe("覆盖度选优", () => {
  it("coverageOf：无缺口=1，有缺口按比例", () => {
    expect(coverageOf(rec({}))).toBeCloseTo(1);
    expect(coverageOf(rec({ totalGapSec: 100 }))).toBeCloseTo(0.9); // span 1000s, gap 100
  });
  it("有抖动那台落选，干净那台胜出且 clean=true", () => {
    const s = selectWinner(bc([rec({ totalGapSec: 120 }), rec({ totalGapSec: 0 })]), 30);
    expect(s.winner?.workerId).toBe("n1");
    expect(s.clean).toBe(true);
  });
  it("都断 → 仍选最优但 clean=false", () => {
    const s = selectWinner(bc([rec({ totalGapSec: 120 }), rec({ totalGapSec: 200 })]), 30);
    expect(s.winner?.workerId).toBe("n0"); // 缺口少者覆盖高
    expect(s.clean).toBe(false);
  });
  it("同 tenant 多会话(断流重连=新会话,各自无内部缺口)→ 视为完整,合并所有会话", () => {
    // 单一 tenant 'A' 在本场断流成 2 个会话(各自 gap=0)→ 现在按「断流重连=同一场」处理,可整场拼接。
    const b: Broadcast = {
      streamKey: "k", platform: "douyin", roomSlug: "411", startMs: 0,
      members: [
        { workerId: "A", rec: rec({ sessionBase: "s1", durationSec: 1800, totalGapSec: 0 }) },
        { workerId: "A", rec: rec({ sessionBase: "s2", durationSec: 3000, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(true);              // A 两会话内部都完整 → 可自动拼
    expect(s.winner?.workerId).toBe("A");
    expect(s.winnerMembers.map((m) => m.rec.sessionBase)).toEqual(["s1", "s2"]);
  });
  it("只录到第一段的单会话 vs 断流重连录全整场 → 选录全的,不合并半场", () => {
    const startMs = 1_700_000_000_000;
    const b: Broadcast = {
      streamKey: "k", platform: "douyin", roomSlug: "411", startMs,
      members: [
        { workerId: "partial", rec: rec({ sessionBase: "p1", startMs, endMs: startMs + 30 * 60_000, durationSec: 1800, totalGapSec: 0 }) },
        { workerId: "full", rec: rec({ sessionBase: "f1", startMs, endMs: startMs + 30 * 60_000, durationSec: 1800, totalGapSec: 0 }) },
        { workerId: "full", rec: rec({ sessionBase: "f2", startMs: startMs + 35 * 60_000, endMs: startMs + 65 * 60_000, durationSec: 3000, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(true);
    expect(s.winner?.workerId).toBe("full");
    expect(s.winnerMembers.map((m) => m.rec.sessionBase)).toEqual(["f1", "f2"]);
  });
  it("单会话完整 + 另一台断流多会话(总时长更长)→ 仍选单会话完整那台,clean=true", () => {
    const b: Broadcast = {
      streamKey: "k", platform: "douyin", roomSlug: "411", startMs: 0,
      members: [
        { workerId: "complete", rec: rec({ sessionBase: "c", durationSec: 3600, totalGapSec: 0 }) },
        { workerId: "broken", rec: rec({ sessionBase: "b1", durationSec: 2000, totalGapSec: 0 }) },
        { workerId: "broken", rec: rec({ sessionBase: "b2", durationSec: 2500, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(true);
    expect(s.winner?.workerId).toBe("complete"); // 无断流痕迹优先,不因 broken 两段合计更长而拼段
    expect(s.winnerMembers).toHaveLength(1);
  });
  it("两台都是多会话断流重连(各会话内部无缺口)→ 总时长更长那台胜,clean=true", () => {
    const b: Broadcast = {
      streamKey: "k", platform: "douyin", roomSlug: "411", startMs: 0,
      members: [
        { workerId: "a", rec: rec({ sessionBase: "a1", durationSec: 2000, totalGapSec: 0 }) },
        { workerId: "a", rec: rec({ sessionBase: "a2", durationSec: 2000, totalGapSec: 0 }) },
        { workerId: "b", rec: rec({ sessionBase: "b1", durationSec: 2500, totalGapSec: 0 }) },
        { workerId: "b", rec: rec({ sessionBase: "b2", durationSec: 2500, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(true);
    expect(s.winner?.workerId).toBe("b"); // 两会话都完整,取合计更长
    expect(s.winnerMembers.map((m) => m.rec.sessionBase)).toEqual(["b1", "b2"]);
  });
  it("都断(各会话内部有缺口)→ 仍选最优但 clean=false", () => {
    const b: Broadcast = {
      streamKey: "k", platform: "douyin", roomSlug: "411", startMs: 0,
      members: [
        { workerId: "A", rec: rec({ sessionBase: "s1", durationSec: 1800, totalGapSec: 120 }) },
        { workerId: "A", rec: rec({ sessionBase: "s2", durationSec: 3000, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(false); // s1 内部断流超阈值 → 该 worker 不完整
    expect(s.winner?.workerId).toBe("A");
  });
  it("单会话只晚开录约30s vs 另一台断链多会话 → 选连续那台,并按 worker 聚合指标", () => {
    // 2026-08-19 一勺小苏打: VPS 连续 6742s, local 断成 3 段。旧 30s 首尾容差会把 VPS 判成没覆盖。
    const local1Start = 1_787_150_715_170;
    const b: Broadcast = {
      streamKey: "k", platform: "douyin", roomSlug: "411", startMs: local1Start,
      members: [
        { workerId: "local", rec: rec({ sessionBase: "l1", durationSec: 2366.308, startMs: local1Start, endMs: 1_787_153_147_756, totalGapSec: 0 }) },
        { workerId: "vps2", rec: rec({ sessionBase: "v1", durationSec: 6742.328, startMs: 1_787_150_745_181, endMs: 1_787_157_491_724, totalGapSec: 0 }) },
        { workerId: "local", rec: rec({ sessionBase: "l2", durationSec: 2938.023, startMs: 1_787_153_155_068, endMs: 1_787_156_092_955, totalGapSec: 0 }) },
        { workerId: "local", rec: rec({ sessionBase: "l3", durationSec: 1322.31, startMs: 1_787_156_169_422, endMs: 1_787_157_491_732, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(true);
    expect(s.winner?.workerId).toBe("vps2");
    expect(s.winnerMembers).toHaveLength(1);
    expect(s.perNode).toHaveLength(2);
    const local = s.perNode.find((n) => n.workerId === "local");
    const vps = s.perNode.find((n) => n.workerId === "vps2");
    expect(local?.durationSec).toBeCloseTo(6626.641);
    expect(vps?.durationSec).toBeCloseTo(6742.328);
    expect(vps?.totalGapSec).toBe(0);
    expect(local?.totalGapSec).toBeGreaterThan(70);
  });
});
