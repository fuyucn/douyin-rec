import { describe, expect, it } from "vitest";
import { SIDECAR_SKIP_PREFIX, SIDECAR_UNKNOWN_PREFIX } from "@drec/core";
import { deriveStepStatuses, stepDetail } from "../../packages/web/src/lib/hub-job-steps.js";

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

  it("a skip followed by a real pull still in progress shows active, not skipped", () => {
    const st = deriveStepStatuses({
      state: "syncing",
      steps: [
        { step: "pull", phase: "skipped", at: 3 },
        { step: "pull", phase: "start", at: 10_000 },
      ],
      nodeStates: [],
    }, KEYS, 25_000);
    expect(st.pull).toEqual({ status: "active", sec: 15 });
  });

  it("a legacy skip row (phase done + skip prefix) is shown as skipped, not done", () => {
    const st = deriveStepStatuses({
      state: "pending",
      steps: [{ step: "pull", phase: "done", at: 3, detail: "跳过·会话边车扫描后消失" }],
      nodeStates: [],
    }, KEYS, 10);
    expect(st.pull).toEqual({ status: "skipped", sec: null });
  });

  it("a pending step without any event stays todo while the job is active", () => {
    const st = deriveStepStatuses({ state: "pending", steps: [], nodeStates: [] }, KEYS, 20);
    expect(st.pull).toEqual({ status: "todo", sec: null });
  });
});

describe("stepDetail", () => {
  it("drops a skip reason once a later real start exists, keeps real details", () => {
    const skip = { step: "pull", phase: "skipped", at: 1, detail: `${SIDECAR_SKIP_PREFIX}gone` };
    expect(stepDetail([skip], "pull")).toBe(skip.detail);
    expect(stepDetail([skip, { step: "pull", phase: "start", at: 2 }], "pull")).toBeUndefined();
    expect(stepDetail([skip, { step: "pull", phase: "start", at: 2 }, { step: "pull", phase: "done", at: 3, detail: "2 files" }], "pull"))
      .toBe("2 files");
    // A plain rerun keeps the previous real detail (unchanged behaviour).
    expect(stepDetail([{ step: "merge", phase: "done", at: 1, detail: "m1" }, { step: "merge", phase: "start", at: 2 }], "merge")).toBe("m1");
  });

  it("legacy done-skip details are treated as skips too", () => {
    const legacy = { step: "pull", phase: "done", at: 1, detail: `${SIDECAR_UNKNOWN_PREFIX}unreachable` };
    expect(stepDetail([legacy, { step: "pull", phase: "start", at: 2 }], "pull")).toBeUndefined();
  });

  it("web mirrors the core skip prefixes (a rename in core must fail here)", () => {
    for (const prefix of [SIDECAR_SKIP_PREFIX, SIDECAR_UNKNOWN_PREFIX]) {
      const st = deriveStepStatuses({ state: "pending", steps: [{ step: "pull", phase: "done", at: 1, detail: `${prefix}x` }], nodeStates: [] }, ["pull"], 2);
      expect(st.pull.status).toBe("skipped");
    }
  });
});
