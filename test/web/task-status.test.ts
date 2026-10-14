import { describe, it, expect } from "vitest";
import { taskPhase } from "../../packages/web/src/lib/task-status.js";
import type { Task } from "../../packages/web/src/api/client.js";

const mk = (p: Partial<Task>): Pick<Task, "enabled" | "status" | "recording"> & { stopping?: boolean; recordingWorkers?: Task["recordingWorkers"] } =>
  ({ enabled: true, status: "stopped", recording: false, ...p }) as never;
const w = (workerName: string, state: "recording" | "not_recording" | "unavailable") => ({ workerId: workerName, workerName, state });

describe("taskPhase(运行态派生唯一口径)", () => {
  it("停用最优先,即使进程还在跑/正在收尾", () => {
    expect(taskPhase(mk({ enabled: false, recording: true, stopping: true })).kind).toBe("disabled");
  });

  it("收尾优先于在录:硬停收尾 > 排空 > 在录", () => {
    expect(taskPhase(mk({ stopping: true, recording: true })).textKey).toBe("badge.stopping");
    expect(taskPhase(mk({ status: "draining", recording: true })).textKey).toBe("badge.draining");
  });

  it("远端有节点在录 → 带出节点名;本地在录才用 recording", () => {
    const r = taskPhase(mk({ recordingWorkers: [w("n1", "recording"), w("n2", "not_recording")] }));
    expect(r.kind).toBe("recording");
    expect(r.textKey).toBe("badge.recordingOn");
    expect(r.recordingNodes).toEqual(["n1"]);
    expect(taskPhase(mk({ recording: true })).textKey).toBe("badge.recording");
  });

  it("远端全不在录 → 等待开播;有 unavailable → 走「节点离线」文案", () => {
    expect(taskPhase(mk({ status: "running", recordingWorkers: [w("n1", "not_recording")] })).textKey).toBe("badge.workersIdle");
    const down = taskPhase(mk({ recordingWorkers: [w("n1", "unavailable")] }));
    expect(down.textKey).toBe("badge.workersUnavailable");
    expect(down.unavailableNodes).toEqual(["n1"]);
  });

  it("无远端信息:运行中 → 等待开播;错误 → 错误;其余 → 待命", () => {
    expect(taskPhase(mk({ status: "running" })).textKey).toBe("badge.waiting");
    expect(taskPhase(mk({ status: "error" })).textKey).toBe("badge.error");
    expect(taskPhase(mk({})).textKey).toBe("badge.idle");
  });
});
