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
import { writeCredentialFile } from "./credential-file.js";
import {
  ChildRecorderProcess,
  type RecorderProcess,
} from "./recorder-process.js";
import type { Task } from "../store.js";
import { WEBHOOK_TOGGLES_ENV, type NotifWebhookToggles } from "@drec/observability";

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
  /**
   * 抖音 API 模式(app 设置 settings.douyinApiMode)。**每次 spawn 时读取**(getter,改设置无需重启)。
   * 返回非空 → 作 `DOUYIN_REC_API_MODE` 注入子进程环境,douyin-live 读取它决定用哪个端点取流/解析 liveId。
   * 空/undefined → 不注入,子进程用默认(balance)。
   */
  douyinApiMode?: () => string | undefined;
  /**
   * 每类提醒的 webhook 开关(getter,每次 spawn 时读取 settings 表)。经
   * `DREC_WEBHOOK_TOGGLES` 环境变量注入子进程,子进程发 Discord 前按类型过滤。
   * 省略=不注入,子进程全开(向后兼容)。
   */
  webhookToggles?: () => NotifWebhookToggles;
  /** Receives child stdout/stderr lines. */
  onLog?: (msg: string) => void;
  /** ms to wait after SIGTERM before SIGKILL. */
  killTimeoutMs?: number;
  /**
   * 开了边录边传的任务,硬停(SIGTERM)后到 SIGKILL 的宽限。默认 {@link ROLLING_STOP_GRACE_MS}。
   * 会话 stop() 会「封口→上传末段」,上传常超过普通 10 秒宽限;被 SIGKILL 会留下「上传中」意图,
   * 10 分钟后 master 转 needs_manual(源保留,安全但要人工)。
   */
  rollingKillTimeoutMs?: number;
}

/** 边录边传任务硬停时留给「末段封口+上传」的最长时间;超时仍 SIGKILL(源保留,转人工)。 */
export const ROLLING_STOP_GRACE_MS = 10 * 60_000;

/**
 * 一个任务硬停的 SIGKILL 宽限。显式配置优先(测试/运维覆盖);否则开了边录边传的任务用更长宽限,
 * 其余返回 undefined(进程默认 10s)。
 */
export function resolveKillTimeoutMs(
  task: Pick<Task, "rollingEffective">,
  explicitMs: number | undefined,
  rollingMs: number,
): number | undefined {
  return explicitMs ?? (task.rollingEffective ? rollingMs : undefined);
}

/** Spawns `node <cliEntry> [--discord-webhook ...] record ...` per task. */
export class NodeRecordSpawner implements Spawner {
  private readonly command: string;
  private readonly cliEntry: string;
  private readonly cwd: string | undefined;
  private readonly webhook: string | (() => string | undefined) | undefined;
  private readonly mesioPath: (() => string | undefined) | undefined;
  private readonly douyinApiMode: (() => string | undefined) | undefined;
  private readonly webhookToggles: (() => NotifWebhookToggles) | undefined;
  private readonly onLog: ((msg: string) => void) | undefined;
  private readonly killTimeoutMs: number | undefined;
  private readonly rollingKillTimeoutMs: number;

  constructor(opts: NodeRecordSpawnerOpts = {}) {
    this.command = opts.command ?? process.execPath;
    this.cliEntry = opts.cliEntry ?? process.argv[1];
    this.cwd = opts.cwd;
    this.webhook = opts.webhook;
    this.mesioPath = opts.mesioPath;
    this.douyinApiMode = opts.douyinApiMode;
    this.webhookToggles = opts.webhookToggles;
    this.onLog = opts.onLog;
    this.killTimeoutMs = opts.killTimeoutMs;
    this.rollingKillTimeoutMs = opts.rollingKillTimeoutMs ?? ROLLING_STOP_GRACE_MS;
  }

  spawn(task: Task): RecorderProcess {
    // 每任务 webhook 优先,回落全局(getter 时每次 spawn 读取,带上 settings 表 webhook)→
    // 子进程的开播/录完通知推到该 webhook。
    const hook = resolveSpawnWebhook(task.webhook, this.webhook);
    const globals = hook ? ["--discord-webhook", hook] : [];
    // 登录凭证写 0600 文件、argv 只带路径;写失败直接抛(不回退 argv)。
    // task.cookies 为空(useCookie=false / 未配置)→ 不生成文件。
    const credFile = task.cookies ? writeCredentialFile(task.id, task.cookies) : undefined;
    const args = [this.cliEntry, ...globals, ...buildRecordArgs(task, credFile)];
    // mesio 路径设置(若配置)→ 注入 MESIO_PATH;否则继承父 env(引擎自行兜底 bin/mesio)。
    const mesio = this.mesioPath?.()?.trim();
    // 抖音 API 模式设置(若配置)→ 注入 DOUYIN_REC_API_MODE;否则继承父 env(douyin-live 用默认 balance)。
    const apiMode = this.douyinApiMode?.()?.trim();
    const toggles = this.webhookToggles?.();
    const env =
      mesio || apiMode || toggles
        ? {
            ...process.env,
            ...(mesio ? { MESIO_PATH: mesio } : {}),
            ...(apiMode ? { DOUYIN_REC_API_MODE: apiMode } : {}),
            ...(toggles ? { [WEBHOOK_TOGGLES_ENV]: JSON.stringify(toggles) } : {}),
          }
        : undefined;
    return new ChildRecorderProcess({
      taskId: task.id,
      command: this.command,
      args,
      cwd: this.cwd,
      env,
      onLog: this.onLog,
      killTimeoutMs: resolveKillTimeoutMs(task, this.killTimeoutMs, this.rollingKillTimeoutMs),
      cleanupFiles: credFile ? [credFile] : undefined,
    });
  }
}
