import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveDbPath, resolveServeDbPath } from "../../packages/app/src/db.js";
import { DEFAULT_ROOT } from "../../packages/app/src/paths.js";
import { NodeRecordSpawner } from "../../packages/app/src/process/spawner.js";
import type { Task } from "../../packages/app/src/store.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const task: Task = {
  id: 1, room: "12345", name: "anchor", quality: "origin", engine: "ffmpeg", danmu: 0,
  segmentSec: 1800, cookies: null, outDir: null, scheduleStart: null, scheduleEnd: null,
  status: "stopped", useCookie: false, rollingUpload: false, rollingEffective: false,
  streamUpload: false, streamUploadSpool: true, createdAt: "2026-06-12T00:00:00.000Z",
};

let previousRoot: string | undefined;
let previousDb: string | undefined;
let temp: string;

beforeEach(() => {
  temp = mkdtempSync(join(tmpdir(), "drec-db-path-"));
  previousRoot = process.env.DOUYIN_REC_ROOT;
  previousDb = process.env.DOUYIN_REC_DB;
  delete process.env.DOUYIN_REC_ROOT;
  delete process.env.DOUYIN_REC_DB;
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.DOUYIN_REC_ROOT;
  else process.env.DOUYIN_REC_ROOT = previousRoot;
  if (previousDb === undefined) delete process.env.DOUYIN_REC_DB;
  else process.env.DOUYIN_REC_DB = previousDb;
  rmSync(temp, { recursive: true, force: true });
});

