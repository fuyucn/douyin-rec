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

function defaultRun(host: string) {
  return (argv: string[]): Promise<string> => new Promise((resolve, reject) => {
    const p = spawn("ssh", ["-o", "ConnectTimeout=10", host, "--", ...argv]);
    let out = "", err = "";
    p.stdout.on("data", (b) => (out += b)); p.stderr.on("data", (b) => (err += b));
    p.on("close", (c) => (c === 0 ? resolve(out) : reject(new Error(`ssh rc=${c}: ${err.slice(-300)}`))));
    p.on("error", reject);
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
      const p = spawn("rsync", ["-az", "-e", "ssh -o StrictHostKeyChecking=no", `${o.host}:${remote}`, localDir]);
      p.on("close", (c) => (c === 0 ? res() : rej(new Error(`rsync rc=${c}`)))); p.on("error", rej);
    }));
  }
  async listInventory(): Promise<NodeInventory> {
    // 调用 slave 部署的 CLI bundle：`node <dataRoot>/dist/douyin-rec.mjs _inventory <dataRoot>`
    // slave 端 _inventory 子命令扫描自身 recordings 并输出 JSON { recordings: NodeRecording[] }。
    const nodePrefix = this.o.remoteNode ?? `node ${this.o.dataRoot}/dist/douyin-rec.mjs`;
    const cmd = `${nodePrefix} _inventory ${this.o.dataRoot}`;
    const out = await this.run(["bash", "-lc", cmd]);
    const parsed = JSON.parse(out) as { recordings: NodeRecording[] };
    return { tenantId: this.id, recordings: parsed.recordings };
  }
  async isDone(roomSlug: string): Promise<boolean> {
    const out = await this.run(["bash", "-lc",
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
