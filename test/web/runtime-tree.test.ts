import { describe, expect, it } from "vitest";
import {
  buildRuntimeTree,
  runtimeMode,
  type RuntimeTreeInput,
} from "../../packages/web/src/lib/runtime-tree.js";
import type { QueueItemDTO, RollingDeliveryDTO, RoomDTO, Task, WorkerDTO } from "../../packages/web/src/api/client.js";
import type { LiveUploadSnapshot } from "../../packages/core/src/live-upload.js";

function room(patch: Partial<RoomDTO> = {}): RoomDTO {
  const out: RoomDTO = {
    key: "douyin.1",
    platform: "douyin",
    roomSlug: "1",
    room: "https://live.douyin.com/1",
    recording: {
      taskId: 7,
      room: "https://live.douyin.com/1",
      name: "Alice",
      anchorName: "Alice",
      quality: "origin",
      engine: "ffmpeg",
      danmu: 0,
      segmentSec: 1800,
      scheduleStart: null,
      scheduleEnd: null,
      enabled: true,
      useCookie: false,
      cookies: null,
      hasCookies: false,
      outDir: null,
      webhook: null,
      hasWebhook: false,
      rollingUpload: false,
      rollingEffective: false,
      streamUpload: false,
      streamUploadSpool: true,
      outputFormat: "original",
    },
    processing: { enabled: true, pipeline: { upload: { mode: "upload" } } },
    ...patch,
  } as RoomDTO;
  return out;
}

function task(patch: Partial<Task> = {}): Task {
  return {
    id: 7,
    platform: "douyin",
    room: "https://live.douyin.com/1",
    name: "Alice",
    managedBy: null,
    quality: "origin",
    engine: "ffmpeg",
    danmu: 0,
    segmentSec: 1800,
    useCookie: false,
    outDir: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: "running",
    enabled: true,
    createdAt: "2026-10-29T00:00:00Z",
    running: true,
    recording: true,
    anchorName: "Alice",
    cookies: null,
    webhook: null,
    hasCookies: false,
    hasWebhook: false,
    rollingUpload: false,
    rollingEffective: false,
    streamUpload: false,
    streamUploadSpool: true,
    outputFormat: "original",
    ...patch,
  } as Task;
}

const workers: WorkerDTO[] = [
  { id: "a", name: "worker A", kind: "ssh" },
  { id: "b", name: "worker B", kind: "ssh" },
];

function base(overrides: Partial<RuntimeTreeInput> = {}): RuntimeTreeInput {
  return { room: room(), task: task(), workers, ...overrides };
}

function queueItem(patch: Partial<QueueItemDTO> = {}): QueueItemDTO {
  return {
    streamKey: "k1",
    platform: "douyin",
    roomSlug: "1",
    anchorName: "Alice",
    state: "pending",
    phase: "running",
    resource: null,
    queuePosition: null,
    currentNode: null,
    doneSteps: [],
    nextSteps: [],
    currentStepSec: null,
    etaSec: null,
    winnerWorker: null,
    fails: 0,
    updatedAt: 100,
    error: null,
    bv: null,
    videoDurationSec: null,
    finishedAt: null,
    enqueuedAt: 100,
    nodeUpload: null,
    ...patch,
  };
}

function rolling(patch: Partial<RollingDeliveryDTO> = {}): RollingDeliveryDTO {
  return {
    workerId: "a",
    workerName: "worker A",
    platform: "douyin",
    roomSlug: "1",
    anchorName: "Alice",
    sessionBase: "s1",
    bv: null,
    confirmed: 0,
    total: 1,
    ambiguous: 0,
    uploading: null,
    recording: true,
    checkedAt: 100,
    ...patch,
  };
}

function snapshot(patch: Partial<LiveUploadSnapshot> = {}): LiveUploadSnapshot {
  return {
    schemaVersion: 1,
    mode: "live",
    platform: "douyin",
    roomSlug: "1",
    state: "streaming",
    startedAt: 1,
    updatedAt: 100,
    parts: [],
    events: [],
    ...patch,
  } as LiveUploadSnapshot;
}

const MiB = 1024 * 1024;

