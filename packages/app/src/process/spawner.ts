/**
 * app/process/spawner.ts — Task → real RecorderProcess factory.
 *
 * This is the ONLY file that knows how to turn a Task into a concrete OS
 * subprocess: it picks the executable (process.execPath = the running node),
 * the cli entry (process.argv[1] = the bundle path, e.g. dist/douyin-rec.mjs),
 * the `record` argv (buildRecordArgs), and any GLOBAL flags (--discord-webhook).
 *
 * The TaskManager depends on the Spawner *interface* only, so tests inject a
 * MockSpawner and never spawn a real child.
 */
import { buildRecordArgs } from "./record-args.js";
import {
  ChildRecorderProcess,
  type RecorderProcess,
} from "./recorder-process.js";
import type { Task } from "../store.js";

/** Factory seam: Task → RecorderProcess. Mockable in tests. */
export interface Spawner {
  spawn(task: Task): RecorderProcess;
}

/**
 * 解析子进程实际推送的 Discord webhook：**任务级优先，回落全局**。
 * `global` 可为定值或 getter（getter → 每次 spawn 求值，从而带上 settings 表的 `discordWebhook`）。
 * 子进程是独立 `record` 进程、无 DB 访问，只能靠 `--discord-webhook` 透传，故这里是 webhook 进子进程的唯一关口。
 * 纯函数、导出供测试（曾因 spawner 只读 env/program、漏掉 UI 设的 settings webhook 而整场无 Discord）。
 */
export function resolveSpawnWebhook(
  taskWebhook: string | null | undefined,
  global: string | (() => string | undefined) | undefined,
): string | undefined {
  const g = typeof global === "function" ? global() : global;
  return (taskWebhook ?? "").trim() || (g ?? "").trim() || undefined;
}

export interface NodeRecordSpawnerOpts {
  /**
   * Path to the cli entry to run with node. Defaults to process.argv[1]
   * (the running bundle). Overridable for tests / alternate entry points.
   */
  cliEntry?: string;
  /** Executable. Defaults to process.execPath (the running node). */
  command?: string;
  /** Working directory for children. */
  cwd?: string;
  /**
   * 全局 Discord webhook（任务未自带 webhook 时回落）→ GLOBAL flag before `record`。
   * 可传字符串（启动时定值）或 **getter**（每次 spawn 时读取，与 `mesioPath` 同模式）。用 getter
   * 才能把 **settings 表的 `discordWebhook`**（UI 设的全局 webhook）带进子进程——子进程是独立 `record`
   * 进程、无 DB 访问，只能靠这里透传 `--discord-webhook`；定值会漏掉「serve 启动后才在 UI 设 webhook」。
   */
  webhook?: string | (() => string | undefined);
  /**
   * mesio 二进制路径(app 设置 settings.mesioPath)。**每次 spawn 时读取**(getter,改设置无需重启 serve)。
   * 返回非空 → 作 `MESIO_PATH` 注入子进程环境(优先级高于继承的 env 与引擎的 bin/ 默认);
   * 空/undefined → 不注入,引擎自行 resolveMesioBin(继承 env > <cwd>/bin/mesio > PATH)。
   */
  mesioPath?: () => string | undefined;
  /** Receives child stdout/stderr lines. */
  onLog?: (msg: string) => void;
  /** ms to wait after SIGTERM before SIGKILL. */
  killTimeoutMs?: number;
}

/** Spawns `node <cliEntry> [--discord-webhook ...] record ...` per task. */
export class NodeRecordSpawner implements Spawner {
  private readonly command: string;
  private readonly cliEntry: string;
  private readonly cwd: string | undefined;
  private readonly webhook: string | (() => string | undefined) | undefined;
  private readonly mesioPath: (() => string | undefined) | undefined;
  private readonly onLog: ((msg: string) => void) | undefined;
  private readonly killTimeoutMs: number | undefined;

  constructor(opts: NodeRecordSpawnerOpts = {}) {
    this.command = opts.command ?? process.execPath;
    this.cliEntry = opts.cliEntry ?? process.argv[1];
    this.cwd = opts.cwd;
    this.webhook = opts.webhook;
    this.mesioPath = opts.mesioPath;
    this.onLog = opts.onLog;
    this.killTimeoutMs = opts.killTimeoutMs;
  }

  spawn(task: Task): RecorderProcess {
    // 每任务 webhook 优先,回落全局(getter 时每次 spawn 读取,带上 settings 表 webhook)→
    // 子进程的开播/录完通知推到该 webhook。
    const hook = resolveSpawnWebhook(task.webhook, this.webhook);
    const globals = hook ? ["--discord-webhook", hook] : [];
    const args = [this.cliEntry, ...globals, ...buildRecordArgs(task)];
    // mesio 路径设置(若配置)→ 注入 MESIO_PATH;否则继承父 env(引擎自行兜底 bin/mesio)。
    const mesio = this.mesioPath?.()?.trim();
    const env = mesio ? { ...process.env, MESIO_PATH: mesio } : undefined;
    return new ChildRecorderProcess({
      taskId: task.id,
      command: this.command,
      args,
      cwd: this.cwd,
      env,
      onLog: this.onLog,
      killTimeoutMs: this.killTimeoutMs,
    });
  }
}
