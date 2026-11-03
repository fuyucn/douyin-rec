import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { makeApi } from "../../packages/app/src/web/api.js";
import type { ApiDeps } from "../../packages/app/src/web/api/types.js";
import { recordRoomSessions, roomStatsDbPath } from "../../packages/app/src/room-stats.js";

// GET /api/stats 的配置映射端到端测试(采集侧的接线已由 test/orchestrator/stats-observe.test.ts 钉住)。
// 口径:空 workers = 全部节点;无规则 = 本机单节点;同房间多任务只计一次;规则停用/能力不满足的节点不算 assigned。

let dir: string;
let store: TaskStore;
let hubDir: string;

function writeWorkers(caps: Record<string, string[]> = {}): string {
  const hubConfigPath = join(dir, "hub.config.json");
  writeFileSync(hubConfigPath, JSON.stringify({
    workers: [
      { id: "w1", name: "video-rec", kind: "ssh", host: "h1", dataRoot: "/d1", ...(caps.w1 ? { capabilities: caps.w1 } : {}) },
      { id: "w2", name: "video-rec-2", kind: "ssh", host: "h2", dataRoot: "/d2", ...(caps.w2 ? { capabilities: caps.w2 } : {}) },
    ],
  }, null, 2));
  return hubConfigPath;
}

interface StatsBody {
  overview: { knownRooms: number; enabledRooms: number; nodeLoad: Array<{ workerId: string; assignedRooms: number }> };
  rooms: Array<{ key: string; enabled: boolean; uploadMode: string; workers: never[] }>;
  empty: boolean;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stats-api-"));
  // stats handler 经 rootStatsDbPath() 读 <drecRoot>/db/room-stats.db,drecRoot() 现读 env;
  // 测试把数据根指到临时目录,与 recordRoomSessions 落库同一路径。
  process.env.DOUYIN_REC_ROOT = dir;
  store = new TaskStore(":memory:");
  hubDir = dir;
});

afterEach(() => {
  delete process.env.DOUYIN_REC_ROOT;
  rmSync(dir, { recursive: true, force: true });
});

function makeApiWith(hubConfigPath: string) {
  const deps: ApiDeps = {
    store,
    manager: { runningIds: () => [], isRunning: () => false } as unknown as ApiDeps["manager"],
    hubDir,
    hubConfigPath,
  };
  return makeApi(deps);
}

describe("GET /api/stats 配置映射", () => {
  it("无规则房间 → uploadMode=local、workers=[local];有规则空 workers → 全部节点;knownRooms 去重", () => {
    const hubConfigPath = writeWorkers();
    // 同一房间两个任务(同 platform+slug) → 只算一次
    store.addTask({ room: "https://live.douyin.com/aaa", enabled: true });
    store.addTask({ room: "https://live.douyin.com/aaa", enabled: true });
    store.addTask({ room: "https://live.douyin.com/bbb", enabled: true });
    // 给 222 一条空 workers 规则(= 全部节点)
    writeFileSync(join(hubDir, "douyin.bbb.json"), JSON.stringify({
      room: "https://live.douyin.com/bbb", enabled: true,
      pipeline: { upload: { mode: "stage" } }, workers: [],
    }));
    const api = makeApiWith(hubConfigPath);
    const r = api.getStats({ days: 30 });
    expect(r.status).toBe(200);
    const b = r.body as StatsBody;
    expect(b.overview.knownRooms).toBe(2);
    // rooms[] 只含「窗口内有场次」的观测行;配置口径看 overview 的分桶与 nodeLoad.assignedRooms
    expect(b.overview.uploadModes).toEqual([{ mode: "local", count: 1 }, { mode: "stage", count: 1 }]);
    expect(b.overview.nodeLoad.find((n) => n.workerId === "w1")!.assignedRooms).toBe(1);
    expect(b.overview.nodeLoad.find((n) => n.workerId === "w2")!.assignedRooms).toBe(1);
  });

  it("nodeLoad.assignedRooms:只算已启用房间;规则停用的节点不计入", () => {
    const hubConfigPath = writeWorkers();
    store.addTask({ room: "https://live.douyin.com/ccc" });
    // enabled:false 的规则 → isWorkerAssigned 全 false → assignedRooms 0
    writeFileSync(join(hubDir, "douyin.ccc.json"), JSON.stringify({
      room: "https://live.douyin.com/ccc", enabled: false,
      pipeline: { upload: { mode: "stage" } }, workers: [],
    }));
    const api = makeApiWith(hubConfigPath);
    const b = api.getStats({ days: 30 }).body as StatsBody;
    const w1 = b.overview.nodeLoad.find((n) => n.workerId === "w1")!;
    expect(w1.assignedRooms).toBe(0);
  });

  it("能力门控:requires 未满足的节点不算 assigned", () => {
    const hubConfigPath = writeWorkers({ w2: ["rolling"] });
    store.addTask({ room: "https://live.douyin.com/ddd", enabled: true });
    writeFileSync(join(hubDir, "douyin.ddd.json"), JSON.stringify({
      room: "https://live.douyin.com/ddd", enabled: true,
      pipeline: { upload: { mode: "stage" } }, workers: [],
      requires: ["rolling"],
    }));
    const api = makeApiWith(hubConfigPath);
    const b = api.getStats({ days: 30 }).body as StatsBody;
    expect(b.overview.nodeLoad.find((n) => n.workerId === "w1")!.assignedRooms).toBe(0);
    expect(b.overview.nodeLoad.find((n) => n.workerId === "w2")!.assignedRooms).toBe(1);
  });

  it("无采集数据 → empty=true;有数据 → rooms 含观测行", () => {
    const hubConfigPath = writeWorkers();
    store.addTask({ room: "https://live.douyin.com/eee" });
    const api = makeApiWith(hubConfigPath);
    const empty = api.getStats({ days: 30 }).body as StatsBody;
    expect(empty.empty).toBe(true);
    // 落一条会话再查
    const db = roomStatsDbPath(dir);
    recordRoomSessions(db, "w1", [{
      platform: "douyin", roomSlug: "555",
      startMs: Date.now() - 3_600_000, endMs: Date.now(), durationSec: 3600,
    }]);
    const b = api.getStats({ days: 30 }).body as StatsBody;
    expect(b.empty).toBe(false);
    expect(b.rooms).toHaveLength(1);
    expect(b.rooms[0].sessions).toBe(1);
  });
});
