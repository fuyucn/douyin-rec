import { describe, expect, it } from "vitest";
import {
  partChainFields,
  partChainProgressPct,
  queueBadges,
  queueText,
  skippedStepBadges,
  stepLabel,
  type PartChainUpload,
  type TFunc,
} from "../../packages/web/src/lib/queue-chain";

const ZH: Record<string, string> = {
  "queue.nodeUpload.partChain": "分 P 链",
  "queue.nodeUpload.step.transfer": "传输中",
  "queue.nodeUpload.attempt": "第 {n} 次",
  "queue.nodeUpload.notBefore": "最早重试 {time}",
  "queue.nodeUpload.heartbeat": "心跳 {time}前",
  "queue.phase.reconciling": "自动对账中",
  "queue.phase.reconcilingTip": "这是自动对账，不是故障；最多核对 24 小时。",
  "room.runtime.stageState.skipped": "跳过",
  "hub.jobs.stepNode.upload_part": "上传分 P",
  "hub.jobs.stepNode.cleanup_part": "清理分 P",
  "hub.jobs.stepNode.reconcile_part": "对账分 P",
};

const t: TFunc = (key, vars) => {
  const raw = ZH[key];
  if (raw == null) return key;
  return Object.entries(vars ?? {}).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), raw);
};

const NOW = new Date("2026-11-05T04:40:00Z").getTime();
const NOT_BEFORE = new Date("2026-11-05T04:34:00Z").getTime();

function upload(overrides: Partial<PartChainUpload> = {}): PartChainUpload {
  return {
    nodeId: "node-a",
    phase: "part-chain",
    state: "reconciling",
    step: "transfer",
    attempts: 2,
    notBefore: NOT_BEFORE,
    heartbeatAt: new Date("2026-11-05T04:39:00Z").getTime(),
    polledAt: NOW,
    progress: { doneBytes: 40e6, totalBytes: 100e6, bps: 2e6 },
    error: null,
    ...overrides,
  };
}

describe("queue chain presentation facts", () => {
  it("adds no badge when the backend has no part-chain, reconciling or skipped field", () => {
    expect(queueBadges({ state: "running", nodeUpload: { phase: "biliup" }, doneSteps: [] }, t)).toEqual([]);
    expect(queueBadges({ state: "done", nodeUpload: null, doneSteps: [] }, t)).toEqual([]);
  });

  it("shows the part-chain badge only for phase=part-chain", () => {
    expect(queueBadges({ state: "running", nodeUpload: { phase: "part-chain" }, doneSteps: [] }, t))
      .toEqual([{ kind: "part-chain", label: "分 P 链" }]);
  });

  it("shows reconciling with an explanatory tooltip from the backend state", () => {
    expect(queueBadges({ state: "reconciling", doneSteps: [] }, t)).toEqual([{
      kind: "reconciling",
      label: "自动对账中",
      title: "这是自动对账，不是故障；最多核对 24 小时。",
    }]);
  });

  it("renders skipped badges for a skipped state or skipped done steps", () => {
    expect(skippedStepBadges({ state: "skipped", doneSteps: [] }, t))
      .toEqual([{ key: "state-skipped", step: "", label: "跳过" }]);
    expect(skippedStepBadges({ state: "running", doneSteps: [{ step: "upload-part", phase: "skipped" }] }, t))
      .toEqual([{ key: "upload-part-0", step: "上传分 P", label: "跳过" }]);
  });

  it("maps the new nextSteps kinds and falls back to the raw step name", () => {
    expect(stepLabel(t, "upload-part")).toBe("上传分 P");
    expect(stepLabel(t, "cleanup-part")).toBe("清理分 P");
    expect(stepLabel(t, "reconcile-part")).toBe("对账分 P");
    expect(stepLabel(t, "unknown-step")).toBe("unknown-step");
    expect(queueText(t, "missing.key", "raw-value")).toBe("raw-value");
  });

  it("prints only backend part-chain fields", () => {
    expect(partChainFields(upload(), t, "12:34", NOW)).toEqual([
      "reconciling",
      "传输中",
      "第 2 次",
      "最早重试 12:34",
      "心跳 60前",
    ]);
    expect(partChainProgressPct(upload())).toBe(40);
    expect(partChainProgressPct(upload({ progress: null }))).toBeNull();
  });
});
