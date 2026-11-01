/**
 * review-gates.test.ts — issue #29 门禁脚本的行为钉子:
 *   - scripts/pr-risk-scan.sh:docs-only → PASS;触及上传/删除/ledger → RISK
 *   - scripts/issue-guard.py --diff:只扫新增行,历史内容不红
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const RISK = join(ROOT, "scripts", "pr-risk-scan.sh");
const GUARD = join(ROOT, "scripts", "issue-guard.py");

function diffOf(path: string, added: string): string {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1,0 +1,1 @@\n+${added}\n`;
}
function risk(diff: string) {
  const r = spawnSync("bash", [RISK, "--diff-file", "-"], { input: diff, encoding: "utf-8" });
  return { status: r.status, out: r.stdout };
}

describe("pr-risk-scan.sh", () => {
  it("仅改文档(即使正文提到 upload / rm -rf)→ PASS", () => {
    const r = risk(diffOf("docs/agent-workflow.md", "上传 biliup 后 rm -rf stage"));
    expect(r.out.split("\n")[0]).toBe("PASS");
    expect(r.status).toBe(0);
  });
  it("路径含 biliup → RISK", () => {
    const r = risk(diffOf("packages/app/src/upload/biliup.ts", "export const a = 1;"));
    expect(r.out.split("\n")[0]).toBe("RISK");
    expect(r.status).toBe(1);
  });
  it("生产代码内容含 unlink → RISK", () => {
    expect(risk(diffOf("packages/app/src/x.ts", "fs.unlinkSync(p);")).status).toBe(1);
  });
  it("ledger 状态转换(setState)→ RISK", () => {
    expect(risk(diffOf("packages/orchestrator/src/reconciler.ts", "ledger.setState(k, 'done');")).status).toBe(1);
  });
  it("测试文件内容提到 unlink 不按内容判 RISK", () => {
    expect(risk(diffOf("packages/app/src/x.test.ts", "expect(unlink).toBeCalled();")).status).toBe(0);
  });
  it("敏感文件清单:收口/保留规则文件任何改动 → RISK", () => {
    const r = risk(diffOf("packages/core/src/survivors.ts", "const a = 1;"));
    expect(r.status).toBe(1);
    expect(r.out).toContain("敏感文件: packages/core/src/survivors.ts");
  });
  it("敏感文件清单扩充(#432):remux 校验 / proc-queue store / finalize-format 任何改动 → RISK", () => {
    for (const f of ["packages/processors/src/remux.ts", "packages/proc-queue/src/store.ts", "packages/orchestrator/src/finalize-format.ts"]) {
      const r = risk(diffOf(f, "const a = 1;"));
      expect(r.status).toBe(1);
      expect(r.out).toContain(`敏感文件: ${f}`);
    }
  });
  it("纯改名(只有 rename 头)按新旧路径判定", () => {
    const d = "diff --git a/packages/app/src/a.ts b/packages/app/src/cleanup-x.ts\nsimilarity index 100%\nrename from packages/app/src/a.ts\nrename to packages/app/src/cleanup-x.ts\n";
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("路径: packages/app/src/cleanup-x.ts");
    const clean = "diff --git a/packages/app/src/a.ts b/packages/app/src/b.ts\nsimilarity index 100%\nrename from packages/app/src/a.ts\nrename to packages/app/src/b.ts\n";
    expect(risk(clean).status).toBe(0);
  });
  it("单行翻转:改动行无关键词,但所在函数上下文涉及清理 → RISK", () => {
    const d = "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,4 +1,4 @@\n function decide() {\n-  const keep = true;\n+  const keep = false;\n   if (!keep) rmSync(p);\n";
    expect(risk(d).status).toBe(1);
    const noCtx = "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,3 +1,3 @@\n function f() {\n-  const n = 1;\n+  const n = 2;\n";
    expect(risk(noCtx).status).toBe(0);
  });
  it("上下文行只在 hunk 有改动时才算(纯上下文 hunk 不触发)", () => {
    const d = "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,2 +1,3 @@\n rmSync(p);\n@@ -9,1 +10,2 @@\n+const z = 1;\n";
    expect(risk(d).status).toBe(0);
  });
  it("在别处调用 ledger 方法 → RISK", () => {
    expect(risk(diffOf("packages/app/src/x.ts", "await ledger.recordStep(k, s);")).status).toBe(1);
    expect(risk(diffOf("packages/app/src/x.ts", "this.ledger?.finish(id);")).status).toBe(1);
  });
  it("翻转保留规则字段 → RISK", () => {
    expect(risk(diffOf("packages/web/src/lib/x.ts", "stageAfterDone: false,")).status).toBe(1);
  });
  it("超大 hunk(>64KB)里靠前的命中不丢(管道提前关闭不能吞掉 RISK)", () => {
    const filler = Array.from({ length: 5000 }, (_, i) => `+const v${i} = ${i}; // padding padding padding`).join("\n");
    const d = `diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -0,0 +1,5001 @@\n+rmSync(p);\n${filler}\n`;
    expect(d.length).toBeGreaterThan(64 * 1024);
    expect(risk(d).status).toBe(1);
  });
  it("上下文只取改动前后 20 行;hunk 开头(函数签名)与头部函数名参与匹配", () => {
    const ctx = (n: number) => Array.from({ length: n }, (_, i) => ` const c${i} = ${i};`);
    // A hunk with correct line counts: 3 neutral head lines, rmSync, `gap` context lines, then a change.
    const mk = (gap: number, hdr = "", head = [" function f() {", " const a = 1;", " const b = 2;"]) => {
      const body = [...head, " rmSync(p);", ...ctx(gap), "-const n = 1;", "+const n = 2;"];
      const n = body.length - 1;
      return `diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,${n} +1,${n} @@${hdr}\n${body.join("\n")}\n`;
    };
    expect(risk(mk(5)).status).toBe(1);   // within the window
    expect(risk(mk(30)).status).toBe(0);  // beyond the window
    expect(risk(mk(30, " function cleanupStage() {")).status).toBe(1); // header function name
    expect(risk(mk(30, "", [" function cleanupStage() {", " const a = 1;", " const b = 2;"])).status).toBe(1); // signature
  });
  it("git 模式:改动远离签名时,所在函数签名仍参与匹配", () => {
    const d = mkdtempSync(join(tmpdir(), "risk-"));
    const g = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf-8" });
    g("init", "-q", "-b", "base");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    mkdirSync(join(d, "packages", "app", "src"), { recursive: true });
    const lines = (v: number) => [
      "export function a() {", "  return 1;", "}", "",
      "export function cleanupStage(p: string) {",
      ...Array.from({ length: 48 }, (_, i) => `  const c${i} = ${i === 40 ? v : i};`),
      "}", "",
    ].join("\n");
    const f = join(d, "packages", "app", "src", "x.ts");
    writeFileSync(f, lines(40));
    g("add", ".");
    g("commit", "-qm", "base");
    g("checkout", "-q", "-b", "feature");
    writeFileSync(f, lines(99));
    g("commit", "-qam", "c");
    const r = spawnSync("bash", [RISK, "base"], { cwd: d, encoding: "utf-8" });
    expect(r.stdout.split("\n")[0]).toBe("RISK");
  });
  /** Temp git repo with one file committed on `base`, then rewritten on `feature`; returns the scan stdout. */
  function gitScan(before: string, after: string): string {
    const d = mkdtempSync(join(tmpdir(), "risk-"));
    const g = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf-8" });
    g("init", "-q", "-b", "base");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    mkdirSync(join(d, "packages", "app", "src"), { recursive: true });
    const f = join(d, "packages", "app", "src", "x.ts");
    writeFileSync(f, before);
    g("add", ".");
    g("commit", "-qm", "base");
    g("checkout", "-q", "-b", "feature");
    writeFileSync(f, after);
    g("commit", "-qam", "c");
    return spawnSync("bash", [RISK, "base"], { cwd: d, encoding: "utf-8" }).stdout;
  }
  const body = (n: number, changeAt: number, v: number) =>
    Array.from({ length: n }, (_, i) => `  const c${i} = ${i === changeAt ? v : i};`);
  it("git 模式:函数上方多行文档注释不把签名挤出匹配范围", () => {
    const src = (v: number) => ["export function a() {", "  return 1;", "}", "",
      "/**", " * Doc line one.", " * Doc line two.", " * Doc line three.", " */",
      "export function cleanupStage(dir: string) {", ...body(60, 45, v), "}", ""].join("\n");
    expect(gitScan(src(45), src(99)).split("\n")[0]).toBe("RISK");
  });
  it("git 模式:两个函数合进一个 hunk 时,第二个函数签名也参与匹配", () => {
    const src = (v1: number, v2: number) => ["function alpha() {", ...body(40, 1, v1), "}",
      "function cleanupStage() {", ...body(60, 50, v2), "}", ""].join("\n");
    expect(gitScan(src(1, 50), src(7, 99)).split("\n")[0]).toBe("RISK");
  });
  it("多行参数签名(行尾只有一个 `(`)也参与匹配,即使改动离签名很远", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `  const c${i} = ${i};`);
    const d = [
      "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts",
      "--- a/packages/app/src/x.ts",
      "+++ b/packages/app/src/x.ts",
      "@@ -1,40 +1,40 @@",
      " import x from 'y';",
      " const z = 1;",
      " export const w = 2;",
      "   cleanupStage(",
      "     dir,",
      "   ) {",
      ...filler,
      "-    const n = 1;",
      "+    const n = 2;",
      "",
    ].join("\n");
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("内容[清理/删除]: packages/app/src/x.ts");
  });
  it("对象/类的属性箭头函数(改动离签名很远)也参与匹配", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `    const c${i} = ${i};`);
    const d = [
      "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts",
      "--- a/packages/app/src/x.ts",
      "+++ b/packages/app/src/x.ts",
      "@@ -1,40 +1,40 @@",
      " import x from 'y';",
      " const z = 1;",
      " export const w = 2;",
      "   cleanupStage: async (p) => {",
      ...filler,
      "-    const n = 1;",
      "+    const n = 2;",
      "",
    ].join("\n");
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("内容[清理/删除]: packages/app/src/x.ts");
  });
  it("属性箭头函数里无关的改动不误判(没有清理语义)", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `    const c${i} = ${i};`);
    const d = [
      "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts",
      "--- a/packages/app/src/x.ts",
      "+++ b/packages/app/src/x.ts",
      "@@ -1,40 +1,40 @@",
      " import x from 'y';",
      " const z = 1;",
      " export const w = 2;",
      "   describe: async (p) => {",
      ...filler,
      "-    const n = 1;",
      "+    const n = 2;",
      "",
    ].join("\n");
    expect(risk(d).status).toBe(0);
  });
  it("多行调用(`rmSync(` ... `);`)不当作签名:改动在别的函数里 → PASS", () => {
    const d = [
      "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts",
      "--- a/packages/app/src/x.ts",
      "+++ b/packages/app/src/x.ts",
      "@@ -1,40 +1,40 @@",
      "function a() {",
      "  const n = 1;",
      "-  const m = 1;",
      "+  const m = 2;",
      ...Array.from({ length: 30 }, (_, i) => `    const c${i} = ${i};`),
      "  rmSync(",
      "    p,",
      "  );",
      "}",
      "",
    ].join("\n");
    expect(risk(d).status).toBe(0);
  });
  it("改动前后各有几百个方法时,所在函数签名不被挤掉", () => {
    const methods = Array.from({ length: 250 }, (_, i) => [`  m${i}() {`, "  }"]).flat();
    const filler = Array.from({ length: 30 }, (_, i) => `    const c${i} = ${i};`);
    const after = Array.from({ length: 250 }, (_, i) => [`  z${i}() {`, "  }"]).flat();
    // Signatures AFTER the change must not push the enclosing one out either.
    const lines = [" export class Big {", " const a = 1;", " const b = 2;", ...methods, "  cleanupStage() {", ...filler, "-    const n = 1;", "+    const n = 2;", ...after];
    const n = lines.length - 1;
    const d = `diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,${n} +1,${n} @@\n${lines.join("\n")}\n`;
    expect(risk(d).status).toBe(1);
  });
  it("多行头遇到分号即作废:后面的 `) {` 不再把它提升为签名", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `    const c${i} = ${i};`);
    const d = [
      "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts",
      "--- a/packages/app/src/x.ts",
      "+++ b/packages/app/src/x.ts",
      "@@ -1,40 +1,40 @@",
      " import x from 'y';",
      " const z = 1;",
      " export const w = 2;",
      "   cleanupStage(",
      "   done;",
      "   ) {",
      ...filler,
      "-    const n = 1;",
      "+    const n = 2;",
      "",
    ].join("\n");
    expect(risk(d).status).toBe(0);
  });
  it("多行签名参数里有内联类型的分号(`opts: { a: T; b: U }`)仍识别为签名", () => {
    const filler = Array.from({ length: 30 }, (_, i) => `    const c${i} = ${i};`);
    const d = [
      "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts",
      "--- a/packages/app/src/x.ts",
      "+++ b/packages/app/src/x.ts",
      "@@ -1,40 +1,40 @@",
      " import x from 'y';",
      " const z = 1;",
      " export const w = 2;",
      "   async cleanupStage(",
      "     dir: string,",
      "     opts: { keep: boolean; force: boolean },",
      "   ): Promise<void> {",
      ...filler,
      "-    const n = 1;",
      "+    const n = 2;",
      "",
    ].join("\n");
    expect(risk(d).status).toBe(1);
  });
  it("纯展示模块(i18n / 提示文案)里的 upload 字样只列为提示,不判 RISK", () => {
    const r = risk(diffOf("packages/web/src/lib/i18n.tsx", '  "queue.uploading": "上传中",'));
    expect(r.status).toBe(0);
    expect(r.out.split("\n")[0]).toBe("PASS");
    expect(r.out).toContain("提示[上传](仅展示,不计 RISK): packages/web/src/lib/i18n.tsx");
  });
  it("不在展示清单里的 web 文件照旧按内容判 RISK", () => {
    expect(risk(diffOf("packages/web/src/pages/HubRuleDialog.tsx", "const uploadMode = 'upload';")).status).toBe(1);
  });
  it("导入行里换模块路径、换别名、副作用导入、require 仍判 RISK", () => {
    expect(risk(diffOf("packages/app/src/x.ts", 'import { run } from "./upload.js";')).status).toBe(1);
    expect(risk(diffOf("packages/app/src/x.ts", 'import { uploadAll as finalize } from "./stage.js";')).status).toBe(1);
    expect(risk(diffOf("packages/app/src/x.ts", 'import "./cleanup-scheduler.js";')).status).toBe(1);
    expect(risk(diffOf("packages/app/src/x.ts", 'import x = require("./upload.js");')).status).toBe(1);
    expect(risk(diffOf("packages/app/src/x.ts", 'import {x} from "./y.js"; await uploadPlain(job);')).status).toBe(1);
    // Module swap where the keyword is only in the imported name: must stay RISK.
    expect(risk(diffOf("packages/app/src/x.ts", 'import { cleanupAll } from "./b.js";')).status).toBe(1);
  });
  it("展示清单里的文件新增网络调用仍判 RISK", () => {
    expect(risk(diffOf("packages/web/src/lib/i18n.tsx", 'await fetch("/api/hub/upload", { method: "POST" });')).status).toBe(1);
    expect(risk(diffOf("packages/web/src/lib/notification-text.ts", "void api.uploadNow(k);")).status).toBe(1);
    // Keyword on a wrapped argument line, not the call line.
    const wrapped = "diff --git a/packages/web/src/lib/i18n.tsx b/packages/web/src/lib/i18n.tsx\n--- a/packages/web/src/lib/i18n.tsx\n+++ b/packages/web/src/lib/i18n.tsx\n@@ -1,0 +1,2 @@\n+await api.retryJob(\n+  id, \"upload\");\n";
    expect(risk(wrapped).status).toBe(1);
    expect(risk(diffOf("packages/web/src/lib/i18n.tsx", 'import { uploadNow } from "../api/upload";')).status).toBe(1);
  });
  it("签名启发式不把 if/for 当函数", () => {
    const filler = Array.from({ length: 30 }, (_, i) => ` const c${i} = ${i};`);
    const lines = [" function f() {", " const a = 1;", " const b = 2;", "   if (cleanupDone) {", ...filler, "-const n = 1;", "+const n = 2;"];
    const n = lines.length - 1;
    const d = `diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,${n} +1,${n} @@\n${lines.join("\n")}\n`;
    expect(risk(d).status).toBe(0);
  });
  it("diff -ruN 风格(无 a/ b/ 前缀,带时间戳)也按内容与路径判", () => {
    const d = "diff -ruN old/x.ts new/x.ts\n--- packages/app/src/x.ts\t2026-10-01 10:00:00\n+++ packages/app/src/x.ts\t2026-10-02 10:00:00\n@@ -1 +1 @@\n-const a = 1;\n+fs.rmSync(x);\n";
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("内容[清理/删除]: packages/app/src/x.ts");
  });
  it("hunk 行数偏小(被截断/手改)→ 多出来的增删行 fail closed", () => {
    const d = "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1 +1 @@\n-const a = 1;\n+const a = 2;\n+const b = 3;\n";
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("diff 格式异常");
  });
  it("无 diff --git 头的普通 diff -u:按 hunk 行数结束,下一个文件的路径照判", () => {
    const d = "--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1 +1 @@\n-const n = 1;\n+const n = 2;\n--- a/scripts/cleanup.sh\n+++ b/scripts/cleanup.sh\n@@ -1 +1 @@\n-echo a\n+echo b\n";
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("路径: scripts/cleanup.sh");
  });
  it("路径里含 \" b/\" 时按中点切分", () => {
    const r = risk("diff --git a/x b/upload.ts b/x b/upload.ts\nold mode 100644\nnew mode 100755\n");
    expect(r.out).toContain("路径: x b/upload.ts\n");
  });
  it("只改权限 / 二进制 / 带引号路径:从 diff 头取路径", () => {
    expect(risk("diff --git a/scripts/cleanup.sh b/scripts/cleanup.sh\nold mode 100644\nnew mode 100755\n").status).toBe(1);
    expect(risk("diff --git a/assets/upload.bin b/assets/upload.bin\nindex 1..2 100644\nBinary files a/assets/upload.bin and b/assets/upload.bin differ\n").status).toBe(1);
    expect(risk('diff --git "a/packages/app/src/\\344cleanup.ts" "b/packages/app/src/\\344cleanup.ts"\nnew file mode 100644\n').status).toBe(1);
    expect(risk("diff --git a/assets/logo.bin b/assets/logo.bin\nBinary files a/assets/logo.bin and b/assets/logo.bin differ\n").status).toBe(0);
  });
  it("hunk 内以 -- 开头的删除行是内容,不当文件头", () => {
    const d = "diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,2 +1,1 @@\n--- a/packages/app/src/upload.ts\n-rmSync(p);\n";
    const r = risk(d);
    expect(r.status).toBe(1);
    expect(r.out).toContain("内容[清理/删除]: packages/app/src/x.ts");
    expect(r.out).not.toContain("upload.ts");
  });
  it("删除文件也按路径判 RISK", () => {
    const d = "diff --git a/packages/app/src/cleanup.ts b/packages/app/src/cleanup.ts\ndeleted file mode 100644\n--- a/packages/app/src/cleanup.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    expect(risk(d).status).toBe(1);
  });
});

