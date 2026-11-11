// 阶段 1b:编排层只认 `UploadTarget`(`deps.upload`)。旧字段 `uploadPlain` / `appendGroup` 一旦
// 在生产代码里复活,就等于绕过 target 的 proof 判定与幂等语义——而测试壳(test-target)会把它们
// 重新挂回 target 上,让这类回归「测试全绿」。所以在这里直接扫生产源码。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const DIRS = [join(ROOT, "packages", "orchestrator", "src"), join(ROOT, "packages", "cli", "src"), join(ROOT, "packages", "app", "src")];
// 编排层是 `deps.*`;录制端是 `this.o.*Raw` —— 两种旧字段都拦,
// 否则「绕着 target 调旧函数」的回归只会在其中一处被发现。
const BANNED = /\b(deps\.(uploadPlain|appendGroup)|this\.o\.(uploadPlainRaw|appendGroupRaw))\b/;

describe("编排层不得直接调用旧上传字段(#631)", () => {
  it("packages/orchestrator/src 与 packages/cli/src 里没有 deps.uploadPlain / deps.appendGroup", () => {
    const hits: string[] = [];
    for (const dir of DIRS) {
      for (const name of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
        // 测试文件与被测壳自身豁免:它们的工作就是模拟旧形状。
        if (/\.test\.ts$/.test(name) || name === "test-target.ts") continue;
        for (const [i, line] of readFileSync(join(dir, name), "utf8").split("\n").entries()) {
          if (BANNED.test(line)) hits.push(`${name}:${i + 1}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });
});
