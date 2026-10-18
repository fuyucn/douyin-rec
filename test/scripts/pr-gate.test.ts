/** pr-gate.py:合格正文 PASS;各类缺项 FAIL 并点名(issue #78)。不联网。 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const GATE = join(import.meta.dirname, "..", "..", "scripts", "pr-gate.py");

const GOOD = `Fixes #78

## 改动范围
- scripts 下新增脚本与迁移表,新增测试

## 验证方式
无需部署(纯工具与测试)

## 自审五项
- 边界: 发现空标签起步 → 修复为允许从无状态迁移
- 并发: 无(脚本单次执行,不持有跨进程状态)
- 静默失败: 发现 gh 写失败被吞 → 修复为退出码 5
- 一致性: 无(迁移表是唯一来源,测试读同一份)
- 分层: 无(未触及 packages)

## 变异验证
### 撤修复(FAIL)
\`\`\`
 FAIL  suite > 非法迁移被拒
Tests  1 failed
\`\`\`

### 复原(PASS)
\`\`\`
 ✓ suite (12 tests)
Tests  12 passed (PASS)
\`\`\`

## 验证命令与输出
\`\`\`
$ pnpm test
Tests  900 passed
$ pnpm typecheck
ok
\`\`\`

## 评论采纳情况
无评论

## 回写位置
文档流程文档的工具小节与测试目录

## 残余风险
无,依据:全部离线可测

## 版本
无需 bump:仅 scripts 与测试,不改运行时产物
`;

function gate(body: string, extra: string[] = []) {
  const f = join(mkdtempSync(join(tmpdir(), "prgate-")), "body.md");
  writeFileSync(f, body);
  const r = spawnSync("python3", [GATE, "--body-file", f, ...extra], { encoding: "utf-8" });
  return { status: r.status, lines: r.stdout.split("\n").filter(Boolean) };
}

describe("pr-gate.py", () => {
  it("合格正文 → PASS", () => {
    const r = gate(GOOD, ["--title", "feat(scripts): x", "--files", "scripts/a.py,test/a.test.ts"]);
    expect(r.lines).toEqual(["PASS"]);
    expect(r.status).toBe(0);
  });
  it("缺 Fixes → FAIL", () => {
    const r = gate(GOOD.replace("Fixes #78\n", ""));
    expect(r.status).toBe(1);
    expect(r.lines.join("\n")).toContain("Fixes #N");
  });
  it("缺整段 / 段为空 / 仅占位 → 点名", () => {
    const r = gate(GOOD.replace(/## 残余风险[\s\S]*?(?=## 版本)/, "").replace(/## 回写位置\n.*\n/, "## 回写位置\n待填\n"));
    const out = r.lines.join("\n");
    expect(out).toContain("缺必填段「## 残余风险」");
    expect(out).toContain("「回写位置」为空或仍是占位");
  });
  it("自审:只写「无」没理由、缺一项 → FAIL", () => {
    const r = gate(GOOD.replace("- 并发: 无(脚本单次执行,不持有跨进程状态)", "- 并发: 无").replace(/- 分层:.*\n/, ""));
    const out = r.lines.join("\n");
    expect(out).toContain("自审「并发」写了「无」但没给理由");
    expect(out).toContain("自审五项缺「分层」");
  });
  it("自审:「- 并发:」留空且下一行含 → 不得吞下一行 → FAIL", () => {
    const mutated = GOOD.replace("- 并发: 无(脚本单次执行,不持有跨进程状态)", "- 并发:");
    expect(mutated).not.toBe(GOOD);
    const r = gate(mutated);
    expect(r.status).toBe(1);
    expect(r.lines.join("\n")).toContain("自审五项缺「并发」");
    const spaced = gate(GOOD.replace("- 并发: 无(脚本单次执行,不持有跨进程状态)", "- 并发:   "));
    expect(spaced.lines.join("\n")).toContain("自审五项缺「并发」");
  });
  it("占位符:路径里的 TODO.md / git 范围 ... 不算占位 → PASS", () => {
    const body = GOOD.replace("无评论", "TODO.md 记 T-90;对照 origin/feat/hub-optimization...HEAD 的 diff");
    expect(body).not.toBe(GOOD);
    expect(gate(body).lines).toEqual(["PASS"]);
  });
  it("占位符:独立 TODO / TBD / 待填... 仍算占位 → FAIL", () => {
    for (const ph of ["TODO 补充", "TBD", "待填...", "稍后补..."]) {
      const r = gate(GOOD.replace("无评论", ph));
      expect(r.lines.join("\n"), ph).toContain("「评论采纳情况」为空或仍是占位");
    }
    const sr = gate(GOOD.replace("- 边界: 发现空标签起步 → 修复为允许从无状态迁移", "- 边界: TODO 修复"));
    expect(sr.lines.join("\n")).toContain("自审「边界」仍是占位内容");
  });
  it("变异验证:只有 FAIL 没有 PASS → FAIL", () => {
    const r = gate(GOOD.replace(/### 复原\(PASS\)[\s\S]*?(?=## 验证命令)/, "### 复原(PASS)\n\n"));
    expect(r.lines.join("\n")).toContain("缺「复原」段的 PASS 输出");
    expect(r.lines.join("\n")).not.toContain("缺「撤修复」段");
  });
  it("变异验证:FAIL 段里没有 FAIL 字样 → FAIL", () => {
    const mutated = GOOD.replace("FAIL  suite", "ok  suite").replace("1 failed", "1 passed");
    expect(mutated).not.toBe(GOOD);
    const r = gate(mutated);
    expect(r.lines.join("\n")).toContain("缺「撤修复」段的 FAIL 输出");
  });
  it("验证命令缺 pnpm typecheck / 无输出块 → FAIL", () => {
    const r = gate(GOOD.replace(/## 验证命令与输出[\s\S]*?(?=## 评论)/, "## 验证命令与输出\npnpm test 过了\n\n"));
    const out = r.lines.join("\n");
    expect(out).toContain("缺 `pnpm typecheck`");
    expect(out).toContain("缺真实输出");
  });
  it("feat/fix 没有版本声明 → FAIL;bump 非 patch+1 → FAIL;合法 bump → PASS", () => {
    const noVer = GOOD.replace(/无需 bump:.*/, "见上");
    expect(gate(noVer, ["--title", "fix(app): y"]).lines.join("\n")).toContain("须声明版本");
    const bad = GOOD.replace(/无需 bump:.*/, "0.0.5 → 0.0.7");
    expect(gate(bad, ["--title", "fix(app): y"]).lines.join("\n")).toContain("patch +1");
    const ok = GOOD.replace(/无需 bump:.*/, "0.0.5 → 0.0.6");
    expect(gate(ok, ["--title", "fix(app): y"]).status).toBe(0);
  });
  it("声明不 bump 但改了运行时路径 → FAIL", () => {
    const r = gate(GOOD, ["--title", "fix(app): y", "--files", "packages/app/src/a.ts"]);
    expect(r.lines.join("\n")).toContain("触及运行时路径");
  });
  it("工具类白名单：docs/scripts/test/.github 等不 bump 放行；任一运行时路径命中即 FAIL", () => {
    const tool = ["docs/a.md", "scripts/a.py", "test/a.test.ts", ".github/pull_request_template.md", "plans/a.md", "dev/a.sh", "remote/a.sh"];
    expect(gate(GOOD, ["--title", "fix(scripts): y", "--files", tool.join(",")]).status).toBe(0);
    // A declared bump must actually bump the manifest; otherwise "无需 bump" and a
    // fake "0.0.1 → 0.0.2" would both pass for a change that alters the artifact.
    const declared = GOOD.replace(/无需 bump:.*/, "0.0.1 → 0.0.2");
    expect(gate(declared, ["--title", "fix(app): y", "--files", "packages/app/src/a.ts"]).lines.join("\n")).toContain("声明 bump 版本,但改动文件里没有根 package.json");
    for (const runtime of ["packages/x.ts", "package.json", "Dockerfile", "docker-compose.yml", "dist/douyin-rec.mjs",
                           "configs/hub.config.example.json", "assets/fonts/a.woff2", "esbuild.config.mjs",
                           "tsconfig.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".dockerignore",
                           "scripts/install-mesio.sh", "scripts/install-biliup.sh"]) {
      const r = gate(GOOD, ["--title", "fix(scripts): y", "--files", [...tool, runtime].join(",")]);
      expect(r.lines.join("\n"), runtime).toContain("触及运行时路径");
    }
  });
  it("按路径判定,不看 type 与措辞:chore/refactor 触及运行时路径也须 bump;packages 下测试文件豁免", () => {
    for (const [title, wording, file] of [
      ["chore(deps): y", "无需 bump:依赖升级", "pnpm-lock.yaml"],
      ["chore(deps): y", "chore 不涉及版本号变化", "pnpm-lock.yaml"],
      ["refactor(app): y", "重构无行为变化,版本不变", "packages/app/src/a.ts"],
    ]) {
      const body = GOOD.replace(/无需 bump:.*/, wording);
      expect(gate(body, ["--title", title, "--files", file]).lines.join("\n"), `${title} ${wording}`).toContain("触及运行时路径");
    }
    expect(gate(GOOD, ["--title", "test(app): y", "--files", "packages/app/src/a.test.ts"]).status).toBe(0);
    // Exemption matches what vitest collects; a .tsx "test" ships like any other source.
    expect(gate(GOOD, ["--title", "test(web): y", "--files", "packages/web/src/a.test.tsx"]).lines.join("\n")).toContain("触及运行时路径");
  });
  it("未触及运行时路径时不看 type:feat 只改文档、理由不含固定措辞也放行;无需 bump 里引用旧版本号不误判", () => {
    const docsOnly = ["--files", "docs/a.md"];
    const plain = GOOD.replace(/无需 bump:.*/, "文档改动,版本不变");
    expect(gate(plain, ["--title", "feat(docs): y", ...docsOnly]).status).toBe(0);
    expect(gate(plain, ["--title", "docs: y", ...docsOnly]).status).toBe(0);
    const quoted = GOOD.replace(/无需 bump:.*/, "无需 bump;上次 0.0.5 → 0.0.6 已部署");
    expect(gate(quoted, ["--title", "docs: y", ...docsOnly]).status).toBe(0);
  });
  it("模板里的 HTML 注释与占位不算内容;原样模板 → FAIL", () => {
    const tpl = join(import.meta.dirname, "..", "..", ".github", "pull_request_template.md");
    const r = spawnSync("python3", [GATE, "--body-file", tpl, "--title", "feat(x): y"], { encoding: "utf-8" });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("缺 `Fixes #N`");
  });
  it("正文含隐私 → FAIL(可用 --no-guard 关闭)", () => {
    const dirty = GOOD.replace("无评论", "见 10.1.2.3 节点"); // issue-guard: allow
    expect(gate(dirty).lines.join("\n")).toContain("隐私闸门");
    expect(gate(dirty, ["--no-guard"]).status).toBe(0);
  });
});
