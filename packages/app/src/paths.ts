/**
 * paths.ts — 单一数据根(DOUYIN_REC_ROOT)+ 固定内部布局。
 *
 *   <root>/db/douyin-rec.db          数据库(含抖音账号 cookie)
 *   <root>/recordings/               录像输出
 *   <root>/config/biliup/cookies.json  biliup B站上传 cookie(未来)
 *
 * 解析优先级(各处一致):专用 env(DOUYIN_REC_DB / DOUYIN_REC_OUTPUT / BILIUP_COOKIE)
 * > 由 DOUYIN_REC_ROOT 派生的固定子路径 > 各自的本地默认。专用 env 仍可单独覆盖某一项。
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

/**
 * hub 配置模板内容。**单一真相 = 仓库源文件 `configs/hub-config.example.json`**。
 * 打包(`pnpm bundle`)时 esbuild 经 `define` 把该文件文本内联成 `__HUB_CONFIG_EXAMPLE__`(单文件运行时无仓库目录);
 * 非打包(tsx/vitest)`__HUB_CONFIG_EXAMPLE__` 未声明 → 从仓库源文件读(相对本文件定位 repo 根)。
 */
declare const __HUB_CONFIG_EXAMPLE__: string | undefined;
function hubConfigExampleText(): string {
  if (typeof __HUB_CONFIG_EXAMPLE__ !== "undefined" && __HUB_CONFIG_EXAMPLE__) return __HUB_CONFIG_EXAMPLE__;
  return readFileSync(new URL("../../../configs/hub-config.example.json", import.meta.url), "utf-8");
}

/** DOUYIN_REC_ROOT(去空白);未设为 undefined。 */
export function drecRoot(): string | undefined {
  const r = (process.env.DOUYIN_REC_ROOT ?? "").trim();
  return r.length > 0 ? r : undefined;
}

/** <root>/config;无 root 为 undefined。 */
export function rootConfigDir(): string | undefined {
  const r = drecRoot();
  return r ? join(r, "config") : undefined;
}

/** <root>/config/hub-config.json(多节点编排「实际生效」配置;复制自 .example 后改);无 root 为 undefined。 */
export function rootHubConfig(): string | undefined {
  const d = rootConfigDir();
  return d ? join(d, "hub-config.json") : undefined;
}

/**
 * 数据根初始化时**复制一份多节点编排配置模板**到 `<root>/config/hub-config.example.json`。
 * 内容逐字来自仓库源文件 `configs/hub-config.example.json`(见 `hubConfigExampleText`,bundle 内联 / dev 读源文件)。
 * 幂等:无 DOUYIN_REC_ROOT 则跳过;文件已存在则不覆盖(保留用户改动)。返回写入路径,跳过/已存在返回 undefined。
 * 模板是占位值(dataRoot=/data、host=CHANGE-ME、uploadMode=stage-only)——复制后按环境改;字段说明见 docs/multi-node-sync.md「配置」。
 */
export function ensureHubConfigExample(): string | undefined {
  const cfgDir = rootConfigDir();
  if (!cfgDir) return undefined;
  const path = join(cfgDir, "hub-config.example.json");
  if (existsSync(path)) return undefined;
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path, hubConfigExampleText(), "utf-8");
  return path;
}

/** <root>/db/douyin-rec.db;无 root 为 undefined。 */
export function rootDbPath(): string | undefined {
  const r = drecRoot();
  return r ? join(r, "db", "douyin-rec.db") : undefined;
}

/** <root>/recordings;无 root 为 undefined。 */
export function rootOutputDir(): string | undefined {
  const r = drecRoot();
  return r ? join(r, "recordings") : undefined;
}

/** <root>/config/biliup/cookies.json;无 root 为 undefined。 */
export function rootBiliupCookies(): string | undefined {
  const r = drecRoot();
  return r ? join(r, "config", "biliup", "cookies.json") : undefined;
}

/**
 * 解析输出目录(录像)。**录制端(record-args)与合成端(api recordingsDir)必须用同一函数**,
 * 否则录到一处、合成去另一处找。优先级:任务 outDir > DOUYIN_REC_OUTPUT > <root>/recordings > ./recordings。
 */
export function resolveOutputDir(taskOutDir?: string | null): string {
  return taskOutDir ?? process.env.DOUYIN_REC_OUTPUT ?? rootOutputDir() ?? "./recordings";
}
