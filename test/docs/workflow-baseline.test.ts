/**
 * 守护:门禁的 diff 基线必须跟着 PR 的 base 走,不能写死某条开发分支。
 *
 * 为什么需要:base 早已是 `main`,但 CI 与脚本还指着 `feat/hub-optimization`,那条分支分叉一百多个
 * 提交后,闸门会把历史内容当成 PR 新增行重扫,正常写作会被拦(#585)。这类漂移靠人眼 grep 不住,
 * 所以用断言钉死——改回去就红。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const read = (p: string) => readFileSync(ROOT + p, "utf-8");
/** 旧开发分支:只能作为「已废弃」的说明出现,不能作为基线出现。 */
const STALE = "feat/hub-optimization";

describe("门禁基线口径(#585)", () => {
  it("CI 的隐私闸门用 PR 的 base 分支,不写死分支名", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).not.toContain(`--diff origin/${STALE}`);
    expect(ci).toContain("${GITHUB_BASE_REF:-main}");
  });

  it("pr-risk-scan 的默认基线是 origin/main", () => {
    const sh = read("scripts/pr-risk-scan.sh");
    expect(sh).toMatch(/DEFAULT_BASE="origin\/main"/);
    expect(sh).not.toMatch(/DEFAULT_BASE="origin\/[^"]*feat/);
  });

  it("文档不再叫人以旧开发分支为 base", () => {
    const doc = read("docs/agent-workflow.md");
    // 精确的「指令」形式:一旦有人把这句写回去,后面的人就会照着开 PR。
    expect(doc).not.toMatch(/base = `feat\//);
    expect(doc).not.toContain("一律以\n  `feat/hub-optimization` 为 base");
    expect(doc).toContain("base = `main`");
  });

  it("文档要求待验证的票用 Part of #N(因为 base=main 时 Fixes 会自动关票)", () => {
    const doc = read("docs/agent-workflow.md");
    expect(doc).toContain("`Fixes #N` 现在会自动关票");
    // 锁定到规则句,而不是「文档任意位置出现过这个词」:分步票的最后一步也必须按同一判断。
    expect(doc).toMatch(/有部署验证项的票写 `Part of #N`，合并即完成的写 `Fixes #N`/);
    expect(doc).toMatch(/最后一步也要看有没有部署验证项/);
    // 最后一步的两条分支必须各自成句,不能靠三个词散落在同一窗口里凑齐。
    const sentences = doc.split(/[。；\n]/).filter((x) => x.includes("最后一步"));
    expect(sentences.some((x) => x.includes("`Part of #N`") && x.includes("`待验证`"))).toBe(true);
    // 无实跑项的分支不能只出现一个孤零零的 `Fixes #N`:同一句里要写明它不是「有实跑项」那条路。
    expect(sentences.some((x) => x.includes("`Fixes #N`") && /没有实跑项|无实跑项|合并即完成|自动关闭/.test(x))).toBe(true);
    // 旧规则不得以任何写法回归(加粗/不加粗都拦):最后一步一律写 Fixes 会让票被自动关掉。
    // 任何「最后一步 + 一律/都/必须 + Fixes」的组合都拦(格式、标点、加粗变体都算)。
    expect(doc).not.toMatch(/最后一步[^。；\n]{0,40}(一律|都|必须|均应)[^。；\n]{0,20}Fixes #N/);
    // 并且「最后一步」句里不能出现「直接 close」——close 只由收口步骤做。
    expect(sentences.every((x) => !x.includes("直接 close"))).toBe(true);
    // 分步票段落也要写清「除最后一步之外都写 Part of #N」,不能退回「每步都写」的旧说法。
    expect(doc).toContain("除最后一步之外的每一步都写 `Part of #N`");
    // 第 8 条必须区分「还有后续步骤」与「最后一步」,否则最后一步会被转回 in-progress。
    expect(doc).toMatch(/这是最后一步.*有实跑项就转 `待验证`/);
  });
});
