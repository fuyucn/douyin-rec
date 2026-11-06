/**
 * RecordingSession → recorder state file phases (plans/044 Task 2, file / rolling modes).
 * The `[状态]` emission points are the single place that also updates the state file.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingSession } from "@drec/manager";
import type { RollingUploadHook } from "@drec/manager";
import {
  initRecorderState, resetRecorderStateForTest,
  type Recorder, type RecorderEvents, type RecordOpts, type RecorderStateFile,
} from "@drec/core";

const opts = (outDir: string): RecordOpts => ({ quality: "origin", outDir, segmentSec: 0 });

let writes: RecorderStateFile[];
beforeEach(() => {
  writes = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
  initRecorderState({
    root: "/unused", taskId: 1, platform: "douyin", roomSlug: "123", mode: "rolling",
    owner: { pid: 1, startTicks: 1, bootId: "b" },
    write: (_f, d) => { writes.push(JSON.parse(d) as RecorderStateFile); },
  });
});
afterEach(() => {
  resetRecorderStateForTest();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const trail = (): string[] => {
  const out: string[] = [];
  for (const w of writes) {
    const s = `${w.phase}/${w.session ?? "-"}`;
    if (out[out.length - 1] !== s) out.push(s);
  }
  return out;
};

describe("RecordingSession state file phases", () => {
  it("polling until the recorder reports live; recording once the stream is pulled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sess-state-"));
    let ev!: RecorderEvents;
    const rec: Recorder = {
      name: "mock", providesDanmu: true,
      async start(_u, _o, e) { ev = e; },
      async stop() {},
    };
    const sess = new RecordingSession(rec, { danmuEnabled: false });
    await sess.start("https://live.douyin.com/123", opts(dir), { anchorName: "" });
    expect(trail()).toEqual(["polling/-"]);
    ev.onLive({ anchorName: "A" });
    expect(trail()).toEqual(["polling/-", "recording/-"]);
    ev.onSegment(join(dir, "s1_000.ts"));
    expect(trail().at(-1)).toBe("recording/s1");
    await sess.stop();
  });

  it("session rotation: finalizing while the tail hook runs, then polling with no session, then the new session only", async () => {
    vi.useFakeTimers();
    const dir = mkdtempSync(join(tmpdir(), "sess-state-"));
    let n = 0;
    let ev!: RecorderEvents;
    const rec: Recorder = {
      name: "mock", providesDanmu: true,
      async start(_u, o, e) {
        n++;
        ev = e;
        e.onLive({ anchorName: "A" });
        e.onSegment(join(o.outDir, `s${n}_000.ts`));
      },
      async stop() {},
    };
    let releaseTail!: () => void;
    const hooks: RollingUploadHook[] = [];
    const makeRolling = (): RollingUploadHook => {
      const h: RollingUploadHook = {
        onSegment() {},
        onSessionEnd: () => new Promise<void>((r) => { releaseTail = r; }),
      };
      hooks.push(h);
      return h;
    };
    const sess = new RecordingSession(rec, { danmuEnabled: false, reconnectDelaySec: 0.01, makeRolling });
    await sess.start("https://live.douyin.com/123", opts(dir), { anchorName: "" });
    expect(trail().at(-1)).toBe("recording/s1");

    ev.onOffline();
    await vi.advanceTimersByTimeAsync(0);
    // Pulling stopped but the tail of s1 is still being handled: not recording, not idle.
    expect(trail().at(-1)).toBe("finalizing/s1");

    releaseTail();
    await vi.advanceTimersByTimeAsync(0);
    expect(trail().at(-1)).toBe("polling/-"); // reconnect wait: nothing of s1 is marked active any more
    await vi.runAllTimersAsync();
    expect(n).toBe(2);

    expect(trail()).toEqual([
      "polling/-", "recording/-", "recording/s1", "finalizing/s1", "polling/-", "recording/-", "recording/s2",
    ]);
    const afterS2 = trail().slice(trail().indexOf("recording/s2"));
    expect(afterS2.some((s) => s.endsWith("/s1"))).toBe(false);

    const stopped = sess.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(trail().at(-1)).toBe("finalizing/s2");
    releaseTail();
    await stopped;
  });
});
