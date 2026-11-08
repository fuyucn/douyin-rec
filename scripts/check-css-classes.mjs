/**
 * check-css-classes.mjs — index.css 里声明的每个 `.class` 都必须在 packages/web/src 里被引用。
 *
 * 为什么要有这条:删除死 CSS 的最大风险不是"删多",而是"没人知道哪些是死的"——`rt-*` 旧 run-tree
 * 和 `metric-*` 旧指标卡在设计重做后留下几百行,下一个改这块的人会把它们当成活的。
 *
 * 三类不算死:
 *   1. 源码里以完整 token 出现(不是子串:`rt` 不能因为 `rt-stages-toggle` 而活着);
 *   2. 源码用模板字符串动态拼接(`tr-part-${state}` → 前缀 `tr-part-`);
 *   3. 第三方组件的命名空间(`react-flow__*` 由 @xyflow/react 渲染)。
 *
 * 扫描范围包含 `@media` / `@supports` 里的规则——它们和顶层规则一样会生效,也一样会过时。
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SRC = join(ROOT, "packages/web/src");
const CSS = join(SRC, "index.css");

/** Third-party component namespaces: rendered by a library, never literal in our source. */
const THIRD_PARTY = [/^react-flow__/, /^lucide-/, /^react-aria/];

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|tsx|css|html)$/.test(entry) && path !== CSS) out.push(path);
  }
  return out;
}

/** Drop comments so commented-out class names cannot keep a rule alive. */
export function stripComments(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Class names declared in selectors, including rules nested in at-rules (`@media`, `@supports`).
 * Declarations are never read: we only look at the text before each `{`.
 */
export function declaredClasses(css) {
  const names = new Set();
  const text = stripComments(css);
  let depth = 0;
  let selector = "";
  for (const ch of text) {
    if (ch === "{") {
      if (!selector.trim().startsWith("@")) {
        for (const m of selector.matchAll(/\.([a-zA-Z][\w-]*)/g)) names.add(m[1]);
      }
      depth++;
      selector = "";
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
      selector = "";
    } else {
      selector += ch;
    }
  }
  return names;
}

/** Template-literal prefixes used to compose class names (`tr-part-${state}` → `tr-part-`). */
export function dynamicPrefixes(texts) {
  const prefixes = new Set();
  for (const text of texts) {
    for (const literal of text.matchAll(/`([^`]*)`/g)) {
      if (!literal[1].includes("${")) continue;
      for (const m of literal[1].matchAll(/([A-Za-z][\w-]*(?:\s+[A-Za-z][\w-]*)*)\$\{/g)) {
        const fragment = m[1].split(/\s/).pop();
        if (fragment) prefixes.add(fragment);
      }
    }
  }
  return prefixes;
}

/** Whole-token match: `rt` must not pass because `rt-stages-toggle` exists somewhere. */
export function isReferenced(name, blob) {
  return new RegExp(`(^|[^\\w-])${name.replace(/[-[\]{}()+*^$|\\\\]/g, "\\$&")}([^\\w-]|$)`).test(blob);
}

export function findDeadClasses(css, sources, prefixes = []) {
  const blob = sources.join("\n");
  const dead = [];
  for (const name of declaredClasses(css)) {
    if (isReferenced(name, blob)) continue;
    // `tr-part` 与 `tr-part-${state}` 同族:有前缀就等于这一族在用。
    if (prefixes.some((p) => name.startsWith(p) || p.startsWith(`${name}-`))) continue;
    if (THIRD_PARTY.some((re) => re.test(name))) continue;
    dead.push(name);
  }
  return dead;
}

function main() {
  const css = readFileSync(CSS, "utf8");
  const files = sourceFiles(SRC);
  const dead = findDeadClasses(css, files.map((f) => readFileSync(f, "utf8")), [...dynamicPrefixes(files.map((f) => readFileSync(f, "utf8")))]);

  if (dead.length) {
    const families = new Map();
    for (const name of dead.sort()) {
      const family = name.split("-")[0] + "-";
      families.set(family, [...(families.get(family) ?? []), name]);
    }
    console.error(`✗ ${dead.length} 个没有被引用的 CSS 类(${relative(ROOT, CSS)}):`);
    for (const [family, names] of [...families].sort()) console.error(`  ${family.padEnd(14)} ${names.join(" ")}`);
    process.exit(1);
  }
  console.log(`✅ ${relative(ROOT, CSS)} 里声明的类全部有引用`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
