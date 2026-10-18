import { describe, expect, it } from "vitest";
import { deriveStepStatuses } from "../../packages/web/src/lib/hub-job-steps.js";

const KEYS = ["select", "pull", "merge"] as const;

describe("deriveStepStatuses", () => {
  it("skipped is shown as skipped, never as done, and has no duration", () => {
    const st = deriveStepStatuses({
      state: "pending",
      steps: [
        { step: "select", phase: "start", at: 1 },
        { step: "select", phase: "done", at: 2 },
        { step: "pull", phase: "skipped", at: 3, detail: "跳过·会话边车扫描后消失" },
      ],
      nodeStates: [],
    }, KEYS, 10);
    expect(st.pull).toEqual({ status: "skipped", sec: null });
    expect(st.select).toEqual({ status: "done", sec: 0 });
  });

  it("a skip followed by a real pull shows the real completion", () => {
    const st = deriveStepStatuses({
      state: "done",
      steps: [
        { step: "pull", phase: "skipped", at: 3 },
        { step: "pull", phase: "start", at: 10_000 },
        { step: "pull", phase: "done", at: 15_000 },
      ],
      nodeStates: [],
    }, KEYS, 20);
    expect(st.pull).toEqual({ status: "done", sec: 5 });
  });

  it("a pending step without any event stays todo while the job is active", () => {
    const st = deriveStepStatuses({ state: "pending", steps: [], nodeStates: [] }, KEYS, 20);
    expect(st.pull).toEqual({ status: "todo", sec: null });
  });
});
