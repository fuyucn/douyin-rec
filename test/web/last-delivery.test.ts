import { describe, it, expect } from "vitest";
import { ageOf, lastDelivery } from "../../packages/web/src/lib/last-delivery.js";
import { roomStatus, type LatestRun } from "../../packages/web/src/lib/room-status.js";
import type { Task } from "../../packages/web/src/api/client.js";

const run = (state: string, extra: Partial<LatestRun> = {}): LatestRun => ({ state, bv: null, updatedAt: 1000, ...extra });

describe("lastDelivery", () => {
  it("no run → none", () => {
    expect(lastDelivery(null)).toEqual({ kind: "none", bv: null, at: null });
    expect(lastDelivery(undefined).kind).toBe("none");
  });

  it("in-flight run → running", () => {
    for (const s of ["pending", "syncing", "merging", "uploading", "retrying"]) expect(lastDelivery(run(s)).kind).toBe("running");
  });

  it("done with a submission → uploaded + bv; done without → archived", () => {
    expect(lastDelivery(run("done", { bv: "BV1x" }))).toEqual({ kind: "uploaded", bv: "BV1x", at: 1000 });
    expect(lastDelivery(run("done")).kind).toBe("archived");
  });

  it("needs_manual follows the same benign/fault verdict as the status column", () => {
    expect(lastDelivery(run("needs_manual", { manualPhase: "waiting_upload" })).kind).toBe("archived");
    expect(lastDelivery(run("needs_manual", { manualPhase: "stopped" })).kind).toBe("stopped");
    expect(lastDelivery(run("needs_manual", { manualPhase: "waiting_manual" })).kind).toBe("fault");
    // old master without the field → fault, like roomStatus
    expect(lastDelivery(run("needs_manual")).kind).toBe("fault");
    expect(lastDelivery(run("failed")).kind).toBe("fault");
  });

  it("never contradicts roomStatus: 'attention' ⇔ delivery fault (for idle, enabled rooms)", () => {
    const task = { id: 1, enabled: true, status: "stopped", running: false, recording: false, recordingWorkers: [] } as unknown as Task;
    const room = { recording: null, processing: { enabled: true } as never };
    const cases = [
      run("failed"), run("needs_manual"), run("needs_manual", { manualPhase: "waiting_upload" }),
      run("needs_manual", { manualPhase: "stopped" }), run("needs_manual", { manualPhase: "waiting_manual" }), run("done", { bv: "B" }),
    ];
    for (const r of cases) {
      expect(roomStatus(room, task, r).kind === "attention").toBe(lastDelivery(r).kind === "fault");
    }
  });
});

describe("ageOf", () => {
  const at = 1_000_000;
  it("buckets into now / minutes / hours / days", () => {
    expect(ageOf(at + 30_000, at)).toEqual({ unit: "now", n: 0 });
    expect(ageOf(at + 5 * 60_000, at)).toEqual({ unit: "m", n: 5 });
    expect(ageOf(at + 3 * 3600_000 + 59_000, at)).toEqual({ unit: "h", n: 3 });
    expect(ageOf(at + 2 * 86400_000, at)).toEqual({ unit: "d", n: 2 });
  });
  it("bucket boundaries are exact (59 min vs 1 h, 23 h vs 1 d)", () => {
    expect(ageOf(at + 3599_000, at)).toEqual({ unit: "m", n: 59 });
    expect(ageOf(at + 3600_000, at)).toEqual({ unit: "h", n: 1 });
    expect(ageOf(at + 86399_000, at)).toEqual({ unit: "h", n: 23 });
    expect(ageOf(at + 86400_000, at)).toEqual({ unit: "d", n: 1 });
    expect(ageOf(at + 59_000, at).unit).toBe("now");
    expect(ageOf(at + 60_000, at)).toEqual({ unit: "m", n: 1 });
  });
  it("a clock skew (at in the future) does not go negative", () => {
    expect(ageOf(at - 10_000, at)).toEqual({ unit: "now", n: 0 });
  });
});
