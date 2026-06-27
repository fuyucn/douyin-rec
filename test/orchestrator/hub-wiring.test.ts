import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHub } from "@drec/orchestrator";

describe("startHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls reconcileAll after settle period when recording stops", async () => {
    const reconcileAll = vi.fn().mockResolvedValue(undefined);
    let recording = true;
    const stop = startHub({
      tasks: () => [{ id: 1 }],
      isRecording: () => recording,
      reconcileAll,
      settleMs: 5000,
      pollMs: 1000,
      reconcileIntervalMs: 60000,
    });

    // advance polls while recording
    await vi.advanceTimersByTimeAsync(3000);
    expect(reconcileAll).not.toHaveBeenCalled();

    // stop recording
    recording = false;
    await vi.advanceTimersByTimeAsync(3000); // poll fires, sees false
    expect(reconcileAll).not.toHaveBeenCalled(); // settleMs not elapsed yet

    // advance past settle
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcileAll).toHaveBeenCalled();

    stop();
  });

  it("does NOT trigger if recording resumes before settle", async () => {
    const reconcileAll = vi.fn().mockResolvedValue(undefined);
    let recording = true;
    const stop = startHub({
      tasks: () => [{ id: 1 }],
      isRecording: () => recording,
      reconcileAll,
      settleMs: 5000,
      pollMs: 1000,
      reconcileIntervalMs: 60000,
    });

    recording = false;
    await vi.advanceTimersByTimeAsync(3000); // polls see false, debouncer starts
    recording = true;
    await vi.advanceTimersByTimeAsync(8000); // advance past settle, but now recording=true
    expect(reconcileAll).not.toHaveBeenCalled();

    stop();
  });

  it("calls reconcileAll on periodic interval", async () => {
    const reconcileAll = vi.fn().mockResolvedValue(undefined);
    const stop = startHub({
      tasks: () => [],
      isRecording: () => false,
      reconcileAll,
      settleMs: 5000,
      pollMs: 1000,
      reconcileIntervalMs: 10000,
    });

    await vi.advanceTimersByTimeAsync(25000);
    expect(reconcileAll.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});
