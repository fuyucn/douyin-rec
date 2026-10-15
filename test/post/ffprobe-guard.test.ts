/**
 * issue #137 返工第 2 轮:ffprobe 探测不得被异常文件拖死。
 * 用 PATH 上的**假 ffprobe 脚本**构造两种病态(不依赖真实 ffmpeg,任何环境都跑):
 *   ① 往 stderr 狂写几 MB 后正常退出(旧实现不读 stderr → 写满 64KB 管道后进程阻塞、Promise 永不返回);
 *   ② 狂写 stderr 且永不退出(要靠超时杀)。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ffprobePacketStats, runFfprobe } from "../../packages/post-process/src/ffmpeg.js";

let shimDir: string;
let oldPath: string | undefined;
const shim = (body: string): void => { writeFileSync(join(shimDir, "ffprobe"), `#!/bin/sh\n${body}\n`); chmodSync(join(shimDir, "ffprobe"), 0o755); };

beforeAll(() => {
  shimDir = mkdtempSync(join(tmpdir(), "ffprobe-shim-"));
  oldPath = process.env.PATH;
  process.env.PATH = `${shimDir}:${oldPath}`;
});
afterAll(() => { process.env.PATH = oldPath; rmSync(shimDir, { recursive: true, force: true }); });

describe.skipIf(process.platform === "win32")("runFfprobe / ffprobePacketStats:错误流消费 + 超时杀进程", () => {
  it("stderr 狂写 8MB 后退出:在时限内返回(不被管道阻塞),只保留尾部 ≤4KB,行数照实计数", async () => {
    shim(`i=0; while [ $i -lt 120000 ]; do echo "[NULL @ 0x1] missing picture in access unit with size 9801 line-$i" >&2; i=$((i+1)); done; exit 1`);
    const t0 = Date.now();
    const r = await runFfprobe(["x"], 20_000);
    expect(Date.now() - t0).toBeLessThan(15_000);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(1);
    expect(r.errTail.length).toBeLessThanOrEqual(4096);
    expect(r.errTail).toContain("line-119999");
    expect(r.errLines).toBe(120000);
  }, 30_000);

  it("stderr 狂写且永不退出:超时后被杀,timedOut=true,ffprobePacketStats 返回 undefined(无法判定)", async () => {
    shim(`while true; do echo "garbage garbage garbage garbage garbage garbage" >&2; done`);
    const t0 = Date.now();
    const r = await runFfprobe(["x"], 400);
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t0).toBeLessThan(5000);
    const t1 = Date.now();
    expect(await ffprobePacketStats("whatever", 400)).toBeUndefined();
    expect(Date.now() - t1).toBeLessThan(5000);
  }, 30_000);

  it("ffprobe 起不来(不存在的命令路径)→ 不抛、不挂:code=null", async () => {
    const old = process.env.PATH;
    process.env.PATH = "/nonexistent-dir";
    try {
      const r = await runFfprobe(["x"], 2000);
      expect(r.code).toBeNull();
    } finally { process.env.PATH = old; }
  });
});
