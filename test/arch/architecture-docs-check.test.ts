/**
 * architecture-docs-check.test.ts — 钉死 `gen-architecture.mjs --check` 的口径(issue #29)。
 *
 * --check 只能比对**结构**(包清单 / 依赖边 / 层级 / mermaid),不能比对热度统计
 * (LOC / 文件数 / 测试数 / 近 N 天提交数)与生成时间——否则任何提交都会让守护变红。
 * 这里在临时副本里造两类变更:热度变化必须仍绿,结构漂移必须变红。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
let tmp: string;

function check(): { status: number | null; out: string } {
  const r = spawnSync("node", [join(tmp, "scripts", "gen-architecture.mjs"), "--check"], { cwd: tmp, encoding: "utf-8" });
  return { status: r.status, out: r.stdout + r.stderr };
}

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "arch-check-"));
  cpSync(join(ROOT, "scripts"), join(tmp, "scripts"), { recursive: true });
  cpSync(join(ROOT, "docs", "architecture.html"), join(tmp, "docs", "architecture.html"));
  cpSync(join(ROOT, "docs", "architecture.md"), join(tmp, "docs", "architecture.md"));
  cpSync(join(ROOT, "test", "arch", "layering.test.ts"), join(tmp, "test", "arch", "layering.test.ts"));
  if (existsSync(join(ROOT, "plans", "030_tasks.json"))) cpSync(join(ROOT, "plans", "030_tasks.json"), join(tmp, "plans", "030_tasks.json"));
  for (const dir of readdirSync(join(ROOT, "packages"))) {
    const pj = join(ROOT, "packages", dir, "package.json");
    if (!existsSync(pj)) continue;
    cpSync(pj, join(tmp, "packages", dir, "package.json"));
    const src = join(ROOT, "packages", dir, "src");
    if (existsSync(src)) cpSync(src, join(tmp, "packages", dir, "src"), { recursive: true });
  }
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("gen-architecture --check 口径", () => {
  it("基线:结构一致 → 绿", () => {
    const r = check();
    expect(r.out).toContain("结构与仓库一致");
    expect(r.status).toBe(0);
  });

  it("热度统计变化(新增源码行/文件/测试、提交数)不得变红", () => {
    const core = join(tmp, "packages", "core", "src");
    appendFileSync(join(core, "platform.ts"), "\nexport const __heat_probe = 1;\n".repeat(50));
    writeFileSync(join(core, "extra-heat.ts"), "export const x = 1;\n");
    writeFileSync(join(core, "extra-heat.test.ts"), "export {};\n");
    const r = check();
    expect(r.out).toContain("结构与仓库一致");
    expect(r.status).toBe(0);
  });

  it("生成时间戳变化不得变红", () => {
    const f = join(tmp, "docs", "architecture.html");
    const html = readFileSync(f, "utf-8").replace(/(生成 · 热度窗口近 \d+ 天 · )[^<]*/, "$11999-01-01 00:00");
    writeFileSync(f, html);
    expect(check().status).toBe(0);
  });

  it("结构漂移(新增依赖边)必须变红", () => {
    const f = join(tmp, "packages", "manager", "package.json");
    const original = readFileSync(f, "utf-8");
    const j = JSON.parse(original);
    j.dependencies = { ...(j.dependencies ?? {}), "@drec/kuaishou-live": "workspace:*" };
    writeFileSync(f, JSON.stringify(j));
    const r = check();
    expect(r.status).toBe(1);
    expect(r.out).toContain("结构");
    // 还原:后续用例要靠「基线绿」才能证明各自的单一变更才是变红原因
    writeFileSync(f, original);
    expect(check().status).toBe(0);
  });

  it("结构漂移(层级 rank 改动)必须变红", () => {
    const f = join(tmp, "test", "arch", "layering.test.ts");
    const original = readFileSync(f, "utf-8");
    const changed = original.replace(/("@drec\/core":\s*)0\b/, "$10.25");
    expect(changed).not.toBe(original);
    writeFileSync(f, changed);
    expect(check().status).toBe(1);
    writeFileSync(f, original);
    expect(check().status).toBe(0);
  });

  it("产物缺结构标记(老格式)视为漂移", () => {
    const f = join(tmp, "docs", "architecture.html");
    writeFileSync(f, readFileSync(f, "utf-8").replace(/<script type="application\/json" id="arch-structure">[\s\S]*?<\/script>/, ""));
    expect(check().status).toBe(1);
  });
});
