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

  it("VERSIONS 区块由 burnVersionsApply 决定是否渲染", () => {
    expect(src).toContain("{burnVersionsApply(facts) && (");
  });

  it("VERSIONS 区块不再无条件渲染", () => {
    // The label must not be reachable outside the guarded block.
    const label = src.indexOf('t("room.editor.versions")');
    const guard = src.indexOf("{burnVersionsApply(facts) && (");
    expect(label).toBeGreaterThan(guard);
    expect(label - guard).toBeLessThan(400);
  });
});
