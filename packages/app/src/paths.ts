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
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

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

/**
 * 数据根初始化时**种一份多节点编排配置模板** `<root>/config/hub-config.example.json`。
 * 幂等:无 DOUYIN_REC_ROOT 则跳过;文件已存在则不覆盖(保留用户改动)。返回写入路径,跳过/已存在返回 undefined。
 * 模板字段以 root 填充(local tenant dataRoot / cookies / stageDir),vps tenant 与 host 为占位需手改;
 * uploadMode 默认 stage-only(保守,不自动投稿,改 auto-private 才投)。字段说明见 docs/multi-node-sync.md「配置」。
 */
export function ensureHubConfigExample(): string | undefined {
  const cfgDir = rootConfigDir();
  if (!cfgDir) return undefined;
  const root = drecRoot()!;
  const path = join(cfgDir, "hub-config.example.json");
  if (existsSync(path)) return undefined;
  const template = {
    platform: "douyin",
    tenants: [
      { id: "local", kind: "local", dataRoot: root },
      { id: "vps", kind: "tailscale-ssh", host: "CHANGE-ME.ts.net", dataRoot: "/home/ubuntu/drec" },
    ],
    cookies: join(root, "config", "biliup", "cookies.json"),
    uploadMode: "stage-only",
    uploadMeta: { tag: "直播,录像", tid: 21 },
    cleanMaxGapSec: 30,
    stageDir: join(root, "stage"),
    settleMs: 90000,
    pollMs: 3000,
    reconcileIntervalMs: 1800000,
    maxWaitSec: 600,
    settleSec: 15,
  };
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(path, JSON.stringify(template, null, 2) + "\n", "utf-8");
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
