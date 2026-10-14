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
  it("删除文件也按路径判 RISK", () => {
    const d = "diff --git a/packages/app/src/cleanup.ts b/packages/app/src/cleanup.ts\ndeleted file mode 100644\n--- a/packages/app/src/cleanup.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-x\n";
    expect(risk(d).status).toBe(1);
  });
});

describe("issue-guard.py --diff", () => {
  function repo() {
    const d = mkdtempSync(join(tmpdir(), "guard-"));
    const g = (...a: string[]) => spawnSync("git", a, { cwd: d, encoding: "utf-8" });
    g("init", "-q", "-b", "base");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    mkdirSync(join(d, "docs"));
    writeFileSync(join(d, "docs", "a.md"), "历史里的 BV1Ab4y1C7xY 与 10.0.0.1\n"); // issue-guard: allow
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
  it("issue-guard: allow 标记的新增行跳过", () => {
    const { d, g } = repo();
    appendFileSync(join(d, "docs", "a.md"), "夹具 BV1Zz9y1C7xA issue-guard: allow\n"); // issue-guard: allow
    g("commit", "-qam", "c");
    expect(guard(d).status).toBe(0);
  });
});
