import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRecordSpawner, ROLLING_STOP_GRACE_MS, resolveKillTimeoutMs } from "../../packages/app/src/process/spawner.js";
import type { Task } from "../../packages/app/src/store.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mkTask(rollingEffective: boolean): Task {
  return {
    id: 9, room: "1", name: "a", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
    cookies: "", outDir: null, scheduleStart: null, scheduleEnd: null, status: "stopped",
    useCookie: false, rollingUpload: false, rollingEffective, createdAt: "2026-06-12T00:00:00.000Z",
  };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) { if (Date.now() - t0 > ms) throw new Error("waitFor timeout"); await wait(25); }
}

/**
 * 假 cli:同进程组里挂一个「上传中的 biliup」孙进程(sleep);收到 SIGTERM 后忙 300ms(模拟封口+上传末段),
 * 再把孙进程是否还活着写进 marker 并退出。SIGTERM 若打整个进程组,孙进程会先死 → marker=dead。
 */
function fakeCli(dir: string): { entry: string; up: string; marker: string } {
  const entry = join(dir, "cli.mjs");
  const up = join(dir, "up");
  const marker = join(dir, "marker");
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const gc = spawn("sleep", ["30"], { stdio: "ignore" });
process.on("SIGTERM", () => setTimeout(() => {
  let alive = true;
  try { process.kill(gc.pid, 0); } catch { alive = false; }
  writeFileSync(${JSON.stringify(marker)}, alive ? "alive" : "dead");
  try { gc.kill("SIGKILL"); } catch {}
  process.exit(0);
}, 300));
setInterval(() => {}, 1e9);
writeFileSync(${JSON.stringify(up)}, "1");
`);
  return { entry, up, marker };
}

async function stopAndReadMarker(rolling: boolean): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "drec-grace-"));
  try {
    const { entry, up, marker } = fakeCli(dir);
    const proc = new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask(rolling));
    proc.start();
    await waitFor(() => existsSync(up));
    await wait(100); // 孙进程已起
    await proc.stop();
    return existsSync(marker) ? readFileSync(marker, "utf-8") : "none";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("边录边传任务硬停", () => {
  it("宽限常量足够传一段(≥ 5 分钟)", () => {
    expect(ROLLING_STOP_GRACE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("resolveKillTimeoutMs:rolling 用长宽限;非 rolling / 未设 → undefined(进程默认);显式值最优先", () => {
    expect(resolveKillTimeoutMs({ rollingEffective: true }, undefined, 777)).toBe(777);
    expect(resolveKillTimeoutMs({ rollingEffective: false }, undefined, 777)).toBeUndefined();
    expect(resolveKillTimeoutMs({}, undefined, 777)).toBeUndefined();
    expect(resolveKillTimeoutMs({ rollingEffective: true }, 50, 777)).toBe(50);
  });

  it("spawner 给 rolling 任务的进程配长宽限 + 只 TERM 子进程;非 rolling 仍默认 10s + TERM 整组", () => {
    const sp = new NodeRecordSpawner({ cliEntry: "/nonexistent/cli.mjs" });
    const r = sp.spawn(mkTask(true));
    expect(r.killTimeoutMs).toBe(ROLLING_STOP_GRACE_MS);
    expect(r.termChildOnly).toBe(true);
    const n = sp.spawn(mkTask(false));
    expect(n.killTimeoutMs).toBe(10_000);
    expect(n.termChildOnly).toBe(false);
  });

  it("rolling:硬停只 TERM 子进程 → 同组的上传子进程在收尾时仍活着(不被连坐)", async () => {
    expect(await stopAndReadMarker(true)).toBe("alive");
  });

  it("非 rolling:行为不变,TERM 整个进程组(孙进程先死)", async () => {
    expect(await stopAndReadMarker(false)).toBe("dead");
  });
});
