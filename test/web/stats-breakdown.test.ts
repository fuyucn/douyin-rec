/**
 * Stats Breakdown 的形状:空 / 单类别 / 多类别。
 * 单类别不画 100% 满条(占比恒为 1,满条不携带信息,还会把卡片撑高)。
 */
import { describe, expect, it } from "vitest";
import { breakdownShape } from "../../packages/web/src/lib/stats-breakdown.js";

describe("breakdownShape", () => {
  it("no categories → empty", () => {
    expect(breakdownShape([])).toEqual({ kind: "empty" });
  });

  it("one category → single line, never a 100% bar", () => {
    const shape = breakdownShape([{ label: "original", count: 12 }]);
    expect(shape.kind).toBe("single");
    expect(shape.kind === "single" && shape.item).toEqual({ label: "original", count: 12 });
  });

  it("two or more categories → bars", () => {
    const items = [{ label: "a", count: 3 }, { label: "b", count: 1 }];
    const shape = breakdownShape(items);
    expect(shape.kind).toBe("bars");
    expect(shape.kind === "bars" && shape.items).toHaveLength(2);
  });
});
