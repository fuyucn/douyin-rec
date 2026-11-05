/**
 * #442 wiring guard: the master's desiredFor lives in the platform-vendor-dependent CLI entry
 * (vitest cannot import it), so the sync-semantics split is pinned at the source level:
 * deletion intent comes ONLY from "rule enabled but node unselected" (a deleted:true marker);
 * a disabled rule / unmet capabilities must still ship enabled:false (stop-and-keep), because
 * the local source task's stop depends on that entry and reversible states must not delete.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
// Issue #481: the desired-set builder moved from the CLI entry into @drec/app (testable, no vendor imports).
const cli = readFileSync(join(root, "packages/app/src/hub-desired.ts"), "utf-8");
const sync = readFileSync(join(root, "packages/app/src/task-sync.ts"), "utf-8");

describe("#442 只下发启用且分配的房间(下发侧语义钉死)", () => {
  it("未勾选 = 点名 deleted:true,而不是静默缺席(缺席会让节点守卫拦成只停不删)", () => {
    expect(cli).toMatch(/!ruleDisabled && !targeted/);
    expect(cli).toMatch(/deleted:\s*true/);
  });

  it("规则停用不进删除意图:enabled:false 条目仍在(本机停用靠它写回源任务)", () => {
    // ruleDisabled 维度的条目必须继续走停用保留路径,而不是被跳过。
    expect(cli).toMatch(/const ruleDisabled = rule\.enabled === false;/);
    expect(cli).toMatch(/const targeted = isWorkerTargeted\(rule, workerId\);/);
  });

  it("节点侧:点名删除的缩容守卫放行(shrinkIsExplicit),缺席无点名仍被守卫拦", () => {
    expect(sync).toMatch(/shrinkIsExplicit/);
    expect(sync).toMatch(/retainedKeys\.size === 0 && !explicitDelete/);
  });
});
