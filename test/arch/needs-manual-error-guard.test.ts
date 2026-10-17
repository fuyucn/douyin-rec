/**
 * needs_manual 必须带原因 —— 源码守护(issue #188)。
 *
 * 为什么用 grep 守护而不是逐个调用点写用例:`setState(key, "needs_manual")` 这种**裸调用**
 * 历史上出现过三次(orchestrator 主流程的「所有节点断流」、分段零产物、CLI 单节点重跑),
 * 每次都要等审查才发现,且很容易「改回裸调用后测试仍然全绿」。这里直接把规则固化成测试:
 * 全仓任何把 job 打成 needs_manual 却没带 error 的调用点都失败。
 *
 * 允许的两种写法:
 *   - closeStageReady(ledger, key, uploadMode)         —— stage 正常收口的唯一入口
 *   - setState(key, "needs_manual", { ..., error: <非空> })
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const PKG_DIR = join(ROOT, "packages");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts") && !p.includes(".test.")) out.push(p);
  }
  return out;
}

/** 取 `setState(` 起的整个调用(括号配平),处理跨行与模板串里的括号。 */
function callAt(src: string, at: number): string {
  let i = src.indexOf("(", at);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === "(") depth++;
    else if (src[j] === ")") { depth--; if (depth === 0) return src.slice(at, j + 1); }
  }
  return src.slice(at, at + 200);
}

describe("needs_manual 必须带 error(issue #188 源码守护)", () => {
  const files = walk(PKG_DIR);
  const violations: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    let idx = 0;
    for (;;) {
      const hit = src.indexOf('"needs_manual"', idx);
      if (hit === -1) break;
      idx = hit + 1;
      const line = src.slice(0, hit).split("\n").length;
      // 只看它是 setState(...) 的第二个实参
      const before = src.slice(Math.max(0, hit - 200), hit);
      if (!/setState\(\s*$/.test(before)) continue;
      const call = callAt(src, src.lastIndexOf("setState", hit));
      if (!/\berror\s*:/.test(call)) {
        violations.push(`${relative(ROOT, file)}:${line}  ${call.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
  }

  it("没有裸调用(改用 closeStageReady 或带 error)", () => {
    expect(violations).toEqual([]);
  });

  it("closeStageReady 是唯一允许的无 error 收口入口,且被三处调用", () => {
    const users = files.filter((f) => readFileSync(f, "utf-8").includes("closeStageReady("))
      // core 里是定义 + 类型声明,不是调用方。
      .filter((f) => !f.includes(`${join("packages", "core")}`));
    // core 定义处不算调用方:cli 一处、orchestrator 两条管线。
    expect(users.map((f) => relative(ROOT, f)).sort()).toEqual([
      "packages/cli/src/cli.ts",
      "packages/orchestrator/src/pipeline.ts",
      "packages/orchestrator/src/segment-pipeline.ts",
    ]);
  });
});
