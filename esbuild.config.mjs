// Bundles src/cli.ts into a single self-contained file: dist/douyin-rec.mjs
// + a SEPARATE dist/tui.mjs for the Ink TUI (kept out of the main bundle so its
// React/Ink deps never become eager top-level imports — that would crash
// `task serve` in docker where node_modules isn't present).
//
// banner notes:
//   1. shebang must be line 1 (the source no longer carries one — esbuild would
//      otherwise place the banner BEFORE the preserved shebang, breaking it).
//   2. createRequire shim: ESM output + bundled CJS deps (commander etc.) emit
//      `require("node:events")`; without a real `require` in ESM scope esbuild's
//      __require stub throws "Dynamic require ... not supported". The shim wires
//      `require` to the real one so node built-ins / externals resolve.
import { build } from "esbuild";
import { writeFileSync, chmodSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";

// 版本号 = {package.json version}-{commit 后6位}。基底版本号单一真相 = 根 package.json 的 `version`
// (bump 版本只改那一处)。host 本地打包直接读 git 拿 sha;docker 容器内无 .git/git,由 Dockerfile
// 的 GIT_SHA build-arg → ENV 注入(见 docker-compose.yml build.args)。两者都拿不到 → "dev"。
// 经 esbuild `define` 替换源码里的 __APP_VERSION__(见 app/version.ts)。
function gitSha() {
  if (process.env.GIT_SHA) return process.env.GIT_SHA.trim();
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}
const pkgVersion = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version;
const sha = gitSha();
const APP_VERSION = `${pkgVersion}-${sha ? sha.slice(-6) : "dev"}`;
console.log(`[bundle] APP_VERSION=${APP_VERSION}`);

const REQUIRE_SHIM =
  "import{createRequire as __createRequire}from'module';" +
  "const require=__createRequire(import.meta.url);";

const shared = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "info",
};

// ── Main bundle: CLI + serve (single file; docker runs this; NO TUI/React/Ink) ──
// The `task tui` action loads ./tui.mjs via a VARIABLE dynamic import, so esbuild
// can't statically follow it → the TUI (and its react/ink/yoga deps) stay OUT of
// this bundle. Keeps `task serve` loadable in docker without node_modules.
await build({
  ...shared,
  entryPoints: ["packages/cli/src/cli.ts"],
  outfile: "dist/douyin-rec.mjs",
  // - ws optional native speedups — not present, keep external so they no-op.
  // - playwright is heavy + ships native browser binaries; lazy-imported in QR login.
  external: ["bufferutil", "utf-8-validate", "playwright", "playwright-core"],
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  banner: { js: "#!/usr/bin/env node\n" + REQUIRE_SHIM },
});

// ── TUI bundle: separate file, contains JSX; ink/react/yoga stay external and
// resolve from node_modules at runtime (TUI only runs on a host, never in docker). ──
await build({
  ...shared,
  entryPoints: ["packages/tui/src/index.ts"],
  outfile: "dist/tui.mjs",
  jsx: "automatic",
  external: ["ink", "react", "react/jsx-runtime", "react/jsx-dev-runtime", "yoga-layout"],
  banner: { js: REQUIRE_SHIM },
});

// ── 便捷启动器 dist/douyin-rec：exec 同目录的 .mjs，省去 .mjs 后缀与 `node` 前缀。
//    用法：`./dist/douyin-rec task tui`。docker CMD / package.json bin 仍指 .mjs，互不影响。
const launcher =
  "#!/usr/bin/env sh\n" +
  "# 由 `pnpm bundle` 生成。`dist/douyin-rec <args>` == `node dist/douyin-rec.mjs <args>`。\n" +
  'exec node "$(dirname "$0")/douyin-rec.mjs" "$@"\n';
writeFileSync("dist/douyin-rec", launcher);
chmodSync("dist/douyin-rec", 0o755);
