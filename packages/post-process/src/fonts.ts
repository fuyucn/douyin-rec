import { existsSync } from "node:fs";
import { resolve, dirname, parse } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 从 startDir 向上逐级查找含 `assets/fonts` 的目录,命中即返回该 `assets/fonts` 绝对路径,否则 null。
 * 兼容两种运行布局(都能命中 `<repo>/assets/fonts`):
 *   - bundle:   import.meta.url = <repo>/dist/douyin-rec.mjs  → 上溯 1 级到 <repo>
 *   - 源码/vitest: packages/post-process/src/fonts.ts        → 上溯 3 级到 <repo>
 * 旧实现写死 `../../../../`(4 级)在两种布局下都越过仓库根 → 落到不存在的 `/Users/assets/fonts`,
 * 致烧录 ASS 字体回退(emoji 缺失)。改为搜索式,不再依赖固定深度。
 */
export function findAssetsFonts(startDir: string): string | null {
  let dir = startDir;
  const root = parse(dir).root;
  for (;;) {
    const candidate = resolve(dir, "assets", "fonts");
    if (existsSync(candidate)) return candidate;
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

const here = dirname(fileURLToPath(import.meta.url));
// FONTS_DIR env 覆盖优先;否则向上搜 assets/fonts;都没有则退回旧相对路径(最后兜底,保留原行为)。
export const FONTS_DIR =
  process.env.FONTS_DIR ?? findAssetsFonts(here) ?? resolve(here, "..", "..", "..", "..", "assets", "fonts");
