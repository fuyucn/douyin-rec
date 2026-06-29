// packages/orchestrator/src/transport-local.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "./transport-local.js";

describe("LocalTransport.listInventory", () => {
  it("聚合会话分段时长 + 读 gaps + 映射 roomSlug（getter 函数）", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-"));
    const dir = join(root, "一勺小苏打"); mkdirSync(dir);
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_000.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_001.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54.gaps.json"),
      JSON.stringify({ sessionBase: "一勺小苏打_2026-06-27_07-54", gaps: [{ startMs: 0, endMs: 10_000 }], totalGapSec: 10 }));
    const t = new LocalTransport({
      id: "local", recordingsDir: root,
      // getter 函数形式（新接口）
      taskRooms: () => ({ "一勺小苏打": "999" }),
      ffprobe: async () => ({ durationSec: 1800, startMs: 1_700_000_000_000, endMs: 1_700_001_800_000 }),
    });
    const inv = await t.listInventory();
    expect(inv.recordings).toHaveLength(1);
    expect(inv.recordings[0].roomSlug).toBe("999");
    expect(inv.recordings[0].durationSec).toBe(3600); // 两段 1800 各
    expect(inv.recordings[0].totalGapSec).toBe(10);
  });

  it("taskRooms 普通 Record 仍兼容", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-"));
    const dir = join(root, "主播A"); mkdirSync(dir);
    writeFileSync(join(dir, "主播A_2026-06-27_08-00_000.ts"), "x");
    const t = new LocalTransport({
      id: "local2", recordingsDir: root,
      taskRooms: { "主播A": "12345" },
      ffprobe: async () => ({ durationSec: 600, startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 }),
    });
    const inv = await t.listInventory();
    expect(inv.recordings).toHaveLength(1);
    expect(inv.recordings[0].roomSlug).toBe("12345");
  });
});

describe("LocalTransport.isDone（Bug B:不再恒 true）", () => {
  const base = (over = {}) => new LocalTransport({
    id: "l", recordingsDir: "/x", taskRooms: {},
    ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }), ...over,
  });
  it("isRoomRecording=true（在录）→ isDone=false（未收播,settle 会等）", async () => {
    expect(await base({ isRoomRecording: () => true }).isDone("999")).toBe(false);
  });
  it("isRoomRecording=false → isDone=true", async () => {
    expect(await base({ isRoomRecording: () => false }).isDone("999")).toBe(true);
  });
  it("未注入 → 默认 true(旧行为兼容)", async () => {
    expect(await base().isDone("999")).toBe(true);
  });
});

describe("LocalTransport.listInventory（Bug A:gaps.roomSlug 优先)", () => {
  it("gaps.json 带 roomSlug → 用它,不回退目录名(防跨节点 slug 不一致)", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-slug-"));
    const dir = join(root, "流放2-老于"); mkdirSync(dir);
    writeFileSync(join(dir, "流放2-老于_2026-06-29_08-40_000.ts"), "x");
    writeFileSync(join(dir, "流放2-老于_2026-06-29_08-40.gaps.json"),
      JSON.stringify({ sessionBase: "流放2-老于_2026-06-29_08-40", gaps: [], totalGapSec: 0, roomSlug: "465721793855" }));
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: {},  // 空:模拟 anchorName 未解析
      ffprobe: async () => ({ durationSec: 300, startMs: 1, endMs: 300_001 }),
    });
    const inv = await t.listInventory();
    expect(inv.recordings[0].roomSlug).toBe("465721793855");  // gaps 优先,非目录名"流放2-老于"
  });
});

describe("LocalTransport.pull", () => {
  it("复制文件到目标目录（同机 pull 实装）", async () => {
    const root = mkdtempSync(join(tmpdir(), "pull-"));
    const src = join(root, "a.ts");
    writeFileSync(src, "video-data");
    const target = join(root, "stage", "broadcast-abc");
    const t = new LocalTransport({
      id: "local", recordingsDir: root,
      taskRooms: {},
      ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    });
    await t.pull([src], target);
    const { readFileSync, existsSync } = await import("node:fs");
    expect(existsSync(join(target, "a.ts"))).toBe(true);
    expect(readFileSync(join(target, "a.ts"), "utf-8")).toBe("video-data");
  });
});
