import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
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

/** 假 cli:收到 SIGTERM 后模拟「封口+上传末段」忙 600ms,再写 done 标记并退出;启动时写 up 标记。 */
function fakeCli(): { entry: string; up: string; done: string } {
  const dir = mkdtempSync(join(tmpdir(), "drec-grace-"));
  const entry = join(dir, "cli.mjs");
  const up = join(dir, "up");
  const done = join(dir, "done");
  writeFileSync(entry, `import { writeFileSync } from "node:fs";
process.on("SIGTERM", () => setTimeout(() => { writeFileSync(${JSON.stringify(done)}, "1"); process.exit(0); }, 600));
setInterval(() => {}, 1e9);
writeFileSync(${JSON.stringify(up)}, "1");
`);
  return { entry, up, done };
}

async function stopAfterStart(rolling: boolean): Promise<boolean> {
  const { entry, up, done } = fakeCli();
  const proc = new NodeRecordSpawner({ cliEntry: entry, rollingKillTimeoutMs: 5000 }).spawn(mkTask(rolling));
  proc.start();
  const t0 = Date.now();
  while (!existsSync(up)) { if (Date.now() - t0 > 5000) throw new Error("child not up"); await wait(25); }
  await proc.stop();
  return existsSync(done);
}

describe("边录边传任务硬停宽限", () => {
  it("默认宽限常量足够传一段(≥ 5 分钟)", () => {
    expect(ROLLING_STOP_GRACE_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("resolveKillTimeoutMs:rolling 用长宽限;非 rolling / 未设 → undefined(进程默认);显式值最优先", () => {
    expect(resolveKillTimeoutMs({ rollingEffective: true }, undefined, 777)).toBe(777);
    expect(resolveKillTimeoutMs({ rollingEffective: false }, undefined, 777)).toBeUndefined();
    expect(resolveKillTimeoutMs({}, undefined, 777)).toBeUndefined();
    expect(resolveKillTimeoutMs({ rollingEffective: true }, 50, 777)).toBe(50);
  });

  it("rolling 任务:SIGTERM 后给足时间,收尾(上传末段)能跑完而不被 SIGKILL", async () => {
    expect(await stopAfterStart(true)).toBe(true);
  });

  it("显式 killTimeoutMs 优先于 rolling 宽限(运维/测试可覆盖)", async () => {
    const { entry, up, done } = fakeCli();
    const proc = new NodeRecordSpawner({ cliEntry: entry, killTimeoutMs: 150, rollingKillTimeoutMs: 5000 }).spawn(mkTask(true));
    proc.start();
    while (!existsSync(up)) await wait(25);
    await proc.stop();
    expect(existsSync(done)).toBe(false); // 150ms 到点被 SIGKILL,没来得及写标记
  });
});
