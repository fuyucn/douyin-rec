/**
 * architecture-docs.test.ts — 架构文档漂移守护。
 *
 * docs/architecture.html 与 docs/architecture.md 的依赖图都是 **生成物**
 * (scripts/gen-architecture.mjs)。本测试跑生成器的 --check 模式,断言两者与仓库现状一致。
 *
 * 为什么需要:手维护的架构文档已实测漂移过两次(两份都漏 kuaishou-live;
 * architecture.md 曾画出不存在的 `orch --> app` 边)。把它们纳入测试 → 漂移直接变红灯,
 * 而不是等某天有人读文档时才发现。
 *
 * 修复方式:跑 `pnpm arch:gen` 重新生成,提交产物。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");

describe("架构文档与仓库一致(生成物漂移守护)", () => {
  it("architecture.html + architecture.md 的依赖图与 packages/*/package.json 一致", () => {
    // --check 在不一致时 exit 1;一致时打印 ✓。
    const out = execFileSync("node", [join(ROOT, "scripts", "gen-architecture.mjs"), "--check"], {
      cwd: ROOT,
      encoding: "utf-8",
    });
    expect(out).toContain("与仓库一致");
  });
});
