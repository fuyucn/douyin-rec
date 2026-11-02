// packages/orchestrator/src/transport-local.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "./transport-local.js";
import { ProcUnsupported, type NodeInventory } from "./transport.js";
import { scanRecordings } from "./scan.js";
import type { NodeTaskDTO } from "@drec/core";

describe("LocalTransport.ping(轻量存活探针)", () => {
  it("dataRoot 存在 → resolve", async () => {
    const root = mkdtempSync(join(tmpdir(), "ping-ok-"));
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: {},
      ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    });
    await expect(t.ping()).resolves.toBeUndefined();
  });
  it("dataRoot 不存在 → reject 带 message", async () => {
    const t = new LocalTransport({
      id: "local", recordingsDir: "/no/such/dir/xyz", taskRooms: {},
      ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
    });
    await expect(t.ping()).rejects.toThrow(/不存在|not exist|\/no\/such/i);
  });
});

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

describe("LocalTransport.listInventory unclaimed segments (#225)", () => {
  const ffprobe = async () => ({ durationSec: 600, startMs: 1_700_000_000_000, endMs: 1_700_000_600_000 });
  const task = (over: Partial<NodeTaskDTO>): NodeTaskDTO => ({
    id: 1, platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1", name: null, quality: "origin",
    engine: "ffmpeg", danmu: 0, segmentSec: 1800, scheduleStart: null, scheduleEnd: null, status: "idle",
    useCookie: false, enabled: true, outDir: null, webhook: null, managedBy: null, anchorName: null,
    rollingUpload: false, rollingEffective: false, ...over,
  });
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "loc-unclaimed-"));
    const a = join(root, "A"); mkdirSync(a);
    writeFileSync(join(a, "A_2026-06-27_08-00-00_000.ts"), "x");
    writeFileSync(join(a, "A_2026-06-27_10-00-00_000.mp4"), "xx"); // orphan: converted, no sidecar
    const b = join(root, "B"); mkdirSync(b);
    writeFileSync(join(b, "B_2026-06-27_12-00-00_000.mp4"), "x"); // orphan under anchorName-mapped dir
    return root;
  }
  const segSecOf = (inv: NodeInventory, anchor: string) =>
    inv.unclaimedSegments!.find((u) => u.path.includes(`${anchor}_2026`))!.segmentSec;

  it("segmentSec comes from listTasks (name and anchorName); recordings equal scanRecordings", async () => {
    const root = fixture();
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: { A: "888" }, ffprobe,
      listTasks: () => [task({ name: "A", segmentSec: 600 }), task({ id: 2, name: "x", anchorName: "B", segmentSec: 900 })],
    });
    const inv = await t.listInventory();
    expect(inv.workerId).toBe("local");
    expect(inv.unclaimedTruncated).toBe(0);
    expect(segSecOf(inv, "A")).toBe(600);
    expect(segSecOf(inv, "B")).toBe(900);
    expect(inv.recordings).toEqual(await scanRecordings(root, { A: "888" }, ffprobe));
  });

  it("without listTasks → segmentSec null (master falls back to its default)", async () => {
    const root = fixture();
    const inv = await new LocalTransport({ id: "local", recordingsDir: root, taskRooms: { A: "888" }, ffprobe }).listInventory();
    expect(inv.unclaimedSegments).toHaveLength(2);
    expect(inv.unclaimedSegments!.every((u) => u.segmentSec === null)).toBe(true);
    expect(inv.recordings).toEqual(await scanRecordings(root, { A: "888" }, ffprobe));
  });

  it("non-positive / non-finite segmentSec in listTasks is ignored (null)", async () => {
    const root = fixture();
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: {}, ffprobe,
      listTasks: () => [task({ name: "A", segmentSec: 0 }), task({ id: 2, name: "B", segmentSec: Number.NaN })],
    });
    const inv = await t.listInventory();
    expect(segSecOf(inv, "A")).toBeNull();
    expect(segSecOf(inv, "B")).toBeNull();
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

