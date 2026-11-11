/**
 * upload-single-path.test.ts — 上传只有一个入口:`UploadTarget`(阶段 1b 收口守护)。
 *
 * 为什么要有这条:阶段 1b 把「建稿 / 追加分 P」收进 `@drec/bilibili-upload` 的 target 实现后,
 * 仍有两条生产路径自己调 `uploadPlain` / `appendGroup`(滚动上传、节点侧执行体)。接线那一步
 * 各自补了测试,但**没有任何断言阻止以后新代码绕回去**——而这种回退是静默的:调用点仍能跑通,
 * 只是绕过 target 的 proof / 幂等语义,在崩溃恢复时表现为重复建稿或重复分 P。
 *
 * 口径:
 * - `@drec/bilibili-upload` 是这套旧函数的**所有者**,允许出现;
 * - 其余包(含 `app`、`orchestrator`、`cli`)一律不许直接调用;
 * - 注释里提到名字不算违规(先剥注释再判),否则文档会天天撞红线。
 *
 * 已知盲区(刻意的取舍,不是漏洞):只拦「名字 + 调用括号」这一种写法。`const f = uploadPlain; f()`、
 * `uploadPlain?.(x)`、`Reflect.apply(uploadPlain, ...)` 都能绕过。拦裸名字会误伤 re-export 与文档,
 * 所以这里只做绊线、配合下面的金丝雀断言防止规则被改弱后静默失效。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const PKGS = join(ROOT, "packages");

/** 旧函数的合法所有者。 */
const OWNER = "bilibili-upload";
/** 测试专用装配壳(把旧 mock 包成 target),不是生产代码。 */
const TEST_SHELL = "test-target.ts";

function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === "dist") continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!name.endsWith(".ts")) continue;
      if (name.includes(".test.")) continue;
      if (name === TEST_SHELL) continue;
      out.push(p);
    }
  };
  for (const pkg of readdirSync(PKGS)) {
    if (pkg === OWNER) continue;
    const src = join(PKGS, pkg, "src");
    try { if (statSync(src).isDirectory()) walk(src); } catch { /* 没有 src 的包跳过 */ }
  }
  return out;
}

/** 去掉 `//` 与 `/* *\/` 注释,只留代码——注释里写函数名是正常的文档。 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    // 字符串/模板串也要去掉:日志文案里提到函数名(`跳过 ... uploadPlain`)是正常的。
    .replace(/`[^`]*`/g, "``")
    .replace(/"[^"\n]*"/g, '""')
    .replace(/'[^'\n]*'/g, "''")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

// 只拦**调用**:re-export(`export { uploadPlain } from ...`)与文档说明是合法转发,不算绕道。
const BANNED = /\b(uploadPlain|appendGroup)\s*\(/;

describe("上传只有一个入口", () => {
  it("金丝雀:探测器本身仍能命中(防止规则被改弱后静默失效)", () => {
    expect(BANNED.test("uploadPlain(")).toBe(true);
    expect(BANNED.test("appendGroup(")).toBe(true);
    expect(BANNED.test("export { uploadPlain } from \"x\";")).toBe(false);
  });

  it("除所有者包外,生产代码不直接调用旧上传函数", () => {
    const offenders = sources()
      .filter((f) => BANNED.test(stripComments(readFileSync(f, "utf-8"))))
      .map((f) => relative(ROOT, f));
    expect(offenders, "这些文件绕开了 UploadTarget,直接调旧函数").toEqual([]);
  });

  it("扫描面确实覆盖到了那几个包(防止规则静默失效)", () => {
    const scanned = sources().map((f) => relative(ROOT, f));
    for (const pkg of ["app", "orchestrator", "cli", "core"]) {
      expect(scanned.some((f) => f.startsWith(join("packages", pkg, "src"))), `漏扫 ${pkg}`).toBe(true);
    }
  });
});
