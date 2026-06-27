import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readGaps, totalGapSecOf } from "./gaps.js";

describe("gaps sidecar", () => {
  it("totalGapSecOf 累加区间秒数", () => {
    expect(totalGapSecOf([{ startMs: 0, endMs: 10_000 }, { startMs: 20_000, endMs: 25_000 }])).toBe(15);
  });
  it("readGaps 解析合法文件", () => {
    const dir = mkdtempSync(join(tmpdir(), "gaps-"));
    const p = join(dir, "s.gaps.json");
    writeFileSync(p, JSON.stringify({ sessionBase: "s", gaps: [{ startMs: 0, endMs: 5000 }], totalGapSec: 5 }));
    expect(readGaps(p)?.totalGapSec).toBe(5);
  });
  it("缺失/损坏 → null", () => {
    expect(readGaps("/no/such.json")).toBeNull();
  });
});