describe("LocalTransport.listInventory（meta.roomSlug 优先级最高）", () => {
  it("meta.json 的 roomSlug 优先于 gaps.roomSlug / taskRooms / 目录名", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-meta-"));
    const dir = join(root, "流放2-老于"); mkdirSync(dir);
    writeFileSync(join(dir, "流放2-老于_2026-06-29_08-40_000.ts"), "x");
    // meta=465(权威),gaps=999(旧/不同),taskRooms=888 → 应取 meta 的 465
    writeFileSync(join(dir, "流放2-老于_2026-06-29_08-40.meta.json"),
      JSON.stringify({ sessionBase: "流放2-老于_2026-06-29_08-40", roomSlug: "465721793855" }));
    writeFileSync(join(dir, "流放2-老于_2026-06-29_08-40.gaps.json"),
      JSON.stringify({ sessionBase: "流放2-老于_2026-06-29_08-40", gaps: [], totalGapSec: 0, roomSlug: "999" }));
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: { "流放2-老于": "888" },
      ffprobe: async () => ({ durationSec: 300, startMs: 1, endMs: 300_001 }),
    });
    const inv = await t.listInventory();
    expect(inv.recordings[0].roomSlug).toBe("465721793855");
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

  // T18-optim:同机 pull 用硬链接(省磁盘 + 省 IO)。必须证明三件事:
  //   ① 真的共享 inode(没白复制);② 删 stage 的副本不影响 recordings 原件;
  //   ③ 目标已存在时能覆盖(续跑/重跑场景)。
  it("硬链接:源与 stage 副本共享同一 inode(没有白复制一份)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pull-link-"));
    const src = join(root, "a.ts");
    writeFileSync(src, "video-data");
    const target = join(root, "stage", "bc-1");
    const t = new LocalTransport({ id: "local", recordingsDir: root, taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) });
    await t.pull([src], target);
    const { statSync } = await import("node:fs");
    const a = statSync(src);
    const b = statSync(join(target, "a.ts"));
    expect(b.ino).toBe(a.ino);       // 同一 inode = 硬链接成立
    expect(b.nlink).toBe(2);         // 两个名字指向它
  });

  it("硬链接:删掉 stage 副本后,recordings 原件仍在且内容完整", async () => {
    const root = mkdtempSync(join(tmpdir(), "pull-link2-"));
    const src = join(root, "a.ts");
    writeFileSync(src, "video-data");
    const target = join(root, "stage", "bc-2");
    const t = new LocalTransport({ id: "local", recordingsDir: root, taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) });
    await t.pull([src], target);
    const { rmSync, readFileSync, existsSync } = await import("node:fs");
    rmSync(join(target, "a.ts"), { force: true });          // 模拟清理 stage
    expect(existsSync(src)).toBe(true);                     // 原件没被牵连
    expect(readFileSync(src, "utf-8")).toBe("video-data");
  });

  it("硬链接:目标已存在时覆盖(续跑/重跑不会因 EEXIST 失败)", async () => {
    const root = mkdtempSync(join(tmpdir(), "pull-link3-"));
    const src = join(root, "a.ts");
    writeFileSync(src, "new-data");
    const target = join(root, "stage", "bc-3");
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "a.ts"), "stale");
    const t = new LocalTransport({ id: "local", recordingsDir: root, taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) });
    await t.pull([src], target);
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(join(target, "a.ts"), "utf-8")).toBe("new-data");
  });
});

describe("LocalTransport.recordingStatus(F1)", () => {
  it("在录房间来自注入,rolling 来自本机 recordings 目录的进度文件", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-rs-"));
    const dir = join(root, "A"); mkdirSync(dir);
    writeFileSync(join(dir, "A_1.rolling.json"), JSON.stringify({ segments: [{ index: 0 }, { index: 1 }], confirmed: [0], bv: "BV1L", startMs: 9 }));
    writeFileSync(join(dir, "A_1.session.json"), JSON.stringify({ roomSlug: "555", platform: "douyin" }));
    const t = new LocalTransport({
      id: "l", recordingsDir: root, taskRooms: {},
      ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }),
      activeRecordingRooms: () => [{ platform: "douyin", roomSlug: "555" }],
    });
    const st = await t.recordingStatus();
    expect(st.rooms).toEqual([{ platform: "douyin", roomSlug: "555" }]);
    expect(st.rolling).toMatchObject([{ roomSlug: "555", bv: "BV1L", confirmed: 1, total: 2, recording: true }]);
  });

  it("未注入在录房间 / 目录不存在 → 空,不抛", async () => {
    const t = new LocalTransport({ id: "l", recordingsDir: "/nonexistent-dir-x", taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) });
    expect(await t.recordingStatus()).toEqual({ rooms: [], rolling: [] });
  });
});

describe("LocalTransport.procCancel", () => {
  const base = { id: "local", recordingsDir: "/tmp", taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) };

  it("delegates to the injected handler and returns its receipts", async () => {
    const receipts = [{ jobId: "j1", state: "cancelled" }];
    const procCancel = vi.fn(() => receipts as never);
    const t = new LocalTransport({ ...base, procCancel });
    await expect(t.procCancel(["j1"])).resolves.toBe(receipts);
    expect(procCancel).toHaveBeenCalledWith(["j1"]);
  });

  it("throws ProcUnsupported when no handler is injected", async () => {
    const t = new LocalTransport(base);
    await expect(t.procCancel(["j1"])).rejects.toBeInstanceOf(ProcUnsupported);
  });
});

describe("LocalTransport.cleanup(失败不再吞,issue #429)", () => {
  const base = { id: "local", taskRooms: {}, ffprobe: async () => ({ durationSec: 0, startMs: 0, endMs: 0 }) };
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "loc-clean-")); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("成功:逐个删除(真实 fs;不存在的路径不算失败)", async () => {
    const a = join(root, "a.ts"); writeFileSync(a, "x");
    const t = new LocalTransport({ ...base, recordingsDir: root });
    await expect(t.cleanup([a, join(root, "gone.ts")])).resolves.toBeUndefined();
    expect(existsSync(a)).toBe(false);
  });

  it("任一失败 → 抛聚合错误(含失败路径数),其余路径照删、失败者保留", async () => {
    // 目录没有 recursive → rmSync(force) 报 ERR_FS_EISDIR,可稳定制造失败。
    const dir = join(root, "segdir"); mkdirSync(dir); writeFileSync(join(dir, "x.ts"), "x");
    const b = join(root, "b.ts"); writeFileSync(b, "x");
    const t = new LocalTransport({ ...base, recordingsDir: root });
    await expect(t.cleanup([dir, b])).rejects.toThrow(/本机清理失败: 1\/2 个路径未删/);
    expect(existsSync(b)).toBe(false);   // 一个失败不挡后面的
    expect(existsSync(dir)).toBe(true);  // 失败的保留(留给补跑)
  });
});
