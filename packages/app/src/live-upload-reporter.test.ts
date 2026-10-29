import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LiveUploadReporter } from "./live-upload-reporter.js";
import { liveUploadPath, readLiveUploadFile, type LiveFile } from "./zero-disk-node.js";

const prevRoot = process.env.DOUYIN_REC_ROOT;
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "live-report-"));
  process.env.DOUYIN_REC_ROOT = root;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT;
  else process.env.DOUYIN_REC_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

const session = (id: string, createdAt: number) => ({ sessionId: id, createdAt, resumed: false });

describe("LiveUploadReporter", () => {
  it("writes throttled snapshots and flushes terminal events", () => {
    const writes: LiveFile[] = [];
    const r = new LiveUploadReporter({
      platform: "douyin", roomSlug: "r1", writeEveryMs: 60_000,
      write: (_p, v) => writes.push(v as LiveFile),
    });
    r.event({ at: 1, kind: "run_start", session: session("r1:1", 1) });
    const afterStart = writes.length;
    r.event({ at: 2, kind: "part_streaming", part: 0 });
    expect(writes.length).toBe(afterStart); // throttled
    r.event({ at: 3, kind: "part_confirmed", part: 0 });
    expect(writes.length).toBe(afterStart + 1); // terminal flush
    expect(writes.at(-1)?.current?.parts[0]?.phase).toBe("confirmed");
  });

  it("new session rotates current to previous", () => {
    const writes: LiveFile[] = [];
    const r = new LiveUploadReporter({
      platform: "douyin", roomSlug: "r2", writeEveryMs: 1,
      write: (_p, v) => writes.push(v as LiveFile),
    });
    r.event({ at: 1, kind: "run_start", session: session("r2:1", 1) });
    r.event({ at: 2, kind: "run_end", outcome: "finished" });
    r.event({ at: 3, kind: "run_start", session: session("r2:2", 2) });
    expect(writes.at(-1)?.previous?.sessionId).toBe("r2:1");
    expect(writes.at(-1)?.current?.sessionId).toBe("r2:2");
  });

  it("a dead pid turns a non-terminal current into stopped", () => {
    const path = liveUploadPath("douyin", "r3");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      v: 1, platform: "douyin", roomSlug: "r3", pid: 999_999, updatedAt: 5,
      current: {
        schemaVersion: 1, mode: "zero-disk", sessionId: "r3:1", createdAt: 1,
        platform: "douyin", roomSlug: "r3", state: "streaming", startedAt: 1, updatedAt: 5, parts: [], events: [],
      },
    } satisfies LiveFile));
    expect(readLiveUploadFile(path, { isAlive: () => false })?.current?.state).toBe("stopped");
  });

  it("a finished run with a dead pid stays finished", () => {
    const path = liveUploadPath("douyin", "r4");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      v: 1, platform: "douyin", roomSlug: "r4", pid: 999_999, updatedAt: 5,
      current: {
        schemaVersion: 1, mode: "zero-disk", sessionId: "r4:1", createdAt: 1,
        platform: "douyin", roomSlug: "r4", state: "finished", startedAt: 1, updatedAt: 5, parts: [], events: [],
      },
    } satisfies LiveFile));
    expect(readLiveUploadFile(path, { isAlive: () => false })?.current?.state).toBe("finished");
  });

  it("write errors are swallowed", () => {
    const r = new LiveUploadReporter({
      platform: "douyin", roomSlug: "r5", writeEveryMs: 1,
      write: () => { throw new Error("disk full"); },
    });
    expect(() => r.event({ at: 1, kind: "run_end", outcome: "finished" })).not.toThrow();
  });

  it("a new reporter preserves a finished run instead of overwriting it with waiting", () => {
    const first = new LiveUploadReporter({ platform: "douyin", roomSlug: "r6", writeEveryMs: 1 });
    first.event({ at: 1, kind: "run_start", session: session("r6:1", 1) });
    first.event({ at: 2, kind: "part_streaming", part: 0 });
    first.event({ at: 3, kind: "part_confirmed", part: 0, bvid: "BVkeep" });
    first.event({ at: 4, kind: "run_end", outcome: "finished" });
    const second = new LiveUploadReporter({ platform: "douyin", roomSlug: "r6", writeEveryMs: 1 });
    const beforeAnyEvent = second.read();
    expect(beforeAnyEvent?.current?.state).toBe("finished");
    expect(beforeAnyEvent?.current?.parts).toHaveLength(1);
    expect(beforeAnyEvent?.current?.bvid).toBe("BVkeep");
  });
});
