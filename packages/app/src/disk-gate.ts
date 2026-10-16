/**
 * app/disk-gate.ts — 「新一场开播」的磁盘水位准入(issue #96,plans/033 W1-3a)。
 *
 * 背景:daemon 的低水位闸门只拦「启动任务」列表;常驻任务的录制子进程自己轮询开播并直接起录制,
 * 下一场开播不过闸门,手动启动接口也绕过 —— 水位低于阈值后仍会开新一场,直至写满盘(0 字节分段、
 * 上传失败的直接通路)。本模块给两个入口(录制子进程、手动启动)提供同一个判定。
 *
 * 语义(I2):只拦「新一场开播」,不删任何文件、不打断正在进行的录制;同场断流重连由会话层放行。
 * 口径与 daemon 一致:阈值取 hub.config `resources.diskMinGB`(缺省 10GB,0 = 关闭),查不到剩余空间 → 放行。
 * **每次判定都现读配置**:常驻进程不会因为启动时固定了阈值而吃不到配置热改。
 */
import { existsSync, readFileSync, statfsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { shouldRefuseNewRecording, type AdmitDecision } from "@drec/core";
import { resolveDiskWatermark } from "./daemon.js";
import { rootHubConfig } from "./paths.js";

/**
 * 录制子进程 / 手动启动共用的 hub 配置**内容**:与 daemon 走同一口径。
 *
 * serve 在启动时把「当前生效的那份」配置交给子进程(见 serve.ts 的环境变量注入):
 *   - 来源是文件(arg-file / root-file)→ 传路径,子进程每次现读(可热改);
 *   - 来源是 inline / settings → 传 JSON 内容(无法传路径)。
 * 两者都没有 → undefined → 与 daemon 一样回落默认水位。
 *
 * 返回值 = 配置 JSON 串(或 undefined);`path` 仅文件来源才有。
 */
export function effectiveHubConfig(): { json: string | undefined; path: string } {
  const envPath = process.env.DOUYIN_REC_HUB_CONFIG?.trim();
  const envJson = process.env.DOUYIN_REC_HUB_CONFIG_JSON;
  if (envPath) return { json: undefined, path: envPath };
  if (envJson !== undefined && envJson.trim() !== "") return { json: envJson, path: "" };
  return { json: undefined, path: rootHubConfig() };
}

/** 兼容旧调用点:只要「路径」(文件来源);非文件来源返回数据根下的默认文件路径。 */
export function effectiveHubConfigPath(): string {
  const { path, json } = effectiveHubConfig();
  return path || (json === undefined ? rootHubConfig() : "");
}

export interface NewBroadcastGateOpts {
  /** 任务自己的输出目录(录像最终落在其下的子目录);测它所在的卷,而不是默认输出目录所在卷。 */
  outDir: string;
  /** hub 配置文件路径(现读;读不到 → 回落默认水位)。非文件来源(inline/settings)时可为空串。 */
  hubConfigPath: string;
  /** 直接给出的配置 JSON(inline/settings 来源);优先于 hubConfigPath。 */
  hubConfigJson?: string;
  /** 注入:读配置文本(测试用)。缺省读 hubConfigPath。 */
  readConfig?: (path: string) => string | undefined;
  /** 注入:取目录所在卷的剩余字节(测试用)。返回 null = 查不到 → 放行。 */
  freeBytes?: (dir: string) => number | null;
  /** 注入:告警输出(阈值异常等)。 */
  warn?: (msg: string) => void;
}

/** 最近的、已存在的祖先目录(输出目录可能尚未创建;statfs 要落在真实存在的路径上)。 */
function nearestExisting(dir: string): string {
  let p = resolve(dir);
  while (!existsSync(p)) {
    const up = dirname(p);
    if (up === p) break;
    p = up;
  }
  return p;
}

/** 目录所在卷的剩余字节;失败 → null(调用方放行,磁盘看门狗告警兜底)。 */
export function volumeFreeBytes(dir: string): number | null {
  try {
    const st = statfsSync(nearestExisting(dir));
    return Number(st.bavail) * Number(st.bsize);
  } catch {
    return null;
  }
}

function defaultReadConfig(path: string): string | undefined {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
}

/**
 * 手动启动(Web/API)用的准入:测**任务自己的输出目录**(缺省回落默认输出目录),
 * 水位读 {@link effectiveHubConfigPath}——与录制子进程同一份配置、同一目录口径。
 */
export function makeManualStartAdmit(
  resolveOut: (taskOutDir?: string | null) => string,
  over: Partial<NewBroadcastGateOpts> = {},
): (taskOutDir?: string | null) => AdmitDecision {
  const eff = effectiveHubConfig();
  return (taskOutDir) => checkNewBroadcastAdmission({
    outDir: resolveOut(taskOutDir),
    hubConfigPath: eff.path,
    hubConfigJson: eff.json,
    ...over,
  });
}

/** 判定:剩余低于水位 → `{ok:false, reason}`;其余(含查不到、阈值关闭)→ `{ok:true}`。 */
export function checkNewBroadcastAdmission(o: NewBroadcastGateOpts): AdmitDecision {
  const read = o.readConfig ?? defaultReadConfig;
  // 来源优先:直接给的 JSON(inline/settings)> 文件路径。二者口径与 daemon 的 resolveDiskWatermark 一致。
  const raw = o.hubConfigJson !== undefined ? o.hubConfigJson : read(o.hubConfigPath);
  const { bytes: watermark } = resolveDiskWatermark(raw, o.warn);
  if (!(watermark > 0)) return { ok: true };
  const free = (o.freeBytes ?? volumeFreeBytes)(o.outDir);
  if (free == null) return { ok: true };
  if (!shouldRefuseNewRecording(free, watermark)) return { ok: true };
  return {
    ok: false,
    reason: `任务输出目录所在磁盘剩余 ${(free / 1e9).toFixed(1)}GB,低于水位 ${(watermark / 1e9).toFixed(1)}GB`,
    // 去重键只含水位(配置值),不含实时剩余空间:剩余每变化 0.1GB 不应被当成新原因而重复告警。
    key: `disk-below-watermark:${(watermark / 1e9).toFixed(1)}`,
  };
}

/** 现读当前生效 hub 配置的磁盘水位(GB;0 = 关闭)。与 daemon / 录制子进程同源;供处理任务表准入。 */
export function currentDiskMinGB(warn?: (msg: string) => void): number {
  const eff = effectiveHubConfig();
  const raw = eff.json !== undefined ? eff.json : defaultReadConfig(eff.path);
  return resolveDiskWatermark(raw, warn).bytes / 1e9;
}

/** 构造闸门函数(每次调用现读配置与剩余空间)。 */
export function makeNewBroadcastGate(o: NewBroadcastGateOpts): () => AdmitDecision {
  return () => checkNewBroadcastAdmission(o);
}