describe("默认数据根（生产约定）", () => {
  it("未设 DOUYIN_REC_ROOT → 家目录下的 drec/（跨平台同一规则）", () => {
    // 只断言纯值，不碰真实目录：macOS/Linux = $HOME/drec，Windows = %USERPROFILE%\drec。
    expect(DEFAULT_ROOT).toBe(join(homedir(), "drec"));
  });

  it("设了 DOUYIN_REC_ROOT 就按 env（默认值不抢戏）", () => {
    const saved = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = "/tmp/somewhere";
    try { expect(resolveDbPath(undefined)).toBe("/tmp/somewhere/db/douyin-rec.db"); }
    finally { if (saved === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = saved; }
  });
});

describe("serve database path resolution", () => {
  it.each([
    ["默认根", undefined, undefined, undefined],
    ["仅 DOUYIN_REC_ROOT", undefined, undefined, "root-only"],
    ["仅 DOUYIN_REC_DB", undefined, "db-only.db", undefined],
    ["仅 serve --db", "serve.db", undefined, undefined],
    ["--db 优先于 env", "explicit.db", "ignored.db", undefined],
  ] as const)("$0", (_label, serveDb, envDb, rootName) => {
    if (envDb) process.env.DOUYIN_REC_DB = join(temp, envDb);
    if (rootName) process.env.DOUYIN_REC_ROOT = join(temp, rootName);
    const explicit = serveDb ? join(temp, serveDb) : undefined;
    const expected = explicit
      ? resolve(temp, serveDb!)
      : envDb
        ? resolve(temp, envDb)
        : rootName
          ? resolve(temp, rootName, "db/douyin-rec.db")
          : resolve(DEFAULT_ROOT, "db/douyin-rec.db");
    expect(resolveServeDbPath(explicit)).toBe(expected);
    expect(resolveDbPath(explicit)).toBe(explicit ?? (envDb ? join(temp, envDb) : rootName ? join(temp, rootName, "db/douyin-rec.db") : join(DEFAULT_ROOT, "db/douyin-rec.db")));
  });

  it("fake recording child receives serve's resolved path without mutating the parent env", async () => {
    const childDb = resolveServeDbPath(join(temp, "serve.db"));
    process.env.DOUYIN_REC_DB = "parent-value.db";
    const entry = join(temp, "fake-child.mjs");
    const dump = join(temp, "child-env.json");
    writeFileSync(entry, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(dump)}, JSON.stringify({ db: process.env.DOUYIN_REC_DB }));`);
    const proc = new NodeRecordSpawner({ cliEntry: entry, dbPath: childDb }).spawn(task);
    let exited = false;
    proc.onExit(() => { exited = true; });
    proc.start();
    for (let i = 0; i < 100 && !exited; i += 1) await wait(10);
    expect(existsSync(dump)).toBe(true);
    expect(JSON.parse(readFileSync(dump, "utf8")) as { db: string }).toEqual({ db: childDb });
    expect(process.env.DOUYIN_REC_DB).toBe("parent-value.db");
  });
});

vi.mock("@drec/orchestrator", () => ({
  recordStreamUpload: vi.fn(() => ({ ok: true, bvid: "BV-test" })),
}));

describe("stream-upload ledger database path", () => {
  it("uses resolveDbPath for every local path variant and does not upload", async () => {
    const previousCwd = process.cwd();
    process.chdir(temp);
    try {
      const { recordStreamUpload } = await import("@drec/orchestrator");
      const { createStreamUploadLifecycle } = await import("../../packages/cli/src/stream-upload-lifecycle.js");
      const platform = { id: "douyin" } as Parameters<typeof createStreamUploadLifecycle>[0]["platform"];
      const cases = [
        [undefined, undefined],
        [join(temp, "root"), undefined],
        [undefined, join(temp, "env.db")],
        [join(temp, "root"), join(temp, "serve.db")],
        [join(temp, "root"), join(temp, "explicit.db")],
      ] as const;
      for (const [root, db] of cases) {
        if (root) process.env.DOUYIN_REC_ROOT = root; else delete process.env.DOUYIN_REC_ROOT;
        if (db) process.env.DOUYIN_REC_DB = db; else delete process.env.DOUYIN_REC_DB;
        const lifecycle = createStreamUploadLifecycle({
          platform, roomSlug: "room", delivery: undefined, uploadCookies: "", streamMeta: {},
          notifier: { notify: vi.fn().mockResolvedValue(undefined) },
        } as never);
        await lifecycle.finish({
          ok: true, outcome: "uploaded", bvid: "BV-test", title: "test", spoolDir: temp,
          statePath: join(temp, "state.json"), segments: [{ uploadError: false }],
        } as never, 1_700_000_000_000);
        lifecycle.dispose();
      }
      expect(recordStreamUpload).toHaveBeenCalledTimes(cases.length);
      const calls = vi.mocked(recordStreamUpload).mock.calls;
      expect(calls.map(([input]) => input.syncDbPath)).toEqual([
        join(DEFAULT_ROOT, "db/douyin-rec-sync.db"),
        resolve(temp, "root/db/douyin-rec-sync.db"),
        resolve(temp, "env-sync.db"),
        resolve(temp, "serve-sync.db"),
        resolve(temp, "explicit-sync.db"),
      ]);
    } finally {
      process.chdir(previousCwd);
    }
  });

  it("keeps delivered zero-disk runs on their existing receipt reporter", async () => {
    const { recordStreamUpload } = await import("@drec/orchestrator");
    const before = vi.mocked(recordStreamUpload).mock.calls.length;
    process.env.DOUYIN_REC_ROOT = temp;
    const { createStreamUploadLifecycle } = await import("../../packages/cli/src/stream-upload-lifecycle.js");
    const lifecycle = createStreamUploadLifecycle({
      platform: { id: "douyin" }, roomSlug: "delivered-room", delivery: {}, uploadCookies: "",
      streamMeta: {}, notifier: { notify: vi.fn().mockResolvedValue(undefined) },
    } as never);
    await lifecycle.finish({
      ok: true, outcome: "uploaded", bvid: "BV-delivered", title: "test", spoolDir: temp,
      statePath: join(temp, "state.json"), segments: [{ uploadError: false }],
    } as never, 1_700_000_000_000);
    lifecycle.dispose();
    expect(vi.mocked(recordStreamUpload).mock.calls).toHaveLength(before);
  });

});