describe("runtimeMode", () => {
  it("prefers live direct, then rolling, then node-side upload, then upload, then archive", () => {
    expect(runtimeMode(room(), task())).toBe("upload");
    expect(runtimeMode(room({ processing: { enabled: true, pipeline: { upload: { mode: "stage" } } } }), task())).toBe("archive");
    expect(runtimeMode(room({ processing: { enabled: true, pipeline: { steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false }, upload: { mode: "upload" } } } }), task())).toBe("node-upload");
    expect(runtimeMode(room({ processing: { enabled: true, pipeline: { upload: { mode: "rolling" } } } }), task())).toBe("rolling");
    expect(runtimeMode(room({ recording: { ...room().recording!, streamUpload: true } }), task())).toBe("live-direct");
  });
});

describe("buildRuntimeTree", () => {
  it("shows live-direct record/upload/confirm stages from the real snapshot", () => {
    const model = buildRuntimeTree(base({
      room: room({ recording: { ...room().recording!, streamUpload: true } }),
      task: task({ streamUpload: true }),
      live: [{
        workerId: "a",
        workerName: "worker A",
        current: snapshot({
          state: "streaming",
          currentPart: { index: 0, phase: "streaming", uploadedBytes: 120 * MiB, bytes: 2048 * MiB, chunks: 3 },
        }),
      }],
    }));
    const a = model.nodes.find((n) => n.id === "a")!;
    expect(a.role).toBe("winner");
    expect(a.stages.map((s) => `${s.key}:${s.state}`)).toEqual([
      "record:running",
      "upload:running",
      "confirm:waiting",
    ]);
    expect(a.stages[1].note).toEqual({ kind: "part", part: 1, uploadedMiB: 120, capMiB: 2048 });
    const hub = model.nodes.find((n) => n.role === "controller")!;
    expect(hub.stages[0]).toMatchObject({ key: "ledger", state: "running" });
    expect(model.upload).toEqual({ part: 1, uploadedMiB: 120, confirmed: 0 });
  });

  it("marks a finished live-direct run as done and reports confirmed parts", () => {
    const model = buildRuntimeTree(base({
      room: room({ recording: { ...room().recording!, streamUpload: true } }),
      task: task({ streamUpload: true }),
      live: [{
        workerId: "a",
        workerName: "worker A",
        current: snapshot({
          state: "finished",
          bvid: "BV1xx",
          parts: [{ index: 0, phase: "confirmed", uploadedBytes: 100, bytes: 100, chunks: 1 }],
        }),
      }],
    }));
    const a = model.nodes.find((n) => n.id === "a")!;
    expect(a.stages.map((s) => s.state)).toEqual(["done", "done", "done"]);
    const hub = model.nodes.find((n) => n.role === "controller")!;
    expect(hub.stages[0].state).toBe("done");
    expect(model.bvid).toBe("BV1xx");
  });

  it("uses the ledger winner over the local guess", () => {
    const model = buildRuntimeTree(base({
      task: task({ recordingWorkers: [
        { workerId: "a", workerName: "worker A", state: "recording", checkedAt: 1 },
        { workerId: "b", workerName: "worker B", state: "not_recording", checkedAt: 1 },
      ] }),
      queueItem: queueItem({ winnerWorker: "b", phase: "running" }),
    }));
    expect(model.winnerId).toBe("b");
    expect(model.winnerName).toBe("worker B");
    expect(model.nodes.find((n) => n.id === "b")?.role).toBe("winner");
    expect(model.nodes.find((n) => n.id === "a")?.role).toBe("candidate");
  });

  it("derives rolling stages and flags ambiguous segments", () => {
    const model = buildRuntimeTree(base({
      room: room({ processing: { enabled: true, pipeline: { upload: { mode: "rolling" } } } }),
      rolling: [rolling({ confirmed: 1, total: 2, ambiguous: 1, uploading: { index: 1, kind: "create" } })],
    }));
    const a = model.nodes.find((n) => n.id === "a")!;
    expect(a.stages.map((s) => `${s.key}:${s.state}`)).toEqual([
      "record:running",
      "segmentUpload:running",
      "confirm:failed",
      "cleanup:unknown",
    ]);
    const hub = model.nodes.find((n) => n.role === "controller")!;
    expect(hub.stages[0]).toMatchObject({ key: "reconcile", state: "failed" });
  });

  it("marks configured-off hub stages as skipped and reads running steps from the queue", () => {
    const model = buildRuntimeTree(base({
      room: room({ processing: { enabled: true, pipeline: { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, upload: { mode: "upload" } } } }),
      queueItem: queueItem({
        phase: "running",
        currentNode: "upload_plain",
        doneSteps: [
          { step: "select", phase: "done", at: 1 },
          { step: "pull", phase: "done", at: 2 },
          { step: "merge", phase: "skipped", at: 3 },
        ],
        nextSteps: ["clean_source"],
      }),
    }));
    const hub = model.nodes.find((n) => n.role === "controller")!;
    const byKey = Object.fromEntries(hub.stages.map((s) => [s.key, s]));
    expect(byKey.select.state).toBe("done");
    expect(byKey.transfer.state).toBe("done");
    expect(byKey.merge.state).toBe("skipped");
    expect(byKey.burn.state).toBe("skipped");
    expect(byKey.upload.state).toBe("running");
    expect(byKey.cleanup.state).toBe("waiting");
  });

  it("shows an offline zero-disk node without inventing progress", () => {
    const model = buildRuntimeTree(base({
      room: room({ recording: { ...room().recording!, streamUpload: true } }),
      task: task({ streamUpload: true, zeroDisk: [{ workerId: "b", workerName: "worker B", state: "offline", checkedAt: 1 }] }),
    }));
    const b = model.nodes.find((n) => n.id === "b")!;
    expect(b.state).toBe("offline");
    expect(b.stages).toEqual([]);
  });

  it("counts every referenced worker plus the hub", () => {
    const model = buildRuntimeTree(base({
      task: task({ recordingWorkers: [
        { workerId: "a", workerName: "worker A", state: "recording", checkedAt: 1 },
        { workerId: "b", workerName: "worker B", state: "not_recording", checkedAt: 1 },
      ] }),
    }));
    expect(model.totals).toEqual({ nodes: 3, recording: 1 });
  });

  it("deduplicates and sorts live events", () => {
    const event = { kind: "live" as const, at: 50 };
    const model = buildRuntimeTree(base({
      room: room({ recording: { ...room().recording!, streamUpload: true } }),
      task: task({ streamUpload: true }),
      live: [
        { workerId: "a", workerName: "worker A", current: snapshot({ events: [event, { kind: "run_start", at: 10 }] }) },
        { workerId: "a", workerName: "worker A", previous: snapshot({ events: [event] }) },
      ],
    }));
    expect(model.events.map((e) => e.at)).toEqual([50, 10]);
  });

  it("treats missing burn flags as burn ON, like the backend", () => {
    const r = room({ processing: { enabled: true, pipeline: { steps: { nodeSideUpload: true }, upload: { mode: "upload" } } } });
    expect(runtimeMode(r, task())).toBe("upload");
    const hub = buildRuntimeTree(base({ room: r })).nodes.find((n) => n.role === "controller")!;
    expect(hub.stages.find((s) => s.key === "burn")?.state).not.toBe("skipped");
  });

  it("ignores a finished queue row when choosing the current winner", () => {
    const model = buildRuntimeTree(base({
      task: task({ recordingWorkers: [
        { workerId: "a", workerName: "worker A", state: "recording", checkedAt: 1 },
        { workerId: "b", workerName: "worker B", state: "not_recording", checkedAt: 1 },
      ] }),
      queueItem: queueItem({ winnerWorker: "b", phase: "done", bv: "BVold" }),
    }));
    expect(model.winnerId).toBe("a");
    expect(model.nodes.find((n) => n.id === "b")?.role).toBe("standby");
  });

  it("does not show an idle standby as having finished recording", () => {
    const model = buildRuntimeTree(base({
      task: task({ recordingWorkers: [{ workerId: "b", workerName: "worker B", state: "not_recording", checkedAt: 1 }] }),
    }));
    const rec = model.nodes.find((n) => n.id === "b")!.stages[0];
    expect(rec.state).toBe("waiting");
    expect(rec.note).toBeUndefined();
  });
});
