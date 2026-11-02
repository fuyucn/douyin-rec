import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built SPA is served by the node CLI (`task serve`) from web/dist/.
// During dev, proxy /api to a locally-running `task serve` (default :7860).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@drec/contracts": fileURLToPath(new URL("../core/src/api-types.ts", import.meta.url)),
      // 实验性功能注册表(纯数据,无 import):徽标文案的单一来源(issue #43)
      "@drec/experimental": fileURLToPath(new URL("../core/src/experimental.ts", import.meta.url)),
      // 边录边传生效判定(纯函数):表单的禁用原因与后端下发同源,不在前端另写一份(房间表单重设计 T1)
      "@drec/rolling-policy": fileURLToPath(new URL("../core/src/rolling-policy.ts", import.meta.url)),
      "@drec/zero-disk-policy": fileURLToPath(new URL("../core/src/zero-disk-policy.ts", import.meta.url)),
      // 输出格式注册表(纯数据/纯函数):下拉选项、投稿锁定、缺省都与后端同源(issue #137)
      "@drec/output-format": fileURLToPath(new URL("../core/src/output-format.ts", import.meta.url)),
      // Hub job state names (pure constants): room status uses the same terminal set as the ledger
      "@drec/hub-ledger-contract": fileURLToPath(new URL("../core/src/hub-ledger-contract.ts", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // 把 react 全家桶与其余第三方拆成独立 vendor chunk，主包只留业务代码。
        manualChunks(id: string): string | undefined {
          if (!id.includes("node_modules")) return undefined;
          if (/(?:^|[/\\])node_modules[/\\](react|react-dom|scheduler)[/\\]/.test(id)) return "react-vendor";
          return "vendor";
        },
      },
    },
  },
  server: {
    proxy: {
      "/api": {
        target: process.env.API_TARGET ?? "http://localhost:7860",
        // 不开 changeOrigin:后端有 Origin 同源校验(issue #427),按 Host 判同源。开 changeOrigin 会把
        // Host 改写成 target(localhost:7860),与浏览器 Origin(localhost:5173)不符 → 所有写请求 403。
        // 保留原始 Host,前端 dev 代理下的同源判定才能通过。
      },
    },
  },
});
