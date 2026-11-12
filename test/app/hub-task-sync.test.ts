/**
 * task-sync.test.ts — the hub task reconcile loop, extracted in plan 050.3.
 *
 * The loop used to be untestable (it lives in the hub starter's start()). These cases pin the
 * parts that are easy to break silently: the local hard stop with the "stop after this stream"
 * exception, the receipt write on failure, and the skip-reason warning dedupe.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { readSyncError } from "../../packages/app/src/sync-receipt.js";
import { setReceiptSettings, hubSyncGate } from "../../packages/hub-compose/src/hub-runtime.js";
import { createTaskSync, type TaskSyncDeps } from "../../packages/hub-compose/src/task-sync.js";
import type { CookieSync } from "../../packages/hub-compose/src/cookie-sync.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";
import type { ApplyTasksResult, RemoteTaskSpec } from "../../packages/core/src/worker-contract.js";

const spec = (roomSlug: string, extra: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
  platform: "douyin",
  roomSlug,
  room: roomSlug,
  name: null,
  quality: "origin",
  engine: "ffmpeg",
  danmu: 0,
  segmentSec: 0,
  scheduleStart: null,
  scheduleEnd: null,
  enabled: true,
  useCookie: false,
  cookies: null,
  outDir: null,
  webhook: null,
  anchorName: null,
  rollingUpload: false,
  ...extra,
});

const result = (over: Partial<ApplyTasksResult> = {}): ApplyTasksResult => ({
  applied: [],
  removed: [],
  pending: [],
  ...over,
});

const noCookies: CookieSync = {
  beginRound: () => ({ payload: { platformCookies: {} }, fingerprint: "empty", hasCookies: false }),
  pushTo: async () => {},
};

describe("createTaskSync", () => {
  let dir: string;
  let store: TaskStore;
  let warns: string[];
  let logs: string[];
  let stopped: number[];
  let applied: Array<{ desired: RemoteTaskSpec[]; force?: boolean }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "task-sync-"));
    store = new TaskStore(join(dir, "tasks.db"));
    warns = [];
    logs = [];
    stopped = [];
    applied = [];
    hubSyncGate.unbind();
    setReceiptSettings(undefined);
  });

  afterEach(() => {
    hubSyncGate.unbind();
    setReceiptSettings(undefined);
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const makeSync = (opts: {
    kind?: string;
    specs?: RemoteTaskSpec[];
    apply?: () => Promise<ApplyTasksResult>;
  } = {}) => {
    const transport = {
      id: "w1",
      applyTasks: async (input: { desired: RemoteTaskSpec[]; force?: boolean }) => {
        applied.push(input);
        return opts.apply ? opts.apply() : result({ applied: ["douyin:1"] });
      },
    } as unknown as Transport;
    const deps: TaskSyncDeps = {
      store,
      manager: {
        isRunning: (id: number) => store.listTasks().some((t) => t.id === id),
        requestStop: (id: number) => { stopped.push(id); },
      },
      warn: (m) => warns.push(m),
      log: (m) => logs.push(m),
      hubDir: () => dir,
      desiredFor: () => opts.specs ?? [spec("1")],
      workers: () => [{ id: "w1", kind: opts.kind ?? "remote" }],
      transports: () => new Map([["w1", transport]]),
      cookieSync: noCookies,
      beginRound: async () => [],
      finishRound: async () => {},
    };
    return createTaskSync(deps);
  };

  it("force 来自闸门:带 force 的一轮会打到 applyTasks", async () => {
    const sync = makeSync();
    await sync({ force: true });
    expect(applied).toHaveLength(1);
    expect(applied[0].force).toBe(true);
    expect(logs.join("\n")).toContain("applied");
  });

    it("本机 pending 硬停,但 enabled=false + drain=true 的条目跳过", async () => {
    const plain = store.addTask({ room: "1" });
    const draining = store.addTask({ room: "2" });
    const sync = makeSync({
      kind: "local",
      specs: [spec("1"), spec("2", { enabled: false, drain: true })],
      apply: async () => result({ pending: ["douyin:1", "douyin:2"] }),
    });
    await sync();
    expect(stopped).toEqual([plain.id]);
    expect(stopped).not.toContain(draining.id);
    expect(logs.join("\n")).toContain("douyin:2 排空中");
  });

  it("applyTasks 抛错 → 原因进 syncError 回执,且不向调用方抛出", async () => {
    setReceiptSettings(store);
    const sync = makeSync({ apply: async () => { throw new Error("ssh timeout"); } });
    await sync();
    expect(readSyncError(store, "w1")).toBe("ssh timeout");
    expect(warns.join("\n")).toContain("[hub] 任务同步 w1 失败: ssh timeout");
  });

  it("节点跳过坏配置 → 同一组原因只告警一次", async () => {
    const skipped = [{ index: 0, reason: "bad room" }];
    const sync = makeSync({ apply: async () => result({ skipped }) });
    await sync();
    await sync();
    expect(warns.filter((m) => m.includes("节点跳过")).length).toBe(1);
  });
});
