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
});
