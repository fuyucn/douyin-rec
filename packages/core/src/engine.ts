/**
 * core/engine.ts — 下载引擎(DownloadEngine)接口 + 注册表。
 *
 * 「下载这一步」的可插拔策略:把流 URL 落盘成分段文件,以及它各自的进度上报机制
 * (ffmpeg=stderr `time=` / mesio=输出文件增长)。通用录制器(@drec/record-engine 的
 * PollingRecorder)持有一个 DownloadEngine,生命周期编排(开播轮询 / 断流判别 / drain /
 * 卡死看门狗)平台与引擎无关;引擎只管 spawn 一个下载子进程并把分段/进度/stderr 喂回。
 *
 * 取代了原「按名查 recorder provider」注册表(每平台 × ffmpeg/mesio 4 个近乎相同的录制器包):
 * 现在录制器只剩一个通用类,可换引擎(ffmpeg/mesio),平台经 Platform.engines 暴露可用引擎 id。
 *
 * 本模块只依赖 node 类型,无重依赖;具体引擎实现(ffmpeg/mesio)放 @drec/record-engine,
 * 注册放 CLI 入口(providers-register,副作用)。
 */
import type { ChildProcess } from "node:child_process";

/** 引擎 spawn 入参(由通用录制器组装)。 */
export interface EngineSpawnArgs {
  /** 可录制流 URL(平台 getStream 返回)。 */
  url: string;
  /** 拉流所需 HTTP 头(平台专属,如 bilibili CDN 要 Referer/UA);引擎透传给下载进程。 */
  headers?: Record<string, string>;
  /** 输出目录(已 mkdir,典型 {outDir}/{安全主播名})。 */
  dir: string;
  /** 文件名基(不含后缀/段号),典型 `${安全名}_${stamp}`;引擎据此拼分段/单文件模板。 */
  nameBase: string;
  /** 分段时长(秒);0=不分段。 */
  segSec: number;
  /** 新分段写入时回调(路径)。 */
  onSegment(path: string): void;
  /** 录制有前进时调用(喂卡死看门狗健康时刻)。 */
  markProgress(): void;
  /** 下载进程的 stderr 行(断链诊断;录制器收集尾部)。 */
  pushStderr(line: string): void;
}

/** 引擎 spawn 返回:子进程 + 会话首段路径(给 session 推导 xml base)+ 可选清理(进程退出后调用)。 */
export interface EngineSpawnResult {
  proc: ChildProcess;
  /** 会话首段文件路径(session 据此推导 {base}.xml)。 */
  sessionFirstPath: string;
  /** 进程退出后清理(如清掉文件增长看门狗的 setInterval);无则省略。 */
  cleanup?: () => void;
}

/** 一个下载引擎策略(ffmpeg / mesio)。 */
export interface DownloadEngine {
  /** 引擎 id,如 "ffmpeg" | "mesio"(= Platform.engines 里的值 / task.engine)。 */
  id: string;
  spawn(a: EngineSpawnArgs): EngineSpawnResult;
  /**
   * **可运行性自检**(可选)。返回 null = 可用;返回字符串 = 不可用原因。
   *
   * 为什么必须有:`mesio` 是外部二进制,可能「文件存在且可执行」但**跑不起来**
   * (实测:VPS 上的 mesio 需要 GLIBC 2.38/2.39,而 Ubuntu 22.04 只有 2.35 →
   * 每次 spawn 立即退出 code=1 → 会话判定「短命录制」→ 退避重连 → **看起来在录,
   * 实际一个字节没落盘**,而且连续失败会把退避拉到 300s,用户很久才发现)。
   * 有了自检,可以在**选引擎时**就发现不可用并回落到 ffmpeg,而不是让录制反复失败。
   *
   * 实现要求:**必须快**(启动前调用,不能拖慢起播)——建议 `--version` + 短超时。
   * 不实现 = 视为可用(向后兼容既有引擎)。
   */
  probe?(): string | null;
}

const engines = new Map<string, DownloadEngine>();

export function registerEngine(e: DownloadEngine): void {
  engines.set(e.id, e);
}

export function getEngine(id: string): DownloadEngine | undefined {
  return engines.get(id);
}

export function listEngines(): DownloadEngine[] {
  return [...engines.values()];
}

/** 已注册的引擎 id(校验 / 列举用)。 */
export function engineNames(): string[] {
  return [...engines.keys()];
}

/** 仅供测试:清空注册表。 */
export function _resetEngines(): void {
  engines.clear();
}
