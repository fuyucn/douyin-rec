/**
 * paths.ts — 单一数据根(DOUYIN_REC_ROOT)+ 固定内部布局。
 *
 *   <root>/db/douyin-rec.db          数据库(含抖音账号 cookie)
 *   <root>/recordings/               录像输出
 *   <root>/stage/                    hub 合成暂存(合并/烧录中间产物)
 *   <root>/config/biliup/cookies.json  biliup B站上传 cookie
 *   <root>/config/hub.config.json    hub 全局配置;<root>/config/hub/       hub 每房间任务配置
 *
 * **root 永远有值**:未设 `DOUYIN_REC_ROOT` 时默认 `DEFAULT_ROOT`("./output-data",相对启动 cwd)——
 * 所有运行数据(db/recordings/stage/config)收进这一个目录,不再散落在项目根(旧默认各自 `./recordings`、
 * `./douyin-rec.db`、`./stage`、`./config/hub` 平铺在 cwd)。类比 docker 的 `docker-data/`(那里 root 固定
 * 由 compose 设为容器内 `/data`,不受此默认影响)。
 * 解析优先级(各处一致):专用 env(DOUYIN_REC_DB / DOUYIN_REC_OUTPUT / BILIUP_COOKIE)
 * > 由 DOUYIN_REC_ROOT(或其默认值)派生的固定子路径。专用 env 仍可单独覆盖某一项。
 */
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";

/** 未设 DOUYIN_REC_ROOT 时的默认数据根(相对启动 cwd)。db/recordings/stage/config 都收在这一个目录下。 */
export const DEFAULT_ROOT = "./output-data";

/**
 * hub 全局配置模板内容。**单一真相 = 仓库源文件 `configs/hub.config.example.json`**。
 * 打包(`pnpm bundle`)时 esbuild 经 `define` 把该文件文本内联成 `__HUB_CONFIG_EXAMPLE__`(单文件运行时无仓库目录);
 * 非打包(tsx/vitest)`__HUB_CONFIG_EXAMPLE__` 未声明 → 从仓库源文件读(相对本文件定位 repo 根)。
 */
declare const __HUB_CONFIG_EXAMPLE__: string | undefined;
function hubConfigExampleText(): string {
  if (typeof __HUB_CONFIG_EXAMPLE__ !== "undefined" && __HUB_CONFIG_EXAMPLE__) return __HUB_CONFIG_EXAMPLE__;
  return readFileSync(new URL("../../../configs/hub.config.example.json", import.meta.url), "utf-8");
}

/** 数据根:DOUYIN_REC_ROOT(去空白)未设 → 回落 {@link DEFAULT_ROOT}。永远返回有值的路径。 */
export function drecRoot(): string {
  const r = (process.env.DOUYIN_REC_ROOT ?? "").trim();
  return r.length > 0 ? r : DEFAULT_ROOT;
}

/** <root>/config。 */
export function rootConfigDir(): string {
  return join(drecRoot(), "config");
}

/**
 * <root>/config/hub.config.json(多节点编排全局「实际生效」配置;复制自 .example 后改)。
 * **兼容**:新路径不存在但旧 `hub-config.json` 在 → 返回旧路径(平滑迁移,老部署不中断)。
 */
export function rootHubConfig(): string {
  const d = rootConfigDir();
  const cur = join(d, "hub.config.json");
  const old = join(d, "hub-config.json");
  if (!existsSync(cur) && existsSync(old)) return old; // 迁移兼容:只在新文件缺失时回退旧名
  return cur;
}

/** <root>/config/hub —— 每房间 hub 任务配置文件目录(一房间一 {roomSlug}.json)。 */
export function rootHubDir(): string {
  return join(rootConfigDir(), "hub");
}

/** <root>/config/hub/{roomSlug}.json —— 单个房间的 hub 任务配置文件路径。 */
export function rootHubTaskConfig(roomSlug: string): string {
  return join(rootHubDir(), `${roomSlug}.json`);
}

/**
 * 数据根初始化时**复制一份多节点编排配置模板**到 `<root>/config/hub.config.example.json`。
 * 内容逐字来自仓库源文件 `configs/hub.config.example.json`(见 `hubConfigExampleText`,bundle 内联 / dev 读源文件)。
 * 幂等:文件已存在则不覆盖(保留用户改动)。返回写入路径,已存在返回 undefined。
 * 模板是占位值(dataRoot=/data、host=CHANGE-ME、uploadMode=stage-only)——复制后按环境改;字段说明见 docs/multi-node-sync.md「配置」。
 */
export function ensureHubConfigExample(): string | undefined {
  const cfgDir = rootConfigDir();
  const path = join(cfgDir, "hub.config.example.json");
  if (existsSync(path)) return undefined;
  mkdirSync(cfgDir, { recursive: true });
  // 顺带建 hub/ 任务目录(空也建,UI/手放任务文件即用)。
  try { mkdirSync(join(cfgDir, "hub"), { recursive: true }); } catch { /* 忽略 */ }
  writeFileSync(path, hubConfigExampleText(), "utf-8");
  return path;
}

/** <root>/db/douyin-rec.db。 */
export function rootDbPath(): string {
  return join(drecRoot(), "db", "douyin-rec.db");
}

/** <root>/recordings。 */
export function rootOutputDir(): string {
  return join(drecRoot(), "recordings");
}

/** <root>/stage —— hub 合成暂存(合并/烧录中间产物;上传后可按 cleanup 配置清理)。 */
export function rootStageDir(): string {
  return join(drecRoot(), "stage");
}

/** <root>/config/biliup/cookies.json。 */
export function rootBiliupCookies(): string {
  return join(drecRoot(), "config", "biliup", "cookies.json");
}

/**
 * 解析输出目录(录像)。**录制端(record-args)与合成端(api recordingsDir)必须用同一函数**,
 * 否则录到一处、合成去另一处找。优先级:任务 outDir > DOUYIN_REC_OUTPUT > <root>/recordings。
 */
export function resolveOutputDir(taskOutDir?: string | null): string {
  return taskOutDir ?? process.env.DOUYIN_REC_OUTPUT ?? rootOutputDir();
}
