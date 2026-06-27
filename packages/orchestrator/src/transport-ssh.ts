// packages/orchestrator/src/transport-ssh.ts
import { spawn } from "node:child_process";
import type { Transport, NodeInventory, NodeRecording } from "./transport.js";

export interface SshOpts {
  id: string; host: string; dataRoot: string;
  run?: (argv: string[]) => Promise<string>;   // 默认 ssh host -- <argv>
  rsync?: (remote: string, localDir: string) => Promise<void>;
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

// 远端清单脚本：对 <dataRoot>/recordings 下每会话求时长/起止/缺口，输出一行 JSON。
// v1 stub：实际远端扫描逻辑待后续落地——两种方案选一：
//   (a) 把独立 inventory.mjs 随 orchestrator 分发，scp 到 slave 后 `node inventory.mjs <dataRoot>` 输出 JSON；
//   (b) 给 slave serve 加 GET /api/recordings（spec D1，干净方案）。
// 本任务测试已用注入 run 与具体脚本解耦，脚本内容不阻塞其余任务。
const INVENTORY_SH = (dataRoot: string) => `node - <<'NODE'
// 远端需有 node;实际实现里把扫描逻辑做成随包分发的小脚本或 slave 的 /api/recordings。
NODE`;

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
    const out = await this.run(["bash", "-lc", INVENTORY_SH(this.o.dataRoot)]);
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
