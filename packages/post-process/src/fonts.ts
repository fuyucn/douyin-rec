import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
// 编译后位于 dist/... 或 bundle；用 env 覆盖优先，否则相对仓库根 assets/fonts
const here = dirname(fileURLToPath(import.meta.url));
export const FONTS_DIR =
  process.env.FONTS_DIR ?? resolve(here, "..", "..", "..", "..", "assets", "fonts");
