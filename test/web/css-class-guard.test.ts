/**
 * 死 CSS 守卫的自测:脚本自己必须先能被证明是"看得见"的。
 *
 * 上一版守卫有两个静默失效:只收顶层选择器(@media 里的死规则永远不报)、用子串匹配
 * (`rt` 因为 `rt-stages-toggle` 而活着)。这两种失效都表现为"绿",所以给守卫本身补用例。
 */
import { describe, expect, it } from "vitest";
import { declaredClasses, dynamicPrefixes, findDeadClasses, isReferenced } from "../../scripts/check-css-classes.mjs";

describe("css class guard", () => {
  it("collects classes declared inside @media, not just top-level rules", () => {
    const css = ".a { color: red; }\n@media (max-width: 640px) {\n  .b, .c:hover { color: blue; }\n}\n";
    expect([...declaredClasses(css)].sort()).toEqual(["a", "b", "c"]);
  });

  it("does not read declaration values as selectors", () => {
    const css = ".a { padding: 0.5rem; border-radius: .25rem; }\n";
    expect([...declaredClasses(css)].sort()).toEqual(["a"]);
  });

  it("ignores classes that only appear in comments", () => {
    const css = "/* old: .dead { } */\n.live { color: red; }\n";
    expect([...declaredClasses(css)].sort()).toEqual(["live"]);
  });

  it("requires a whole token: `rt` is not alive because `rt-stages-toggle` exists", () => {
    expect(isReferenced("rt", 'className="rt-stages-toggle"')).toBe(false);
    expect(isReferenced("rt", 'className="rt"')).toBe(true);
    expect(isReferenced("tr-part", 'className={`tr-part-${state}`}')).toBe(false);
  });

  it("keeps template-composed prefixes and third-party namespaces alive", () => {
    const dead = findDeadClasses(
      ".card {} .tr-part {} .react-flow__node {} .dead-one {}",
      ['<span className={`tr-part-${state}`} /> <span className="card" />'],
      [...dynamicPrefixes(['<span className={`tr-part-${state}`} />'])],
    );
    expect(dead).toEqual(["dead-one"]);
  });
});
