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
  it("上下文只取改动前后 20 行;hunk 头函数名参与匹配", () => {
    const ctx = (n: number) => Array.from({ length: n }, (_, i) => ` const c${i} = ${i};`).join("\n");
    const mk = (gap: number, hdr = "") =>
      `diff --git a/packages/app/src/x.ts b/packages/app/src/x.ts\n--- a/packages/app/src/x.ts\n+++ b/packages/app/src/x.ts\n@@ -1,9 +1,9 @@${hdr}\n rmSync(p);\n${ctx(gap)}\n-const n = 1;\n+const n = 2;\n`;
    expect(risk(mk(5)).status).toBe(1);   // within the window
    expect(risk(mk(30)).status).toBe(0);  // beyond the window
    expect(risk(mk(30, " function cleanupStage() {")).status).toBe(1); // function header
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
});
