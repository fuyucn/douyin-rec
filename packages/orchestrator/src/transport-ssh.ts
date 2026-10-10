// packages/orchestrator/src/transport-ssh.ts
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { registerChild, throwIfAborted, type RemoteTaskSpec } from "@drec/core";
import type { ActiveRecordingRoom, ApplyTasksResult, NodeInventory, NodeRecording, NodeTasks, Transport } from "./transport.js";
import type { NodeCapabilities, NodeStatus, NodePipelineResult, NodePipelineSpec } from "@drec/core";

export interface SshOpts {
  id: string; host: string; dataRoot: string;
  run?: (argv: string[]) => Promise<string>;   // 默认 ssh host -- <argv>
  rsync?: (remote: string, localDir: string) => Promise<void>;
  /**
   * 覆盖 slave 端调用的 node 前缀（默认 `node <dataRoot>/dist/douyin-rec.mjs`）。
   * 主要用于测试（注入 fake run 时此字段无实际影响）或 slave 部署路径非标准时的覆盖。
   */
  remoteNode?: string;
  /** ping() 硬超时(ms),默认 6000。测试注入小值验证超时路径。 */
  pingTimeoutMs?: number;
  /**
   * `_node-pipeline`(节点侧 remux + 上传)的硬超时(ms),默认 30 分钟。
   *
   * **必须远大于默认的 45s**:这条命令要在节点上 remux 整场录像并**上传到 B站**,
   * 单是上传 470MB 就远超 45s(实测 45s 被杀 → job 失败转人工)。
   * 它仍是**有界**的:30 分钟到点 SIGKILL,不会让 reconciler 永久挂死。
   * 与 rsync 的「静默看门狗」不同,这里用总时长上限 —— biliup 上传期间进度走 stderr,
   * 但 ssh 的 stdout/stderr 可能长时间无输出,按静默判死会误杀正常上传。
   */
  nodePipelineTimeoutMs?: number;
}

// SSH 心跳 + 免交互:ServerAlive 5s×3≈15s 检测死连接自动断(tailscale 偶发 stall 不再永久挂);
// BatchMode 杜绝 auth 提示挂起。defaultRun 另加硬超时(到点 SIGKILL),双保险防 hung ssh 锁死 reconciler。
const SSH_KEEPALIVE = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"];

/** rsync 静默看门狗:活跃传输有进度输出,连续这么久无任何输出 → 判定半挂死并强杀。
 *  (rsync 自身没有本地超时;不设的话坏连接会一直占着 pipeline 的 stream lock。) */
export const RSYNC_IDLE_TIMEOUT_MS = 300_000;

/** 保留的 rsync stderr 字节数(只留尾部,足够覆盖真正的报错)。 */
export const RSYNC_STDERR_KEEP = 2_000;

/**
 * 把 rsync stderr 尾部整理成一行可读诊断(纯函数,便于单测)。
 *
 * 背景(T-19):rsync 失败原先只报 `rc=12`,丢掉了 stderr —— 2026-10-08 vps2 缺 rsync
 * 导致每场 pull 失败却只看到退出码,排查成本极高。这里:
 *   - 丢弃 `--info=progress2` 的进度行(含 `%`/纯数字/`xfr#`)——它们是心跳噪声,不是错误;
 *   - 保留其余行(如 `rsync: command not found`、`No space left on device`、`Permission denied`);
 *   - 只取最后 3 行 + 限长,避免长输出灌进错误消息。
 */
export function summarizeRsyncStderr(raw: string): string {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    // 进度行:如 "  1,234,567  45%  1.23MB/s  0:00:12" / "xfr#3" / 纯数字统计。
    .filter((l) => !/^\s*[\d,.]+\s+\d+%/.test(l) && !/^xfr#\d/.test(l) && !/^to-chk=/.test(l));
  if (lines.length === 0) return "";
  return lines.slice(-3).join(" | ").slice(-400);
}

/** rsync 参数(纯函数,便于单测):免交互 ssh + 进度输出(给静默看门狗当心跳)。 */
export function buildRsyncArgs(host: string, remote: string, localDir: string): string[] {
  return [
    "-az", "--info=progress2",
    "-e", `ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -o BatchMode=yes -o ServerAliveInterval=5 -o ServerAliveCountMax=3`,
    `${host}:${remote}`, localDir,
  ];
}

function defaultRun(host: string, timeoutMs = 45_000) {
  return (argv: string[]): Promise<string> => new Promise((resolve, reject) => {
    const p = spawn("ssh", ["-o", "ConnectTimeout=10", ...SSH_KEEPALIVE, host, "--", ...argv]);
    registerChild(p); // 不建进程组:ssh 自己是叶子
    let out = "", err = "", settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      finish(() => reject(new Error(`ssh 超时 ${timeoutMs}ms 被杀: ${host} -- ${argv.join(" ").slice(0, 60)}`)));
    }, timeoutMs);
    p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (err += b));
    p.on("close", (c) => finish(() => {
      try { throwIfAborted(); } catch (e) { reject(e); return; }
      c === 0 ? resolve(out) : reject(new Error(`ssh rc=${c}: ${err.slice(-300)}`));
    }));
    p.on("error", (e) => finish(() => reject(e)));
  });
}

