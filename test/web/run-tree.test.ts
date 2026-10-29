import { describe, expect, it } from "vitest";
import { liveNode, partSteps, pipelineTree, rollingNode } from "../../packages/web/src/lib/run-tree.js";
import type { HubJobDTO, RollingDeliveryDTO } from "../../packages/web/src/api/client.js";
import type { LiveUploadSnapshot } from "../../packages/core/src/live-upload.js";

const MiB = 1024 * 1024;

function job(patch: Partial<HubJobDTO> = {}): HubJobDTO {
  return {
    streamKey: "douyin:1:2026-10-29", state: "merging", winnerWorker: "a", candidates: [], bv: null, error: null, fails: 0,
    updatedAt: 1, startedAt: 1, events: [], steps: [], nodeStates: [], currentStepSec: null, etaSec: null,
    videoDurationSec: null, hasLog: false, ...patch,
  };
}

function snap(patch: Partial<LiveUploadSnapshot> = {}): LiveUploadSnapshot {
  return { schemaVersion: 1, mode: "live", platform: "douyin", roomSlug: "1", state: "streaming", startedAt: 1, updatedAt: 1, parts: [], events: [], ...patch } as LiveUploadSnapshot;
}

describe("partSteps", () => {
  it("walks stream -> seal -> submit -> confirm by phase", () => {
    expect(partSteps("streaming").map((s) => s.state)).toEqual(["running", "waiting", "waiting", "waiting"]);
    expect(partSteps("submitting").map((s) => s.state)).toEqual(["done", "done", "running", "waiting"]);
    expect(partSteps("confirmed").every((s) => s.state === "done")).toBe(true);
    expect(partSteps("unconfirmed")[3].state).toBe("unknown");
    expect(partSteps("failed")[2].state).toBe("failed");
  });
});

describe("liveNode", () => {
  it("folds confirmed parts and keeps the current part open with its byte progress", () => {
    const n = liveNode(snap({
      parts: [{ index: 0, phase: "confirmed", uploadedBytes: 10, bytes: 10, chunks: 1 }, { index: 1, phase: "confirmed", uploadedBytes: 10, bytes: 10, chunks: 1 }],
      currentPart: { index: 2, phase: "streaming", uploadedBytes: 150 * MiB, bytes: 1540 * MiB, chunks: 3 },
    }), "a", "A", "winner");
    expect(n.parts.map((p) => [p.index, p.collapsed])).toEqual([[0, true], [1, true], [2, false]]);
    expect(n.confirmed).toBe(2);
    expect(n.parts[2]).toMatchObject({ state: "running", bytes: 150 * MiB, capBytes: 1540 * MiB });
  });

  it("keeps a failed part open and red", () => {
    const n = liveNode(snap({ parts: [{ index: 0, phase: "failed", uploadedBytes: 1, chunks: 1 }] }), "a", "A", "winner");
    expect(n.parts[0]).toMatchObject({ state: "failed", collapsed: false });
  });
});

describe("rollingNode", () => {
  it("has counts only: the uploading segment is the single open row, the rest are counts", () => {
    const rows = [{ workerId: "a", workerName: "A", platform: "douyin", roomSlug: "1", anchorName: null, sessionBase: "s", bv: null, confirmed: 2, total: 5, ambiguous: 1, uploading: { index: 2, kind: "append" }, recording: true, checkedAt: 1 }] as RollingDeliveryDTO[];
    const n = rollingNode(rows, "a", "A", "winner");
    expect(n.confirmed).toBe(2);
    expect(n.pending).toBe(1);
    expect(n.parts).toHaveLength(1);
    expect(n.parts[0].steps[2].state).toBe("running");
  });
});

describe("pipelineTree", () => {
  const name = (id: string): string => `n-${id}`;

  it("reads step states from node states first, then from step events", () => {
    const t = pipelineTree(job({
      steps: [{ step: "pull", phase: "done", at: 1 }, { step: "merge", phase: "start", at: 2 }],
      nodeStates: [{ node: "burn_danmu", state: "failed", error: "x", attempts: 1, updatedAt: 1 }],
    }), { steps: {}, upload: { mode: "stage" } }, name);
    const by = Object.fromEntries(t.steps.map((s) => [s.key, s.state]));
    expect(by.pull).toBe("done");
    expect(by.merge).toBe("running");
    expect(by.burn_danmu).toBe("failed");
  });

  it("does not invent state: a finished old run without records shows unknown, a running one waiting", () => {
    const done = pipelineTree(job({ state: "done" }), undefined, name);
    expect(done.steps.every((s) => s.state === "unknown")).toBe(true);
    const running = pipelineTree(job({ state: "pending" }), undefined, name);
    expect(running.steps.every((s) => s.state === "waiting")).toBe(true);
  });

  it("maps candidates with friendly names and marks the winner", () => {
    const t = pipelineTree(job({ candidates: [
      { worker: "a", coverage: 1, durationSec: 3600, complete: true, isWinner: true },
      { worker: "b", coverage: 0.9, durationSec: 3500, complete: false, isWinner: false },
    ] }), undefined, name);
    expect(t.candidates.map((c) => [c.name, c.winner])).toEqual([["n-a", true], ["n-b", false]]);
    expect(t.selectState).toBe("done");
  });

  it("uses the node-side chain without pull/merge for a node upload run", () => {
    const t = pipelineTree(job({ steps: [{ step: "node_upload", phase: "start", at: 1 }] }), undefined, name);
    expect(t.steps.map((s) => s.key)).toContain("node_upload");
    expect(t.steps.map((s) => s.key)).not.toContain("pull");
  });
});
