import { describe, expect, it } from "vitest";
import { buildNodes, nodeCounts, nodeRoomHref } from "../../packages/web/src/lib/nodes-page.js";
import type { RoomDTO, Task, WorkerDTO, WorkerStatus } from "../../packages/core/src/api-types.js";

const workers: WorkerDTO[] = [
  { id: "local", name: "controller", kind: "local" },
  { id: "w1", name: "worker-one", kind: "ssh", host: "host" },
];

function task(patch: Partial<Task>): Task {
  return {
    id: 1, platform: "douyin", room: "https://live.douyin.com/1", name: "Alice",
    managedBy: null, quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 0,
    useCookie: true, outDir: null, scheduleStart: null, scheduleEnd: null, status: "idle",
    enabled: true, createdAt: "", running: false, anchorName: "Alice", recording: false,
    cookies: null, webhook: null, hasCookies: true, hasWebhook: false, rollingUpload: false,
    rollingEffective: false, streamUpload: false, streamUploadSpool: true, outputFormat: "original",
    ...patch,
  } as Task;
}

function room(patch: Partial<RoomDTO>): RoomDTO {
  return { key: "douyin.1", platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1", recording: null, processing: null, ...patch };
}

describe("nodes page model", () => {
  it("puts the controller first and counts active/recording rooms", () => {
    const tasks = [
      task({ id: 1, recordingWorkers: [
        { workerId: "local", workerName: "controller", state: "recording", checkedAt: 10 },
        { workerId: "w1", workerName: "worker-one", state: "not_recording", checkedAt: 10 },
      ] }),
    ];
    const status: Record<string, WorkerStatus> = { local: { id: "local", ok: true }, w1: { id: "w1", ok: false, error: "down" } };
    const out = buildNodes(tasks, [room({})], workers, status, [], "0.0.234");
    expect(out.map((n) => n.id)).toEqual(["local", "w1"]);
    expect(out[0]?.recordingRooms).toBe(1);
    expect(nodeCounts(out[0]!)).toMatchObject({ active: 1, recording: 1 });
    expect(out[1]?.ok).toBe(false);
  });

  it("keeps an orphan rolling session visible under its node", () => {
    const out = buildNodes([], [room({})], workers, { w1: { id: "w1", ok: true } }, [
      { workerId: "w1", workerName: "worker-one", platform: "douyin", roomSlug: "1", anchorName: "Alice", sessionBase: "s", bv: "BV1", confirmed: 1, total: 2, ambiguous: 1, uploading: null, recording: false, checkedAt: 1 },
    ], "0.0.234");
    const w1 = out.find((n) => n.id === "w1")!;
    expect(w1.rooms[0]?.sessions[0]?.bv).toBe("BV1");
    expect(w1.uncertainSessions).toBe(1);
  });

  it("keeps equal room slugs on different platforms separate", () => {
    const tasks = [
      task({ id: 1, platform: "douyin", room: "https://live.douyin.com/7", recordingWorkers: [
        { workerId: "w1", workerName: "worker-one", state: "recording", checkedAt: 1 },
      ] }),
      task({ id: 2, platform: "bilibili", room: "https://live.bilibili.com/7", recordingWorkers: [
        { workerId: "w1", workerName: "worker-one", state: "not_recording", checkedAt: 1 },
      ] }),
    ];
    const out = buildNodes(tasks, [], workers, { w1: { id: "w1", ok: true } }, [], "0.0.234");
    const w1 = out.find((n) => n.id === "w1")!;
    expect(w1.rooms.map((r) => [r.platform, r.roomSlug, r.taskId])).toEqual([
      ["douyin", "7", 1],
      ["bilibili", "7", 2],
    ]);
    expect(new Set(w1.rooms.map((r) => r.key)).size).toBe(2);
  });

  it("room links use the unified key and encode it", () => {
    expect(nodeRoomHref({ platform: "douyin", roomSlug: "1" })).toBe("/rooms/douyin.1");
  });
});
