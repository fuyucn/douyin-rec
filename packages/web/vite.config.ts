import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The built SPA is served by the node CLI (`task serve`) from web/dist/.
// During dev, proxy /api to a locally-running `task serve` (default :7860).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@drec/contracts": fileURLToPath(new URL("../core/src/api-types.ts", import.meta.url)) } },
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
        changeOrigin: true,
      },
    },
  },
});
