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
  let matched = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    let idx = 0;
    for (;;) {
      const hit = src.indexOf('"needs_manual"', idx);
      if (hit === -1) break;
      idx = hit + 1;
      // 该实参必须处在 setState(...) 的**前几个参数**里(第一个实参是 streamKey,状态是第二个)。
      const before = src.slice(Math.max(0, hit - 300), hit);
      const callStart = before.lastIndexOf("setState(");
      if (callStart === -1) continue;
      const argGap = before.slice(callStart + "setState(".length);
      // 状态是**第二个**实参(第一个是 streamKey):argGap 里必须只有一层逗号。
      // 多一层说明这处 "needs_manual" 是更深层嵌套里的字面量,不是本次要找的状态实参。
      let depth = 0;
      let commas = 0;
      for (const ch of argGap) {
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") { if (depth === 0) break; depth--; }
        else if (ch === "," && depth === 0) commas++;
      }
      if (commas !== 1) continue;
      matched++;
      const line = src.slice(0, hit).split("\n").length;
      const call = callAt(src, src.lastIndexOf("setState", hit - argGap.length));
      // error 的值不能是空串字面量(会绕过「必须带原因」的意图)。
      if (!/\berror\s*:/.test(call) || /\berror\s*:\s*(""|''|`\s*`)/.test(call)) {
        violations.push(`${relative(ROOT, file)}:${line}  ${call.replace(/\s+/g, " ").slice(0, 120)}`);
      }
    }
  }

  it("守护本身不是空转:确实扫到了所有 needs_manual 写入点", () => {
    // 下限只用来抓「匹配逻辑坏了」(历史上坏过一次:正则要求状态紧跟 setState(,一条都扫不到)。
    // 真实写入点约 29 处(另有 1 处是接口类型声明被一并匹配到)。门槛留足余量,
    // **不要贴着实测值设** —— 正常合并/删除写入点时不该误报「守护空转」。
    expect(matched).toBeGreaterThanOrEqual(20);
  });

  it("没有裸调用(改用 closeStageReady 或带非空 error)", () => {
    expect(violations).toEqual([]);
  });

  it("空 error 字面量({ error: \"\" })也算违规", () => {
    // 单独验证判定逻辑本身对空串的处理(真实代码里不应出现,写了就是 bug)。
    expect(/\berror\s*:/.test('setState(k, "needs_manual", { error: "" })')).toBe(true);
    expect(/\berror\s*:\s*(""|''|`\\s*`)/.test('setState(k, "needs_manual", { error: "" })')).toBe(true);
  });

  it("closeStageReady 是唯一允许的无 error 收口入口,且被三处调用", () => {
    const users = files.filter((f) => readFileSync(f, "utf-8").includes("closeStageReady("))
      // core 里是定义 + 类型声明,不是调用方。
      .filter((f) => !f.includes(join("packages", "core")));
    expect(users.map((f) => relative(ROOT, f)).sort()).toEqual([
      "packages/cli/src/cli.ts",
      "packages/orchestrator/src/pipeline.ts",
      "packages/orchestrator/src/segment-pipeline.ts",
    ]);
  });
});
