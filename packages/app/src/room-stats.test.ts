import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildStats,
  lastCollectionAt,
  readStatsSessions,
  recordRoomSessions,
  roomStatsDbPath,
  STATS_MERGE_GAP_MS,
  type BuildStatsInput,
  type StoredSession,
} from "./room-stats.js";

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0); // 2026-11-03 12:00 UTC
const H = 3_600_000;
const mk = (over: Partial<StoredSession> & { startMs: number }): StoredSession => ({
  workerId: over.workerId ?? "w1",
  platform: over.platform ?? "douyin",
  roomSlug: over.roomSlug ?? "123",
  startMs: over.startMs,
  endMs: over.endMs ?? over.startMs + 2 * H,
  durationSec: over.durationSec ?? ((over.endMs ?? over.startMs + 2 * H) - over.startMs) / 1000,
  gapSec: over.gapSec ?? 0,
  danmuCount: over.danmuCount ?? null,
  bytes: over.bytes ?? null,
  title: over.title ?? null,
  lastSeenAt: over.lastSeenAt ?? NOW,
});
const base: Omit<BuildStatsInput, "sessions"> = {
  rooms: [{
    platform: "douyin", roomSlug: "123", anchorName: "主播A", enabled: true,
    uploadMode: "stage", outputFormat: "original", engine: "ffmpeg", danmu: true,
    workers: ["w1"],
  }],
  workerNames: { w1: "video-rec", w2: "video-rec-2" },
  windowDays: 30,
  now: NOW,
  timeZone: "Asia/Shanghai",
};

describe("room-stats store", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "room-stats-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("record → read round trip;endMs 只增不减(录制中会话不回退)", () => {
    const db = roomStatsDbPath(dir);
    const s = { platform: "douyin", roomSlug: "123", startMs: NOW - 10 * H, endMs: NOW - 9 * H, durationSec: 3600, totalGapSec: 0 };
    expect(recordRoomSessions(db, "w1", [s], NOW - 10 * H)).toBe(1);
    // 后续对账:同一会话 endMs 已前进,但 worker 端只报到更早的刻 → 不得把进度写回
    expect(recordRoomSessions(db, "w1", [{ ...s, endMs: NOW - 9.5 * H, durationSec: 1800 }], NOW - 9 * H)).toBe(1);
    const rows = readStatsSessions(db, NOW - 30 * 24 * H);
    expect(rows).toHaveLength(1);
    expect(rows[0].endMs).toBe(NOW - 9 * H);
    expect(rows[0].durationSec).toBe(3600);
  });

  it("不同节点同一场各记一行(节点负载要真值)", () => {
    const db = roomStatsDbPath(dir);
    const s = { platform: "douyin", roomSlug: "123", startMs: NOW - H, endMs: NOW, durationSec: 3600 };
    recordRoomSessions(db, "w1", [s], NOW);
    recordRoomSessions(db, "w2", [s], NOW);
    expect(readStatsSessions(db, NOW - 24 * H)).toHaveLength(2);
    expect(lastCollectionAt(db)).not.toBeNull();
  });

  it("同场重连:10 分钟内的多段合并为一场", () => {
    const db = roomStatsDbPath(dir);
    const s = (start: number) => ({ platform: "douyin", roomSlug: "123", startMs: start, endMs: start + H, durationSec: 3600 });
    recordRoomSessions(db, "w1", [s(NOW - 5 * H), s(NOW - 4 * H)], NOW);
    const withOverlap = readStatsSessions(db, NOW - 24 * H);
    expect(withOverlap).toHaveLength(2); // 库内不合并,聚合再合并
    const dto = buildStats({ ...base, sessions: withOverlap });
    expect(dto.rooms[0].sessions).toBe(1);
  });
});

describe("buildStats 聚合", () => {
  it("跨节点同场去重计一场、合计时长不翻倍;节点负载仍按节点真值", () => {
    const merged = buildStats({
      ...base,
      sessions: [
        mk({ workerId: "w1", startMs: NOW - 10 * H }),
        mk({ workerId: "w2", startMs: NOW - 10 * H, endMs: NOW - 8 * H, durationSec: 7200 }), // 冗余录制,时间完全一致
      ],
    });
    expect(merged.rooms[0].sessions).toBe(1);
    expect(merged.rooms[0].totalHours).toBe(2);
    expect(merged.rooms[0].nodes).toHaveLength(2);
    expect(merged.overview.broadcastHours).toBe(2); // 去重后
    const w1 = merged.overview.nodeLoad.find((n) => n.workerId === "w1")!;
    const w2 = merged.overview.nodeLoad.find((n) => n.workerId === "w2")!;
    expect(w1.hours).toBe(2);
    expect(w2.hours).toBe(2); // 节点真值,不去重
    expect(w1.peakConcurrent).toBe(1);
  });

  it("峰值并发:同节点落 3 路同时会话 → peakConcurrent=3", () => {
    const dto = buildStats({
      ...base,
      rooms: [
        { platform: "douyin", roomSlug: "a", anchorName: null, enabled: true, uploadMode: "stage", outputFormat: "original", engine: "ffmpeg", danmu: true, workers: ["w1"] },
        { platform: "douyin", roomSlug: "b", anchorName: null, enabled: true, uploadMode: "stage", outputFormat: "original", engine: "ffmpeg", danmu: true, workers: ["w1"] },
        { platform: "douyin", roomSlug: "c", anchorName: null, enabled: true, uploadMode: "stage", outputFormat: "original", engine: "ffmpeg", danmu: true, workers: ["w1"] },
      ],
      sessions: [
        mk({ workerId: "w1", roomSlug: "a", startMs: NOW - H }),
        mk({ workerId: "w1", roomSlug: "b", startMs: NOW - H }),
        mk({ workerId: "w1", roomSlug: "c", startMs: NOW - H }),
      ],
    });
    expect(dto.overview.nodeLoad.find((n) => n.workerId === "w1")!.peakConcurrent).toBe(3);
  });

  it("热力图按设置时区累加小时(跨整点场次被切成两个桶)", () => {
    // Asia/Shanghai = UTC+8:某会话 UTC 13:00-16:00 = 北京时间 21:00-24:00
    const start = Date.UTC(2026, 10, 2, 13, 0, 0);
    const end = start + 3 * H;
    const dto = buildStats({ ...base, sessions: [mk({ workerId: "w1", startMs: start, endMs: end, durationSec: 10800 })] });
    const heat = dto.heatmap;
    const sum = heat.reduce((a, c) => a + c.hours, 0);
    expect(sum).toBe(3);
    // 北京时间 21:00 / 22:00 / 23:00 桶各 1h
    const cells = new Map(heat.map((c) => [c.hour, c.hours]));
    expect(cells.get(21)).toBe(1);
    expect(cells.get(22)).toBe(1);
    expect(cells.get(23)).toBe(1);
  });

  it("无采集数据 → empty=true,rooms 为空", () => {
    const dto = buildStats({ ...base, sessions: [] });
    expect(dto.empty).toBe(true);
    expect(dto.rooms).toEqual([]);
    expect(dto.lastCollectedAt).toBeNull();
  });

  it("同场间隔大于合并容差 → 算两场", () => {
    const s1 = mk({ workerId: "w1", startMs: NOW - 5 * H });
    const s2 = mk({ workerId: "w1", startMs: (NOW - 5 * H) + 2 * H + STATS_MERGE_GAP_MS + 1_000 });
    const dto = buildStats({ ...base, sessions: [s1, s2] });
    expect(dto.rooms[0].sessions).toBe(2);
  });
});
