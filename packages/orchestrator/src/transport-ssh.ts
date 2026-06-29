// packages/orchestrator/src/transport-ssh.ts
import { spawn } from "node:child_process";
import type { Transport, NodeInventory, NodeRecording } from "./transport.js";

export interface SshOpts {
  id: string; host: string; dataRoot: string;
  run?: (argv: string[]) => Promise<string>;   // 默认 ssh host -- <argv>
  rsync?: (remote: string, localDir: string) => Promise<void>;
  /**
   * 覆盖 slave 端调用的 node 前缀（默认 `node <dataRoot>/dist/douyin-rec.mjs`）。
   * 主要用于测试（注入 fake run 时此字段无实际影响）或 slave 部署路径非标准时的覆盖。
   */
  remoteNode?: string;
}

// SSH 心跳 + 免交互:ServerAlive 5s×3≈15s 检测死连接自动断(tailscale 偶发 stall 不再永久挂);
// BatchMode 杜绝 auth 提示挂起。defaultRun 另加硬超时(到点 SIGKILL),双保险防 hung ssh 锁死 reconciler。
const SSH_KEEPALIVE = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"];

function defaultRun(host: string, timeoutMs = 45_000) {
  return (argv: string[]): Promise<string> => new Promise((resolve, reject) => {
    const p = spawn("ssh", ["-o", "ConnectTimeout=10", ...SSH_KEEPALIVE, host, "--", ...argv]);
    let out = "", err = "", settled = false;
    const finish = (fn: () => void): void => { if (settled) return; settled = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => {
      try { p.kill("SIGKILL"); } catch { /* already gone */ }
      finish(() => reject(new Error(`ssh 超时 ${timeoutMs}ms 被杀: ${host} -- ${argv.join(" ").slice(0, 60)}`)));
    }, timeoutMs);
    p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (err += b));
    p.on("close", (c) => finish(() => (c === 0 ? resolve(out) : reject(new Error(`ssh rc=${c}: ${err.slice(-300)}`)))));
    p.on("error", (e) => finish(() => reject(e)));
  });
}

export class SshTransport implements Transport {
  readonly id: string;
  private run: (argv: string[]) => Promise<string>;
  private rsync: (remote: string, localDir: string) => Promise<void>;
  constructor(private o: SshOpts) {
    this.id = o.id;
    this.run = o.run ?? defaultRun(o.host);
    this.rsync = o.rsync ?? ((remote, localDir) => new Promise((res, rej) => {
      // 心跳同 ssh:大文件传输慢但死连接 ~15s 即断,不无限挂。
      const p = spawn("rsync", ["-az", "-e",
        "ssh -o StrictHostKeyChecking=no -o ServerAliveInterval=5 -o ServerAliveCountMax=3",
        `${o.host}:${remote}`, localDir]);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error(`rsync rc=${c}`)))); p.on("error", rej);
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
    return { tenantId: this.id, recordings: parsed.recordings };
  }
  async isDone(roomSlug: string): Promise<boolean> {
    // 同 listInventory:命令作单个字符串传(远端 shell 执行,glob/管道生效),不包 bash -lc。
    const out = await this.run([
      `cat /proc/[0-9]*/comm 2>/dev/null | grep -ic ffmpeg || true`]);
    const n = parseInt(out.trim(), 10);
    // 未知/乱码输出 → 视为未收播(安全默认：编排器等待而非提前同步)
    if (isNaN(n)) return false;
    return n === 0; // 0 ffmpeg 进程 = 已收播
  }
  async pull(remotePaths: string[], localDir: string): Promise<void> {
    for (const rp of remotePaths) await this.rsync(rp, localDir);
  }
}
