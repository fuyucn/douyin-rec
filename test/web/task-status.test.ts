import { describe, it, expect } from "vitest";
import { PHASE_STYLE, taskPhase } from "../../packages/web/src/lib/task-status.js";
import type { Task } from "../../packages/web/src/api/client.js";

type In = Parameters<typeof taskPhase>[0];
const mk = (p: Partial<In>): In => ({ enabled: true, status: "stopped", running: false, recording: false, ...p }) as In;
const w = (workerName: string, state: "recording" | "not_recording" | "unavailable") => ({ workerId: workerName, workerName, state });

describe("taskPhase(运行态派生唯一口径)", () => {
  it("停用最优先,即使进程还在跑/正在收尾", () => {
    expect(taskPhase(mk({ enabled: false, running: true, recording: true, stopping: true })).kind).toBe("disabled");
  });

  it("收尾优先于在录:硬停收尾 > 排空 > 在录", () => {
    expect(taskPhase(mk({ stopping: true, running: true, recording: true })).textKey).toBe("badge.stopping");
    expect(taskPhase(mk({ status: "draining", running: true, recording: true })).textKey).toBe("badge.draining");
  });

  it("远端有节点在录 → 带出节点名;本地在录才用 recording", () => {
    const r = taskPhase(mk({ running: true, recordingWorkers: [w("n1", "recording"), w("n2", "not_recording")] }));
    expect(r.kind).toBe("recording");
    expect(r.textKey).toBe("badge.recordingOn");
    expect(r.recordingNodes).toEqual(["n1"]);
    expect(taskPhase(mk({ running: true, recording: true })).textKey).toBe("badge.recording");
  });

  it("远端全不在录 → 等待开播;有 unavailable → 独立档位「离线」(不是等待)", () => {
    expect(taskPhase(mk({ running: true, recordingWorkers: [w("n1", "not_recording")] })).textKey).toBe("badge.workersIdle");
    const down = taskPhase(mk({ recordingWorkers: [w("n1", "unavailable")] }));
    expect(down.kind).toBe("offline");
    expect(down.textKey).toBe("badge.workersUnavailable");
    expect(down.unavailableNodes).toEqual(["n1"]);
  });

  it("远端在录优先于本地 error 与本地 running:双录时某节点报错不该顶掉「在录」", () => {
    expect(taskPhase(mk({ status: "error", running: true, recordingWorkers: [w("n1", "recording")] })).kind).toBe("recording");
    expect(taskPhase(mk({ status: "error", running: true, recordingWorkers: [w("n1", "not_recording")] })).textKey).toBe("badge.workersIdle");
  });

  it("本地在跑但没拿到流 → 等待开播;running=false + status=running(服务刚重启)→ 待命", () => {
    expect(taskPhase(mk({ running: true, recording: false })).textKey).toBe("badge.waiting");
    expect(taskPhase(mk({ running: false, status: "running" })).textKey).toBe("badge.idle");
  });

  it("无远端信息:错误 → 错误;其余 → 待命", () => {
    expect(taskPhase(mk({ status: "error" })).textKey).toBe("badge.error");
    expect(taskPhase(mk({})).textKey).toBe("badge.idle");
  });

  it("配色/脉冲:录制中绿脉冲、等待灰脉冲、离线红静止(离线不能被显示成等待)", () => {
    expect(PHASE_STYLE.recording).toMatchObject({ tone: "badge-success", pulse: true });
    expect(PHASE_STYLE.waiting).toMatchObject({ tone: "badge-neutral", pulse: true });
    expect(PHASE_STYLE.offline).toMatchObject({ tone: "badge-error", pulse: false });
    expect(PHASE_STYLE.idle.pulse).toBe(false);
  });
});
