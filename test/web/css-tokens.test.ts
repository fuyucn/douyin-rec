/**
 * 幽灵 token 守卫:`var(--x)` 必须在 index.css 里真的定义过。
 *
 * `--r-pill` 曾是全仓最典型的坑——三处 `var(--r-pill, 999px)` 靠 fallback 撞对了形状,
 * 变量本身从未存在,于是没人发现"胶囊 vs 6px 方角"是同一种控件两种形状。
 * 只拦**没有 fallback** 的引用:带 fallback 的写法是有意的降级,不是这个测试的对象。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const WEB = join(dirname(fileURLToPath(import.meta.url)), "../../packages/web/src");
const CSS = readFileSync(join(WEB, "index.css"), "utf8");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(css|ts|tsx)$/.test(entry)) out.push(path);
  }
  return out;
}

/** Every custom property declared anywhere in index.css (`:root`, `.dark`, `@theme`, local blocks). */
function definedTokens(css: string): Set<string> {
  const out = new Set<string>();
  for (const m of css.matchAll(/--([a-z0-9-]+)\s*:/gi)) out.add(m[1]);
  return out;
}

/** `var(--x)` without a comma → no fallback → the token must exist. */
function bareVarReferences(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/var\(\s*--([a-z0-9-]+)\s*\)/gi)) out.push(m[1]);
  return out;
}

describe("index.css custom properties", () => {
  it("every var() without a fallback resolves to a declared token", () => {
    const defined = definedTokens(CSS);
    const missing: string[] = [];
    for (const file of sourceFiles(WEB)) {
      for (const name of bareVarReferences(readFileSync(file, "utf8"))) {
        if (!defined.has(name)) missing.push(`--${name} (${file.slice(WEB.length + 1)})`);
      }
    }
    expect(missing, `undeclared tokens used without fallback: ${missing.join(", ")}`).toEqual([]);
  });

  it("the retired pill fallback does not come back", () => {
    for (const file of sourceFiles(WEB)) {
      expect(readFileSync(file, "utf8"), file).not.toContain("--r-pill");
    }
  });
});
