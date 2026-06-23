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
