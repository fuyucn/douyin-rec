import { describe, expect, it } from "vitest";
import { liveUploadLanes } from "../../packages/web/src/lib/queue-live.js";
import type { Task } from "../../packages/web/src/api/client.js";

describe("liveUploadLanes", () => {
  const task = (over: Partial<Task> = {}): Task => ({
    id: 7, room: "https://live.douyin.com/1", name: "Alice", anchorName: "Alice",
    streamUpload: true,
    zeroDisk: [{
      workerId: "local", workerName: "本机", state: "ok", checkedAt: 10,
      live: { sessionId: "1:1", state: "streaming", currentPart: { index: 2, phase: "streaming", uploadedBytes: 10, chunks: 1 }, partsConfirmed: 2, updatedAt: 10 },
    }],
    ...over,
  }) as Task;

  it("builds a lane from tasks even when the hub queue has zero rows", () => {
    const lanes = liveUploadLanes([task()]);
    expect(lanes).toHaveLength(1);
    expect(lanes[0]).toMatchObject({ taskId: 7, partIndex: 2, state: "streaming", workerName: "本机" });
  });

  it("hides terminal and old-node tasks", () => {
    expect(liveUploadLanes([task({ zeroDisk: [{ workerId: "local", workerName: "本机", state: "ok", checkedAt: 1, live: { sessionId: "1", state: "finished", partsConfirmed: 1, updatedAt: 1 } }] })])).toEqual([]);
    expect(liveUploadLanes([task({ zeroDisk: [] })])).toEqual([]);
  });

  it("only reports tasks that actually upload live", () => {
    expect(liveUploadLanes([task({ streamUpload: false })])).toEqual([]);
  });
});