/**
 * 判断一次失败是否为「远端 bundle 还没有这个隐藏命令」(commander 的 unknown command)。
 * 只认这一明确信号才允许降级;网络/权限/超时等错误必须抛给调用方,避免把可达性故障
 * 误报成「节点不支持状态查询」。
 */
function isUnknownCommandError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return /unknown command|未知命令|commander(\.js)?:?\s*unknown/i.test(msg);
}

export class SshTransport implements Transport {
  readonly id: string;
  private run: (argv: string[]) => Promise<string>;
  private runStatus: (argv: string[]) => Promise<string>;
  private rsync: (remote: string, localDir: string) => Promise<void>;
  /** 长任务专用 run(节点侧上传),超时预算独立于默认 45s。 */
  private runLong: (argv: string[]) => Promise<string>;
  constructor(private o: SshOpts) {
    this.id = o.id;
    this.run = o.run ?? defaultRun(o.host);
    this.runStatus = o.run ?? defaultRun(o.host, 8_000);
    // 注入的 fake run(测试)沿用同一个,只有真实 ssh 才用更长的预算。
    this.runLong = o.run ?? defaultRun(o.host, o.nodePipelineTimeoutMs ?? 30 * 60_000);
    this.rsync = o.rsync ?? ((remote, localDir) => new Promise((res, rej) => {
      // 免交互(BatchMode)+ ConnectTimeout,避免 auth 提示/连不上时挂死;进度输出作为心跳。
      const p = spawn("rsync", buildRsyncArgs(o.host, remote, localDir));
      registerChild(p);
      let settled = false;
      let killed = false;
      let idleTimer: ReturnType<typeof setTimeout>;
      const bump = (): void => {
        if (settled) return; // 进程已收尾:迟到的 data 事件不得再武装看门狗(否则泄漏 timer/误标 killed)
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          killed = true;
          try { p.kill("SIGKILL"); } catch { /* already gone */ }
        }, RSYNC_IDLE_TIMEOUT_MS);
        idleTimer.unref?.();
      };
      const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(idleTimer); fn(); };
      /**
       * 收集 stderr 尾部(诊断用)。背景(T-19):rsync 失败原先只报 `rc=12`,没有 stderr ——
       * 2026-10-08 vps2 缺 rsync 导致每场 pull 失败却只看到退出码,排查成本极高。
       * 只留尾部 N 行/限长,避免长传输把整段进度输出灌进错误消息。
       */
      let stderrTail = "";
      bump();
      p.stdout?.on("data", bump);
      p.stderr?.on("data", (d: Buffer) => {
        bump();
        stderrTail = (stderrTail + d.toString()).slice(-RSYNC_STDERR_KEEP);
      });
      p.on("close", (c) => finish(() => {
        if (killed) { rej(new Error(`rsync 静默 ${Math.round(RSYNC_IDLE_TIMEOUT_MS / 1000)}s 无输出,已中止: ${o.host}:${remote}`)); return; }
        try { throwIfAborted(); } catch (e) { rej(e); return; }
        if (c === 0) { res(); return; }
        // 尾部若干行(去掉 rsync 进度行,只留有信息量的),附到错误里。
        const detail = summarizeRsyncStderr(stderrTail);
        rej(new Error(`rsync rc=${c}${detail ? `: ${detail}` : ""}(${o.host}:${remote})`));
      }));
      p.on("error", (e) => finish(() => rej(e)));
    }));
  }
  async listInventory(): Promise<NodeInventory> {
    // 调用 slave 部署的 CLI bundle：`node <dataRoot>/dist/douyin-rec.mjs _inventory <dataRoot>`
    // slave 端 _inventory 子命令扫描自身 recordings 并输出 JSON { recordings: NodeRecording[] }。
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const cmd = `${nodePrefix} _inventory ${this.o.dataRoot}`;
    // 命令作**单个字符串**传:ssh 本就经远端 shell(`$SHELL -c`)执行命令,无需再包 bash -lc。
    // 旧写法 ["bash","-lc",cmd] 经 ssh 空格 join 成 `bash -lc node /path …` → bash -c 只取 "node"
    // 当命令、其余成位置参数 → 实际只跑 `node`(无脚本)→ 空输出 → JSON.parse 抛错 → 该节点恒缺席。
    const out = await this.run([cmd]);
    const parsed = JSON.parse(out) as { recordings: NodeRecording[] };
    return { workerId: this.id, recordings: parsed.recordings };
  }

  /** 读远端任务清单(隐藏 `_tasks` 子命令;输出不含 cookies)。 */
  async listTasks(): Promise<NodeTasks> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const out = await this.run([`${nodePrefix} _tasks ${this.o.dataRoot}`]);
    const parsed = JSON.parse(out) as { tasks: NodeTasks["tasks"] };
    return { workerId: this.id, tasks: parsed.tasks };
  }

  /** 读远端稳定身份(隐藏 `_node-id` 子命令;旧 bundle 无该命令 → 返回 null,调用方回落旧行为)。 */
  async nodeId(): Promise<{ nodeId: string; hostname?: string } | null> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    try {
      const out = await this.run([`${nodePrefix} _node-id ${this.o.dataRoot}`]);
      const parsed = JSON.parse(out) as { nodeId?: string; hostname?: string };
      return parsed?.nodeId ? { nodeId: parsed.nodeId, hostname: parsed.hostname } : null;
    } catch {
      return null; // 旧 bundle(无 _node-id)/ ssh 失败 → 不阻断添加流程
    }
  }

  /** 查询 worker 当前正在录制的房间,仅做轻量 /proc 扫描,不读录像目录。 */
  async activeRecordingRooms(): Promise<ActiveRecordingRoom[]> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    try {
      const out = await this.runStatus([`${nodePrefix} _recording-status ${this.o.dataRoot}`]);
      const parsed = JSON.parse(out) as { rooms?: ActiveRecordingRoom[] };
      return Array.isArray(parsed.rooms) ? parsed.rooms : [];
    } catch (e) {
      // 只在「命令确实不存在」时降级;网络抖动/ssh 失败要让调用方看到 error(节点不可达),
      // 否则一次抖动就把该节点永久误标成「不支持状态查询」。
      if (!isUnknownCommandError(e)) throw e;
    }
    // 兼容尚未更新的 worker bundle:退回现有 _tasks + _is-done 查询(每轮 1 + N 次 ssh)。
    const taskOut = await this.runStatus([`${nodePrefix} _tasks ${this.o.dataRoot}`]);
    const parsed = JSON.parse(taskOut) as { tasks: NodeTasks["tasks"] };
    const candidates = [...new Map(
      parsed.tasks.filter((task) => task.enabled).map((task) => [
        `${task.platform}:${task.roomSlug}`,
        { platform: task.platform, roomSlug: task.roomSlug },
      ]),
    ).values()];
    const done = await Promise.all(candidates.map(async (room) => ({
      room,
      done: await this.runStatus([`${nodePrefix} _is-done ${this.o.dataRoot} '${room.roomSlug.replace(/'/g, "'\\''")}'`])
        .then((out) => out.trim().toLowerCase() !== "false")
        .catch(() => true),
    })));
    return done.filter((entry) => !entry.done).map((entry) => entry.room);
  }

  /**
   * 下发 master 期望任务(base64 防引号/换行问题;cookies 只走可信 ssh 通道)。
   * `force` 编进 payload 交给远端 `applyRemoteTasks` 跳过 T-2 安全阀 —— 必须端到端送达:
   * 只在 master 侧生效等于没做(远端节点才是拒绝删除的那个)。
   */
  async applyTasks(input: { desired: RemoteTaskSpec[]; force?: boolean }): Promise<ApplyTasksResult> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const b64 = Buffer.from(JSON.stringify(input), "utf-8").toString("base64");
    const out = await this.run([`${nodePrefix} _apply-tasks ${this.o.dataRoot} ${b64}`]);
    return JSON.parse(out) as ApplyTasksResult;
  }

  /** 远端数据根剩余空间 GB(隐藏 `_disk`;master 侧磁盘看门狗用,不依赖 worker webhook 配置)。 */
  async diskFreeGB(): Promise<number> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const out = await this.run([`${nodePrefix} _disk ${this.o.dataRoot}`]);
    const parsed = JSON.parse(out) as { freeGB?: number; error?: string };
    if (parsed.error || typeof parsed.freeGB !== "number") throw new Error(`_disk 失败: ${parsed.error ?? "无 freeGB"}`);
    return parsed.freeGB;
  }

  /**
   * 节点应用回执(T16)。**旧 bundle 没有 `_node-status` → 返回 null**(UI 显示 unknown)。
   *
   * 与 nodeCapabilities 的区别:那个「不支持就抛错」,因为能力探测是**决策依据**
   * (决定走不走节点侧上传),拿不到就必须回落。而版本回执只是**可观测性**,
   * 拿不到不该打断任何流程 —— 所以这里吞掉「未知命令」并返回 null。
   */
  async nodeStatus(): Promise<NodeStatus | null> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    try {
      const out = await this.run([`${nodePrefix} _node-status ${this.o.dataRoot}`]);
      return JSON.parse(out) as NodeStatus;
    } catch (e) {
      // 旧 bundle(unknown command)/ 节点不可达 / 输出非法 JSON → 一律 null,不抛。
      return null;
    }
  }

  /** 节点侧上传能力探测(experimental,见 plans/027)。旧 bundle 无 `_node-capabilities` → 抛错,调用方按不支持处理。 */
  async nodeCapabilities(): Promise<NodeCapabilities> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const out = await this.run([`${nodePrefix} _node-capabilities ${this.o.dataRoot}`]);
    const parsed = JSON.parse(out) as Partial<NodeCapabilities>;
    return {
      biliup: parsed.biliup === true,
      cookies: parsed.cookies === true,
      diskFreeGB: typeof parsed.diskFreeGB === "number" ? parsed.diskFreeGB : 0,
      cjkFonts: parsed.cjkFonts === true,
    };
  }

  /**
   * 在节点本地执行「remux → biliup 上传」并把 BV 回传(experimental,见 plans/027)。
   * spec 经 base64 传递(含 cookie,只走可信 ssh 通道,与 `_apply-tasks` 同一路径)。
   * 录像**不回传 master** —— 这正是省掉 rsync 的关键。
   */
  async nodePipeline(spec: NodePipelineSpec): Promise<NodePipelineResult> {
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const b64 = Buffer.from(JSON.stringify(spec), "utf-8").toString("base64");
    // 用 runLong:上传整场录像远超默认 45s 预算(见 SshOpts.nodePipelineTimeoutMs)。
    const out = await this.runLong([`${nodePrefix} _node-pipeline ${this.o.dataRoot} ${b64}`]);
    const parsed = JSON.parse(out) as Partial<NodePipelineResult>;
    return {
      ok: parsed.ok === true,
      bv: parsed.bv,
      products: parsed.products,
      error: parsed.error,
    };
  }

  async isDone(roomSlug: string): Promise<boolean> {
    // 每房间判定:远端 `_is-done <dataRoot> <roomSlug>` 只查该房间 record 进程是否还有
    // ffmpeg/mesio 孙进程。旧实现 `grep -ic ffmpeg` 是全机计数 —— 别的房间还在录会把
    // 本房间也判成未收播,settle 一直空等、hub 迟迟不建 job(实测踩过)。
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const q = roomSlug.replace(/'/g, "'\\''");
    const out = await this.run([`${nodePrefix} _is-done ${this.o.dataRoot} '${q}'`]);
    const trimmed = out.trim().toLowerCase();
    // 未知/乱码输出 → 视为未收播(安全默认：编排器等待而非提前同步)
    if (trimmed !== "true" && trimmed !== "false") return false;
    return trimmed === "true";
  }
  /** 远端:逐个 `test -e`,全在则 echo OK(命令单字符串传,同 listInventory 规避 ssh 打散)。 */
  async exists(paths: string[]): Promise<boolean> {
    if (paths.length === 0) return true;
    const test = paths.map((p) => `test -e '${p.replace(/'/g, "'\\''")}'`).join(" && ");
    try {
      const out = await this.run([`${test} && echo OK || echo MISSING`]);
      return out.trim().endsWith("OK");
    } catch {
      return false; // ssh 失败 → 当作不可用(选优会剔除;另有 reconciler failed 兜底)
    }
  }

  /** 轻量探针:远端 `test -d <dataRoot>`(不扫 recordings),硬超时默认 6s。退出非零/超时 → throw。 */
  async ping(): Promise<void> {
    const root = this.o.dataRoot.replace(/'/g, "'\\''");
    const ms = this.o.pingTimeoutMs ?? 6000;
    let timer: NodeJS.Timeout;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`ssh ping 超时 ${ms}ms: ${this.o.host}`)), ms);
    });
    // run 单字符串传(远端 shell 执行),同 listInventory 规避 ssh 打散。test -d 成功 → 退出 0 → run resolve。
    const probe = this.run([`test -d '${root}'`]).then(() => undefined);
    await Promise.race([probe, timeout]).finally(() => clearTimeout(timer));
  }

  /** 远端:rm -f 这些文件(命令单字符串传,失败吞掉)。 */
  async cleanup(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    const quoted = paths.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
    try { await this.run([`rm -f ${quoted}`]); } catch { /* 忽略 */ }
  }

  async pull(remotePaths: string[], localDir: string): Promise<void> {
    // 必须先建目标目录:否则 rsync 拉单文件到不存在的 localDir 会把它当**文件名**创建
    // → stage 路径变成文件 → 后续 merge scandir 报 ENOTDIR(ssh winner 拉流首次真跑才暴露)。
    mkdirSync(localDir, { recursive: true });
    for (const rp of remotePaths) await this.rsync(rp, localDir);
  }
}
