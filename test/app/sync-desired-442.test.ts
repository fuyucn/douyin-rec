/**
 * #442 wiring guard: the master's desiredFor lives in the platform-vendor-dependent CLI entry
 * (vitest cannot import it), so the sync-semantics split is pinned at the source level:
 *   未勾选(unassigned)= deleted:true —— **与规则是否停用无关**(房间没派给本节点,节点就不该留着它);
 *   规则停用但仍勾选 / 能力不满足 = enabled:false 停用保留(可逆,恢复时原地复活)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
// Issue #481: the desired-set builder moved from the CLI entry into @drec/app (testable, no vendor imports).
const cli = readFileSync(join(root, "packages/app/src/hub-desired.ts"), "utf-8");
const sync = readFileSync(join(root, "packages/app/src/task-sync.ts"), "utf-8");

describe("#442 只下发启用且分配的房间(下发侧语义钉死)", () => {
  it("未勾选 = 点名 deleted:true,且不再受 ruleDisabled 影响(规则停用+未勾选同样要清)", () => {
    expect(cli).toMatch(/if \(!targeted\) \{/);
    expect(cli).toMatch(/deleted:\s*true/);
    // 旧口径:规则停用会被当成「停用保留」,未勾选的房间永远留在节点上(2026-11-08 修)。
    expect(cli).not.toMatch(/!ruleDisabled && !targeted/);
  });

  it("规则停用但仍勾选 → 走停用保留(enabled:false 条目仍在,本机停用靠它写回源任务)", () => {
    expect(cli).toMatch(/const targeted = isWorkerTargeted\(rule, workerId\);/);
    expect(cli).toContain("resolveSpecAssignment");
  });

  it("节点侧:点名删除的缩容守卫放行(shrinkIsExplicit),缺席无点名仍被守卫拦", () => {
    expect(sync).toMatch(/shrinkIsExplicit/);
    expect(sync).toMatch(/retainedKeys\.size === 0 && !explicitDelete/);
  });
});
