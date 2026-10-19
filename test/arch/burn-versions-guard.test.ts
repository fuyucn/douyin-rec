/**
 * VERSIONS chips must stay behind their predicate (issue #284).
 *
 * The editor previously rendered the burn-version chips unconditionally, so a room with no rule
 * (or a paused rule) offered pickers that could never take effect. Behaviour tests cover the
 * predicate, but they cannot see whether the component actually calls it: reverting the render
 * condition to `true` leaves every test green. This source guard closes that gap.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const EDITOR = "packages/web/src/modals/RoomEditor.tsx";

describe("RoomEditor VERSIONS 渲染条件(#284 源码守护)", () => {
  const src = readFileSync(join(ROOT, EDITOR), "utf-8");

  /**
   * Return the JSX region guarded by `burnVersionsApply(...) && (`, balanced on parentheses so a
   * reformat or an extra wrapper does not silently defeat the check.
   */
  function guardedRegion(source: string): string | null {
    const call = source.indexOf("burnVersionsApply(");
    if (call < 0) return null;
    const and = source.indexOf("&&", call);
    if (and < 0) return null;
    const open = source.indexOf("(", and);
    if (open < 0) return null;
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") {
        depth--;
        if (depth === 0) return source.slice(open, i + 1);
      }
    }
    return null;
  }

  it("VERSIONS 标签落在 burnVersionsApply 守卫的 JSX 区块内", () => {
    const region = guardedRegion(src);
    expect(region, "找不到 burnVersionsApply(...) && ( 守卫").not.toBeNull();
    expect(region!).toContain('t("room.editor.versions")');
    // The chips must be inside too, or the label alone would be hidden while the controls remain.
    expect(region!).toContain("room.editor.danmuVer");
    expect(region!).toContain("room.editor.livechatVer");
  });

  it("VERSIONS 标签只出现在守卫区块内一次", () => {
    const label = 't("room.editor.versions")';
    expect(src.split(label).length - 1).toBe(1);
  });

  it("constraints / settled method / flow use ruleFactsOf, so display agrees with save", () => {
    expect(src).toContain("settledMethod(ruleFactsOf(");
    expect(src).toContain("const facts = ruleFactsOf(");
    expect(src).not.toMatch(/(settledMethod|deriveConstraints|flowSummary)\(factsOf\(/);
  });
});
