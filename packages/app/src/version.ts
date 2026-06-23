/**
 * 应用版本号。格式 `0.0.0-{commit 后6位}`,由 `pnpm bundle`(esbuild)在打包时经 `define`
 * 把源码里的 `__APP_VERSION__` 替换成字面量(见 esbuild.config.mjs)。
 *
 * 非打包环境(tsx 直跑 / vitest)没有 `define` → `__APP_VERSION__` 未声明,用 `typeof` 安全探测
 * (短路避免 ReferenceError)→ 回落 "0.0.0-dev"。
 */
declare const __APP_VERSION__: string | undefined;

export const APP_VERSION: string =
  (typeof __APP_VERSION__ !== "undefined" && __APP_VERSION__) || "0.0.0-dev";
