import { describe, it, expect } from "vitest";
import { coverageOf, selectWinner } from "./select.js";
import type { Broadcast } from "./identity.js";
import type { NodeRecording } from "./transport.js";

const rec = (over: Partial<NodeRecording>): NodeRecording => ({
  roomSlug: "411", sessionBase: "s", tsFiles: [], durationSec: 1000,
  startMs: 0, endMs: 1_000_000, totalGapSec: 0, ...over,
});
const bc = (recs: NodeRecording[]): Broadcast => ({
  streamKey: "k", roomSlug: "411", startMs: 0,
  members: recs.map((r, i) => ({ tenantId: `n${i}`, rec: r })),
});

describe("覆盖度选优", () => {
  it("coverageOf：无缺口=1，有缺口按比例", () => {
    expect(coverageOf(rec({}))).toBeCloseTo(1);
    expect(coverageOf(rec({ totalGapSec: 100 }))).toBeCloseTo(0.9); // span 1000s, gap 100
  });
  it("有抖动那台落选，干净那台胜出且 clean=true", () => {
    const s = selectWinner(bc([rec({ totalGapSec: 120 }), rec({ totalGapSec: 0 })]), 30);
    expect(s.winner?.tenantId).toBe("n1");
    expect(s.clean).toBe(true);
  });
  it("都断 → 仍选最优但 clean=false", () => {
    const s = selectWinner(bc([rec({ totalGapSec: 120 }), rec({ totalGapSec: 200 })]), 30);
    expect(s.winner?.tenantId).toBe("n0"); // 缺口少者覆盖高
    expect(s.clean).toBe(false);
  });
  it("同 tenant 多会话(断流重连=新会话)→ 该 tenant 不完整;无完整 tenant → clean=false", () => {
    // 单一 tenant 'A' 在本场断流成 2 个会话(各自 gap=0),没有任何完整录全 → clean=false。
    const b: Broadcast = {
      streamKey: "k", roomSlug: "411", startMs: 0,
      members: [
        { tenantId: "A", rec: rec({ sessionBase: "s1", durationSec: 1800, totalGapSec: 0 }) },
        { tenantId: "A", rec: rec({ sessionBase: "s2", durationSec: 3000, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(false);             // A 有 2 会话 → 不完整 → 无完整 tenant
    expect(s.winner?.tenantId).toBe("A");    // 仍报最长会话供人工参考
  });
  it("一台完整 + 另一台断流多会话(总时长更长)→ 仍选完整那台,clean=true", () => {
    const b: Broadcast = {
      streamKey: "k", roomSlug: "411", startMs: 0,
      members: [
        { tenantId: "complete", rec: rec({ sessionBase: "c", durationSec: 3600, totalGapSec: 0 }) },
        { tenantId: "broken", rec: rec({ sessionBase: "b1", durationSec: 2000, totalGapSec: 0 }) },
        { tenantId: "broken", rec: rec({ sessionBase: "b2", durationSec: 2500, totalGapSec: 0 }) },
      ],
    };
    const s = selectWinner(b, 30);
    expect(s.clean).toBe(true);
    expect(s.winner?.tenantId).toBe("complete"); // 完整优先,即便 broken 两段合计更长
  });
});
