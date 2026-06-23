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

/** DOUYIN_REC_ROOT(去空白);未设为 undefined。 */
export function drecRoot(): string | undefined {
  const r = (process.env.DOUYIN_REC_ROOT ?? "").trim();
  return r.length > 0 ? r : undefined;
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
