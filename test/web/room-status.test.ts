import { describe, it, expect } from "vitest";
import { lastRunHint, latestRunKey, roomStatus, sortByStatus, type LatestRun } from "../../packages/web/src/lib/room-status.js";
import type { RoomDTO, Task } from "../../packages/web/src/api/client.js";

type Room = Pick<RoomDTO, "processing" | "recording">;
const room = (procEnabled: boolean | null = true): Room =>
  ({ recording: null, processing: procEnabled === null ? null : ({ enabled: procEnabled } as RoomDTO["processing"]) });
const task = (p: Partial<Task> = {}): Task =>
  ({ id: 1, enabled: true, status: "stopped", running: false, recording: false, recordingWorkers: [], ...p }) as Task;
const run = (state: string): LatestRun => ({ state, bv: null, updatedAt: 1 });
const w = (state: "recording" | "not_recording" | "unavailable") => ({ workerId: "n1", workerName: "n1", state, checkedAt: 1 });

describe("latestRunKey", () => {
  it("uses the colon form latest-runs groups by (not the dot room key)", () => {
    expect(latestRunKey({ platform: "douyin", roomSlug: "123" })).toBe("douyin:123");
  });
});

describe("roomStatus", () => {
  it("live recording wins over an in-flight run of the previous session", () => {
    expect(roomStatus(room(), task({ running: true, recording: true }), run("merging")).kind).toBe("recording");
    expect(roomStatus(room(), task({ recordingWorkers: [w("recording")] }), run("uploading")).kind).toBe("recording");
  });

  it("draining / stopping still count as recording (stream still being written)", () => {
    expect(roomStatus(room(), task({ status: "draining", running: true, recording: true }), null).kind).toBe("recording");
    expect(roomStatus(room(), task({ stopping: true, running: true }), null).kind).toBe("recording");
  });

  it("recording faults surface as attention even while a run is processing", () => {
    expect(roomStatus(room(), task({ recordingWorkers: [w("unavailable")] }), run("merging")).kind).toBe("attention");
    expect(roomStatus(room(), task({ status: "error" }), null).kind).toBe("attention");
  });

  it("every non-terminal run state is processing (incl. retrying)", () => {
    for (const s of ["pending", "settling", "syncing", "merging", "uploading", "retrying"]) {
      expect(roomStatus(room(), task(), run(s)).kind).toBe("processing");
    }
  });

  it("failed / needs_manual latest run → attention; done → waiting", () => {
    expect(roomStatus(room(), task(), run("failed")).kind).toBe("attention");
    expect(roomStatus(room(), task(), run("needs_manual")).kind).toBe("attention");
    expect(roomStatus(room(), task(), run("done")).kind).toBe("waiting");
  });

  it("needs_manual that is benign (stage close-out / user stop) is NOT attention", () => {
    const m = (manualPhase: string | null): LatestRun => ({ state: "needs_manual", bv: null, updatedAt: 1, manualPhase });
    expect(roomStatus(room(), task(), m("waiting_upload")).kind).toBe("waiting");
    expect(roomStatus(room(), task(), m("stopped")).kind).toBe("waiting");
    expect(roomStatus(room(), task(), m("waiting_manual")).kind).toBe("attention");
    // old master (no manualPhase) keeps the previous behaviour
    expect(roomStatus(room(), task(), m(null)).kind).toBe("attention");
    expect(roomStatus(room(), task(), run("needs_manual")).kind).toBe("attention");
  });

  it("a disabled task keeps showing its in-flight run (processing is independent of the switch)", () => {
    expect(roomStatus(room(), task({ enabled: false }), run("merging")).kind).toBe("processing");
  });

  it("a switched-off room with a stale failed run is paused, not attention", () => {
    expect(roomStatus(room(), task({ enabled: false }), run("needs_manual")).kind).toBe("paused");
    expect(roomStatus(room(false), task(), run("failed")).kind).toBe("paused");
  });

  it("paused: rule disabled, task disabled, or no task at all", () => {
    expect(roomStatus(room(false), task(), run("done")).kind).toBe("paused");
    expect(roomStatus(room(), task({ enabled: false }), null).kind).toBe("paused");
    expect(roomStatus(room(null), undefined, null).kind).toBe("paused");
  });

  it("enabled and idle (no rule yet) → waiting", () => {
    expect(roomStatus(room(null), task({ running: true, recording: false }), null).kind).toBe("waiting");
  });
});

describe("sortByStatus", () => {
  it("orders attention > recording > processing > waiting > paused, stable within a kind", () => {
    const kinds = ["paused", "waiting", "recording", "attention", "waiting2", "processing"];
    const statusOf = (k: string) => ({ kind: k.replace(/\d$/, "") as never, phase: null, run: null });
    expect(sortByStatus(kinds, statusOf)).toEqual(["attention", "recording", "processing", "waiting", "waiting2", "paused"]);
  });
});

describe("lastRunHint (status-line suffix)", () => {
  it("says nothing without a run", () => {
    expect(lastRunHint(null)).toBeNull();
  });
  it("a published BV wins", () => {
    expect(lastRunHint({ state: "done", bv: "BV1x", updatedAt: 1 })).toEqual({ kind: "bv" });
  });
  it("faults are named: failed, or needs_manual without a benign phase (legacy rows included)", () => {
    expect(lastRunHint(run("failed"))).toEqual({ kind: "state", state: "failed" });
    expect(lastRunHint(run("needs_manual"))).toEqual({ kind: "state", state: "needs_manual" });
    expect(lastRunHint({ ...run("needs_manual"), manualPhase: "other" })).toEqual({ kind: "state", state: "needs_manual" });
  });
  it("benign endings stay silent: stage close-out, user stop, plain done", () => {
    expect(lastRunHint({ ...run("needs_manual"), manualPhase: "waiting_upload" })).toBeNull();
    expect(lastRunHint({ ...run("needs_manual"), manualPhase: "stopped" })).toBeNull();
    expect(lastRunHint(run("done"))).toBeNull();
  });
});