describe("issue-guard.py --diff", () => {
  // `seed` writes files that must already exist on the base branch, so the feature diff shows them
  // as context (a credential file whose only changed line is `"value"` is exactly that case).
  function repo(seed?: (d: string) => void) {
    const d = mkdtempSync(join(tmpdir(), "guard-"));
    const g = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf-8" });
    g("init", "-q", "-b", "base");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs", "a.md"), "历史里的 BV1Ab4y1C7xY 与 10.0.0.1\n"); // issue-guard: allow
    seed?.(d);
    g("add", ".");
    g("commit", "-qm", "base");
    g("checkout", "-q", "-b", "feature");
    return { d, g };
  }
  const guard = (d: string) => spawnSync("python3", [GUARD, "--diff", "base"], { cwd: d, encoding: "utf-8" });

  it("历史里的隐私内容不计入,干净新增 → 0", () => {
    const { d, g } = repo();
    appendFileSync(join(d, "docs", "a.md"), "干净的新行\n");
    g("commit", "-qam", "c");
    expect(guard(d).status).toBe(0);
  });
  it("新增行含 BV 号 → 1", () => {
    const { d, g } = repo();
    appendFileSync(join(d, "docs", "a.md"), "新增 BV1Zz9y1C7xA\n"); // issue-guard: allow
    g("commit", "-qam", "c");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("BV 号");
  });
  it("源码里的文件名/cookie 字样放行,IP 仍拦", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "x.ts"), "const f = 'foo.ts'; // cookie token\n");
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).status).toBe(0);
    appendFileSync(join(d, "x.ts"), "const ip = '192.168.1.9';\n"); // issue-guard: allow
    g("commit", "-qam", "c2");
    expect(guard(d).status).toBe(1);
  });
  it("allow 标记在文档里无效,照常拦", () => {
    const { d, g } = repo();
    appendFileSync(join(d, "docs", "a.md"), "夹具 BV1Zz9y1C7xA issue-guard: allow\n"); // issue-guard: allow
    g("commit", "-qam", "c");
    expect(guard(d).status).toBe(1);
  });
  it("allow 标记只在测试夹具生效,并打印跳过行数与位置", () => {
    const { d, g } = repo();
    mkdirSync(join(d, "test"));
    writeFileSync(join(d, "test", "f.test.ts"), "const ip = '10.0.0.7'; // issue-guard: allow\n"); // issue-guard: allow
    g("add", ".");
    g("commit", "-qm", "c");
    const r = guard(d);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("allow 标记跳过 1 行");
    expect(r.stderr).toContain("test/f.test.ts:1");
  });
  it("json 只豁免文件名/主机名:IP 与长数字照拦,文件名放行", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "c.json"), '{ "id": "vps2", "file": "rec.flv" }\n');
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).status).toBe(0);
    appendFileSync(join(d, "c.json"), '{ "host": "10.1.2.3" }\n'); // issue-guard: allow
    g("commit", "-qam", "c2");
    expect(guard(d).stderr).toContain("IP 地址");
  });
  it("json 形态的登录凭证(键值与 name/value)也拦", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "c.json"), '{ "sessionid": "0123abcd4567ef89aabbccdd" }\n'); // issue-guard: allow
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).stderr).toContain("登录凭证键值");
    const r2 = repo();
    writeFileSync(join(r2.d, "k.json"), '[{"name":"SESSDATA","value":"a1b2c3d4%2C17900%2Cabcdef"}]\n'); // issue-guard: allow
    r2.g("add", ".");
    r2.g("commit", "-qm", "c");
    expect(guard(r2.d).stderr).toContain("name/value");
  });
  it("多行(格式化后的) name/value 凭证也拦,行号指向 name 行", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "k.json"), '[\n  {\n    "name": "SESSDATA",\n    "value": "a1b2c3d4%2C17900%2Cabcdef"\n  }\n]\n'); // issue-guard: allow
    g("add", ".");
    g("commit", "-qm", "c");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("k.json:3: [登录凭证键值]");
  });
  it("只改 value 行(文件已在 base,name 是上下文行)也拦,并指向 name 行", () => {
    // The whole file is created on base, so the diff carries only the changed `value` line. Without
    // the neighbouring context lines the name/value rule would never see them together.
    const pretty = (v: string) => `[\n  {\n    "name": "SESSDATA",\n    "value": "${v}",\n    "domain": ".bilibili.com"\n  }\n]\n`;
    const { d, g } = repo((dir) => writeFileSync(join(dir, "k.json"), pretty("OLDVALUEa1b2c3d4%2C17900")));
    writeFileSync(join(d, "k.json"), pretty("NEWVALUEa1b2c3d4%2C17900")); // issue-guard: allow
    g("commit", "-qam", "c");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("k.json:3: [登录凭证键值]");
  });
  it("name/value 都在上下文里、只在它们下面插入无关行 → 不拦(旧内容不卡红)", () => {
    const body = (extra: string) => `[\n  {\n    "name": "SESSDATA",\n    "value": "OLDVALUEa1b2c3d4%2C17900",\n${extra}  }\n]\n`; // issue-guard: allow
    const { d, g } = repo((dir) => writeFileSync(join(dir, "notes.md"), body(""))); // issue-guard: allow
    writeFileSync(join(d, "notes.md"), body('    "note": "unrelated",\n'));
    g("commit", "-qam", "c");
    expect(guard(d).status).toBe(0);
  });
  it("夹具里带 allow 标记的旧 value 行不会作为上下文被重新扫描", () => {
    // Old allow-marked value line sits above a newly added name line (value-then-name layout).
    // The mark sits inside the value string so the line still matches the value-then-name rule.
    const old = '  "value": "OLDVALUEa1b2c3d4%2C17900 issue-guard: allow",\n'; // issue-guard: allow
    const { d, g } = repo((dir) => { mkdirSync(join(dir, "test")); writeFileSync(join(dir, "test", "f.test.ts"), old); }); // issue-guard: allow
    appendFileSync(join(d, "test", "f.test.ts"), '  "name": "SESSDATA",\n'); // issue-guard: allow
    g("commit", "-qam", "c");
    expect(guard(d).status).toBe(0);
  });
  it("value 在 name 之前的形态也拦", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "k.json"), '[{"value": "a1b2c3d4%2C17900%2Cabcdef", "name": "SESSDATA"}]\n'); // issue-guard: allow
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).stderr).toContain("value/name");
  });
  it("hunk 内以 ++ 开头的新增行仍按内容扫,不改写文件路径", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "docs", "b.md"), "++ 10.2.3.4\n"); // issue-guard: allow
    g("add", ".");
    g("commit", "-qm", "c");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("docs/b.md:1");
  });
  it("json 不再豁免场次键与凭证类词", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "c.json"), '{ "key": "douyin:abc:2026" }\n'); // issue-guard: allow
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).stderr).toContain("streamKey");
  });
  it("生成物不再整文件跳过:写进 IP 照拦,角色名放行", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "docs", "architecture.html"), "<p>vps1 rooms.json</p>\n");
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).status).toBe(0);
    appendFileSync(join(d, "docs", "architecture.html"), "<p>100.64.0.9</p>\n"); // issue-guard: allow
    g("commit", "-qam", "c2");
    expect(guard(d).status).toBe(1);
  });
  it("登录凭证键值对在源码里也拦;变量名/短值不误报", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "x.ts"), "const sessdata: string = c; const k = `sessionid=${v}`;\n");
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).status).toBe(0);
    appendFileSync(join(d, "x.ts"), "const c = 'sessionid=0123abcd4567ef89aabbccdd';\n"); // issue-guard: allow
    g("commit", "-qam", "c2");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("登录凭证键值");
  });
  it("MagicDNS 主机名(x.y.ts.net)在文档里拦;源码里主机名规则照旧豁免(#432)", () => {
    const { d, g } = repo();
    writeFileSync(join(d, "x.ts"), 'const host = "node-a.drec-xyz.ts.net";\n');
    g("add", ".");
    g("commit", "-qm", "c");
    expect(guard(d).status).toBe(0); // 反向:源码类文件不套主机名规则(CODE_SKIP 语义不变)
    appendFileSync(join(d, "docs", "a.md"), "节点 node-a.drec-xyz.ts.net 连不上\n"); // issue-guard: allow
    g("commit", "-qam", "c2");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("主机名");
  });
  it("本机路径新增 /root/ /mnt/ 前缀拦;相对路径、容器标准路径与 /srv/ 不拦(#432)", () => {
    const { d, g } = repo();
    appendFileSync(join(d, "docs", "a.md"), "数据在 /root/data,备份在 /mnt/backup\n"); // issue-guard: allow
    g("commit", "-qam", "c");
    const r = guard(d);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("本机路径");
    expect(r.stderr).toContain("/root/data");
    expect(r.stderr).toContain("/mnt/backup");
    const { d: d2, g: g2 } = repo();
    appendFileSync(join(d2, "docs", "a.md"), "输出在 data-local/recordings 目录\n");
    g2("commit", "-qam", "c");
    expect(guard(d2).status).toBe(0); // 反向:无挂载点前缀的相对路径不误伤
    // 反向:标准容器/安装路径与相对拼接不拦(Dockerfile、compose、install-worker 文档里的常规写法)
    const { d: d3, g: g3 } = repo();
    appendFileSync(join(d3, "docs", "a.md"), "RUN mkdir -p /root/.ssh\nCOPY ssh /root/.ssh/config\nENV P=/root/.cache/ms-playwright\n默认装到 /srv/drec 或 /srv/docker-data\nout=\"$t/root/node-1/x\"\n");
    g3("commit", "-qam", "c");
    appendFileSync(join(d3, "docs", "a.md"), "    - ./remote/vps.key:/root/.ssh/vps.key:ro\n");
    g3("commit", "-qam", "c2");
    const r3 = guard(d3);
    expect(r3.stderr).not.toContain("本机路径");
    expect(r3.status).toBe(0);
  });
});
