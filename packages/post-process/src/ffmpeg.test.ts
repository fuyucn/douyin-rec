// ts/test/post/ffmpeg.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parseProgressBlock, makeCpuProbe, runFfmpeg } from "./ffmpeg.js";

describe("ffmpeg progress 解析", () => {
  it("out_time_ms 微秒→毫秒，算 pct", () => {
    const p = parseProgressBlock(
      { out_time_ms: "5000000", total_size: "1048576", speed: "2.5x", bitrate: "1200.0kbits/s" },
      10_000,  // total_ms
    );
    expect(p.outTimeMs).toBe(5000);      // 5_000_000 微秒 / 1000
    expect(p.pct).toBe(50);
    expect(p.speed).toBe(2.5);
    expect(p.bitrateKbps).toBe(1200);
    expect(p.outSize).toBe(1048576);
  });
  it("pct 上限 99，0 输入安全", () => {
    expect(parseProgressBlock({ out_time_ms: "0" }, 10_000).pct).toBe(0);
    expect(parseProgressBlock({ out_time_ms: "999999999" }, 1000).pct).toBe(99);
  });
});

/**
 * CPU 时间探针:修「faststart 收尾静默被看门狗误杀」的判活依据。
 * 真实复现(线上 3.1GB 段):该收尾一遍 stdout/stderr 静默 120s+、输出文件也可静默 117s,
 * 但进程 CPU 时间**从不静默**(实测最大静默 0s)。
 */
describe("makeCpuProbe(CPU 时间存活信号)", () => {
  // /proc/<pid>/stat 的第 14/15 字段是 utime/stime(comm+state 之后按 1-based 数)。
  const line = (u: number, s: number): string =>
    `1234 (ffmpeg) S 1 1234 1234 0 -1 4194560 0 0 0 0 ${u} ${s} 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0`;

  it("CPU 时间前进 → true(视为存活)", () => {
    let cur = line(10, 5);
    const probe = makeCpuProbe(1, () => cur);
    expect(probe()).toBe(true);
    cur = line(11, 5);
    expect(probe()).toBe(true);
    cur = line(11, 6);
    expect(probe()).toBe(true);
  });

  it("CPU 时间不变 → false(真挂住仍能被杀)", () => {
    const probe = makeCpuProbe(1, () => line(10, 5));
    expect(probe()).toBe(true);
    expect(probe()).toBe(false);
    expect(probe()).toBe(false);
  });

  it("读不到 /proc(进程已退/非 Linux)→ false,绝不把「读不到」当存活", () => {
    expect(makeCpuProbe(1, () => null)()).toBe(false);
    expect(makeCpuProbe(1, () => "garbage")()).toBe(false);
  });

  it("comm 含空格/括号也不影响字段定位", () => {
    const weird = "7 (ffm peg) R 1 7 7 0 -1 0 0 0 0 0 42 8 0 0 20 0 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0";
    let cur = weird;
    const probe = makeCpuProbe(7, () => cur);
    expect(probe()).toBe(true);
    cur = weird.replace(" 42 8 ", " 43 8 ");
    expect(probe()).toBe(true);
  });
});

/**
 * 端到端行为(需真实 ffmpeg;本机 ffmpeg 坏则跳过,CI/容器里覆盖):
 *   ① 「stdout/stderr 静默但进程在烧 CPU」→ **不被杀**(CPU 探针生效,修 faststart 误杀);
 *   ② 「真挂住(CPU 不动、也不输出)」→ **仍被杀**;
 *   ③ 「只有 CPU 转、长时间无任何输出」→ **仍被杀**(忙等型卡死的硬上限)。
 *
 * ⚠️ 看门狗默认每 15s 才检查一次,短进程(几秒)会在第一次检查前就结束 → 用例会假绿。
 * 故这里注入 `watchIntervalMs: 100` 强制检查,并把 stallMs 设成 300ms 量级。
 */
describe("runFfmpeg 看门狗 + CPU 探针(端到端)", () => {
  const dir = mkdtempSync(join(tmpdir(), "stall-"));
  const hasFfmpeg = (() => {
    try { return spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0; } catch { return false; }
  })();
  const FAST = { watchIntervalMs: 100 };

  it.skipIf(!hasFfmpeg)("静默但烧 CPU → 不被杀(CPU 探针生效)", async () => {
    const out = join(dir, "cpu.mp4");
    // -re 让进程跑 ~3s;`-v quiet` 全程无输出;stallMs=300 远小于它 → 只看 stdout/stderr 必被杀。
    const args = ["-y", "-v", "quiet", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
                  "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", out];
    // stallMs 取 3s:远大于 ffmpeg 在 -re 下的单次 CPU 停歇(~600ms),又远小于 8s 总时长。
    await expect(runFfmpeg(args, { stallMs: 3_000, ...FAST })).resolves.toBeUndefined();
  }, 60_000);

  it.skipIf(!hasFfmpeg)("真挂住(不烧 CPU、不输出)→ 仍被杀,且错误是「卡死」", async () => {
    // 读 FIFO 且写端不关闭:ffmpeg 阻塞在 open/read,CPU 不动、无输出 → 必须被杀。
    const fifo = join(dir, "hang.fifo");
    spawnSync("mkfifo", [fifo]);
    const args = ["-y", "-v", "quiet", "-i", fifo, "-c", "copy", join(dir, "hang.mp4")];
    await expect(runFfmpeg(args, { stallMs: 300, ...FAST })).rejects.toThrow(/卡死/);
  }, 60_000);

  it.skipIf(!hasFfmpeg)("只有 CPU 转、长时间无任何输出 → 仍被杀(忙等硬上限)", async () => {
    // -re 的 3s 素材 + cpuOnlyStallMs=500:进程在烧 CPU、无输出,超过 500ms 即判忙等卡死。
    const out = join(dir, "busy.mp4");
    const args = ["-y", "-v", "quiet", "-re", "-f", "lavfi", "-i", "testsrc2=size=320x240:rate=10",
                  "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", out];
    await expect(runFfmpeg(args, { stallMs: 60_000, cpuOnlyStallMs: 2_000, ...FAST })).rejects.toThrow(/卡死/);
  }, 60_000);
});

