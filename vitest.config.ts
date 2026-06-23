import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// node:sqlite is a Node 24 builtin. module.builtinModules / isBuiltin only
// recognise it WITH the "node:" prefix ("sqlite" alone is not a builtin). Vite
// 5.4 strips the prefix before its builtin check, misses, and then tries to
// resolve a real "sqlite" package → "Failed to load url sqlite". We intercept
// the import in a load hook and hand back a thin ESM shim that re-exports the
// builtin via createRequire, so the transform pipeline never tries to resolve
// the bare "sqlite" id.
const SHIM_ID = "\0node-sqlite-shim";

function nodeSqliteShim() {
  return {
    name: "node-sqlite-shim",
    enforce: "pre" as const,
    resolveId(id: string) {
      if (id === "node:sqlite" || id === "sqlite") return SHIM_ID;
      return null;
    },
    load(id: string) {
      if (id === SHIM_ID) {
        return [
          "import { createRequire } from 'node:module';",
          "const require = createRequire(import.meta.url);",
          "const m = require('node:sqlite');",
          "export const DatabaseSync = m.DatabaseSync;",
          "export const StatementSync = m.StatementSync;",
          "export const constants = m.constants;",
          "export default m;",
        ].join("\n");
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [nodeSqliteShim()],
  // 测试就近(co-located,纯包):packages/**/*.test.ts 挨着源码;集成/元测试(假平台 setup、
  // arch 分层、app/session 等)仍在 test/。排除 web(自带 vite)与产物目录。
  test: {
    include: ["test/**/*.test.ts", "packages/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "packages/web/**"],
    setupFiles: ["./test/setup.ts"],
  },
  // workspace 包别名(随 packages/ 增长在此登记,让 vitest 解析 @drec/*)。
  resolve: {
    alias: {
      "@drec/core": fileURLToPath(new URL("./packages/core/src/index.ts", import.meta.url)),
      "@drec/manager": fileURLToPath(new URL("./packages/manager/src/index.ts", import.meta.url)),
      "@drec/post-process": fileURLToPath(new URL("./packages/post-process/src/index.ts", import.meta.url)),
      "@drec/douyin-live": fileURLToPath(new URL("./packages/douyin-live/src/index.ts", import.meta.url)),
      "@drec/record-engine": fileURLToPath(new URL("./packages/record-engine/src/index.ts", import.meta.url)),
      "@drec/ffmpeg-recorder-extra": fileURLToPath(new URL("./packages/ffmpeg-recorder-extra/src/index.ts", import.meta.url)),
    },
  },
});
