// packages/orchestrator/src/scan.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRecordings } from "./scan.js";

describe("scanRecordings", () => {
  it("聚合会话分段时长 + 读 gaps + 映射 roomSlug", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "一勺小苏打"); mkdirSync(dir);
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_000.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_001.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54.gaps.json"),
      JSON.stringify({ sessionBase: "一勺小苏打_2026-06-27_07-54", gaps: [{ startMs: 0, endMs: 10_000 }], totalGapSec: 10 }));

    const recordings = await scanRecordings(
      root,
      { "一勺小苏打": "999" },
      async () => ({ durationSec: 1800, startMs: 1_700_000_000_000, endMs: 1_700_001_800_000 }),
    );

    expect(recordings).toHaveLength(1);
    expect(recordings[0].roomSlug).toBe("999");
    expect(recordings[0].durationSec).toBe(3600); // 两段 1800 各
    expect(recordings[0].totalGapSec).toBe(10);
    expect(recordings[0].startMs).toBe(1_700_000_000_000);
    expect(recordings[0].endMs).toBe(1_700_001_800_000);
  });

  it("未命中 taskRooms 时 fallback 使用目录名作 roomSlug", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");

    const recordings = await scanRecordings(
      root,
      {}, // empty — no mapping
      async () => ({ durationSec: 600, startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 }),
    );

    expect(recordings).toHaveLength(1);
    expect(recordings[0].roomSlug).toBe("主播A"); // directory name as fallback
  });

  it("recordings 目录不存在时返回空数组（不抛异常）", async () => {
    const recordings = await scanRecordings(
      "/does/not/exist",
      {},
      async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    );
    expect(recordings).toHaveLength(0);
  });

  it("多主播多会话各自独立返回", async () => {
    const root = mkdtempSync(join(tmpdir(), "scan-"));
    const dirA = join(root, "主播A"); mkdirSync(dirA);
    writeFileSync(join(dirA, "主播A_2026-06-27_08-00_000.ts"), "x");
    const dirB = join(root, "主播B"); mkdirSync(dirB);
    writeFileSync(join(dirB, "主播B_2026-06-27_09-00_000.ts"), "x");

    const recordings = await scanRecordings(
      root,
      { "主播A": "111", "主播B": "222" },
      async () => ({ durationSec: 600, startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 }),
    );

    expect(recordings).toHaveLength(2);
    const slugs = recordings.map((r) => r.roomSlug).sort();
    expect(slugs).toEqual(["111", "222"]);
  });
});
