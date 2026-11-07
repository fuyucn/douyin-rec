import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { LiveUploadReporter } from "./live-upload-reporter.js";
import { buildZeroDiskReport, liveHistoryPath, liveUploadPath, readLiveHistory, readLiveUploadFile, upsertLiveHistory, type LiveFile } from "./zero-disk-node.js";
import { LIVE_HISTORY_LIMIT, type LiveUploadSnapshot } from "@drec/core";

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
    second.event({ at: 5, kind: "waiting" });
    const beforeAnyEvent = second.read();
    expect(beforeAnyEvent?.current?.state).toBe("waiting");
    expect(beforeAnyEvent?.current?.sessionId).toBeUndefined();
    expect(beforeAnyEvent?.previous?.state).toBe("finished");
    expect(beforeAnyEvent?.previous?.parts).toHaveLength(1);
    expect(beforeAnyEvent?.previous?.bvid).toBe("BVkeep");
  });

  it("two restarts do not let an empty waiting-only run evict the real previous run", () => {
    const a = new LiveUploadReporter({ platform: "douyin", roomSlug: "r7", writeEveryMs: 1 });
    a.event({ at: 1, kind: "run_start", session: session("r7:1", 1) });
    a.event({ at: 2, kind: "part_confirmed", part: 0, bvid: "BVkeep" });
    a.event({ at: 3, kind: "run_end", outcome: "finished" });
    const b = new LiveUploadReporter({ platform: "douyin", roomSlug: "r7", writeEveryMs: 1 });
    b.event({ at: 4, kind: "waiting" });
    b.event({ at: 5, kind: "run_end", outcome: "finished" }); // stopped while waiting, no session
    const c = new LiveUploadReporter({ platform: "douyin", roomSlug: "r7", writeEveryMs: 1 });
    c.event({ at: 6, kind: "waiting" });
    expect(c.read()?.previous?.sessionId).toBe("r7:1");
    expect(c.read()?.previous?.bvid).toBe("BVkeep");
    expect(c.read()?.current?.sessionId).toBeUndefined();
  });

  it("run_resume after a crashed same archive continues the existing parts", () => {
    const path = liveUploadPath("douyin", "r8");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      v: 1, platform: "douyin", roomSlug: "r8", pid: 999_999, updatedAt: 5,
      current: {
        schemaVersion: 1, mode: "zero-disk", sessionId: "r8:1", createdAt: 1,
        platform: "douyin", roomSlug: "r8", state: "stopped", startedAt: 1, updatedAt: 5,
        parts: [{ index: 0, phase: "confirmed", uploadedBytes: 10, chunks: 1 }], events: [],
      },
    } satisfies LiveFile));
    const r = new LiveUploadReporter({ platform: "douyin", roomSlug: "r8", writeEveryMs: 1 });
    r.event({ at: 6, kind: "waiting" });
    r.event({ at: 7, kind: "run_resume", session: { sessionId: "r8:1", createdAt: 1, resumed: true } });
    expect(r.read()?.current?.state).toBe("streaming");
    expect(r.read()?.current?.parts).toHaveLength(1);
  });
});

describe("live run history (issue #413)", () => {
  const snap = (sessionId: string, startedAt: number, state: LiveUploadSnapshot["state"]): LiveUploadSnapshot => ({
    schemaVersion: 1, mode: "zero-disk", sessionId, createdAt: startedAt, platform: "douyin", roomSlug: "h1",
    state, startedAt, updatedAt: startedAt, parts: [], events: [],
  });

  it("keeps a finished run once, even when the terminal state is flushed again", () => {
    const r = new LiveUploadReporter({ platform: "douyin", roomSlug: "h1", writeEveryMs: 1 });
    r.event({ at: 1, kind: "run_start", session: session("h1:1", 1) });
    r.event({ at: 2, kind: "run_end", outcome: "finished" });
    r.event({ at: 3, kind: "run_end", outcome: "finished" });
    const h = readLiveHistory("douyin", "h1");
    expect(h.map((x) => x.sessionId)).toEqual(["h1:1"]);
    expect(h[0].state).toBe("finished");
  });

  it("records a run cut off by a crash as stopped when the next run rotates it away", () => {
    const first = new LiveUploadReporter({ platform: "douyin", roomSlug: "h2", writeEveryMs: 1 });
    first.event({ at: 1, kind: "run_start", session: session("h2:1", 1) });
    first.event({ at: 2, kind: "part_streaming", part: 0 });
    const next = new LiveUploadReporter({ platform: "douyin", roomSlug: "h2", writeEveryMs: 1 });
    next.event({ at: 3, kind: "run_start", session: session("h2:2", 3) });
    const h = readLiveHistory("douyin", "h2");
    expect(h.map((x) => [x.sessionId, x.state])).toEqual([["h2:1", "stopped"]]);
  });

  it("a restart on a crashed run that is still current does not record it as history", () => {
    const path = liveUploadPath("douyin", "h6");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({
      v: 1, platform: "douyin", roomSlug: "h6", pid: 999_999, updatedAt: 5,
      current: {
        schemaVersion: 1, mode: "zero-disk", sessionId: "h6:1", createdAt: 1,
        platform: "douyin", roomSlug: "h6", state: "streaming", startedAt: 1, updatedAt: 5, parts: [], events: [],
      },
    } satisfies LiveFile));
    new LiveUploadReporter({ platform: "douyin", roomSlug: "h6", writeEveryMs: 1 });
    expect(readLiveHistory("douyin", "h6")).toEqual([]);
  });

  it("caps the history at LIVE_HISTORY_LIMIT, newest first", () => {
    for (let i = 1; i <= LIVE_HISTORY_LIMIT + 5; i++) upsertLiveHistory("douyin", "h3", [snap(`h3:${i}`, i, "finished")]);
    const h = readLiveHistory("douyin", "h3");
    expect(h).toHaveLength(LIVE_HISTORY_LIMIT);
    expect(h[0].sessionId).toBe(`h3:${LIVE_HISTORY_LIMIT + 5}`);
  });

  it("skips snapshots without a session and ignores a torn history file", () => {
    upsertLiveHistory("douyin", "h4", [snap("", 1, "finished")].map((x) => ({ ...x, sessionId: undefined })));
    expect(readLiveHistory("douyin", "h4")).toEqual([]);
    const path = liveHistoryPath("douyin", "h4");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "{not json");
    expect(readLiveHistory("douyin", "h4")).toEqual([]);
  });

  it("is carried by the node report next to the current run", () => {
    const r = new LiveUploadReporter({ platform: "douyin", roomSlug: "h5", writeEveryMs: 1 });
    r.event({ at: 1, kind: "run_start", session: session("h5:1", 1) });
    r.event({ at: 2, kind: "run_end", outcome: "finished" });
    const entry = buildZeroDiskReport({ isAlive: () => true }).live?.find((x) => x.roomSlug === "h5");
    expect(entry?.history?.map((x) => x.sessionId)).toEqual(["h5:1"]);
  });
});
