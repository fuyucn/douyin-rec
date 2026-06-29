import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reconciler, type ReconcilerDeps } from "./reconciler.js";
import { SyncLedger } from "./ledger.js";
import type { Transport, NodeRecording, NodeInventory } from "./transport.js";
import type { PipelineDeps } from "./pipeline.js";
import type { Broadcast } from "./identity.js";
import type { JobState } from "./ledger.js";
import type { NotifyEvent } from "@drec/core";

function freshLedger(): SyncLedger {
  return new SyncLedger(join(mkdtempSync(join(tmpdir(), "rec-test-")), "test.db"));
}

function makeRec(overrides: Partial<NodeRecording> = {}): NodeRecording {
  return {
    roomSlug: "test-room",
    sessionBase: "主播名_2026-06-22_08-00-00",
    tsFiles: ["/remote/a.ts"],
    xmlPath: "/remote/danmu.xml",
    durationSec: 3600,
    startMs: new Date("2026-06-22T08:00:00Z").getTime(),
    endMs: new Date("2026-06-22T09:00:00Z").getTime(),
    totalGapSec: 0,
    ...overrides,
  };
}

function makeTransport(id: string, recordings: NodeRecording[]): Transport {
  return {
    id,
    listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ tenantId: id, recordings }),
    isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(true),
    pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makePipelineDeps(ledger: SyncLedger, transports: Map<string, Transport>): PipelineDeps {
  return {
    transports,
    ledger,
    sh: vi.fn<(cmd: string) => Promise<void>>().mockResolvedValue(undefined),
    upload: vi.fn<(o: unknown) => Promise<string>>().mockResolvedValue("BV123"),
    notify: vi.fn<(e: NotifyEvent) => void>(),
    cfg: {
      cleanMaxGapSec: 30,
      stageDir: "/tmp/stage",
      cookies: "/tmp/cookies.json",
      uploadMode: "auto-private",
      uploadMeta: { tag: "直播录像", tid: 21, desc: "直播录像" },
    },
  };
}

/** Fast settle config for tests: skip the real timeout. */
const fastSettle = { maxWaitMs: 50, pollMs: 1 };
const fastSleep = async (_ms: number): Promise<void> => {};

describe("Reconciler", () => {
  it("场景A: 两 transport 各报同一场 → 聚成 1 簇 → runPipeline 调 1 次，ledger=done", async () => {
    const ledger = freshLedger();
    const rec1 = makeRec({ tenantId: "node-1" } as Partial<NodeRecording>);
    const rec2 = makeRec({ tenantId: "node-2" } as Partial<NodeRecording>);

    const t1 = makeTransport("node-1", [rec1]);
    const t2 = makeTransport("node-2", [rec2]);
    const transports = new Map([["node-1", t1], ["node-2", t2]]);

    const pipelineDeps = makePipelineDeps(ledger, transports);

    // Injectable spy: record call and mark ledger done
    const spyCalls: Broadcast[] = [];
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b, _deps) => {
        spyCalls.push(b);
        ledger.markDone(b.streamKey, "BV_TEST");
        return { state: "done", bv: "BV_TEST" };
      },
    );

    const deps: ReconcilerDeps = {
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: fastSettle,
      sleep: fastSleep,
    };

    const reconciler = new Reconciler(deps);
    await reconciler.reconcileAll();

    // Both transports had same roomSlug + overlapping time → should cluster into 1 broadcast
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyCalls).toHaveLength(1);
    // The single broadcast should include both tenants as members
    expect(spyCalls[0].members).toHaveLength(2);
    // Ledger should be done
    const job = ledger.get(spyCalls[0].streamKey);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV_TEST");

    ledger.close();
  });

  it("场景B(幂等): 第二次 reconcileAll → 已 done → runPipeline 不再调", async () => {
    const ledger = freshLedger();
    const rec = makeRec();
    const t1 = makeTransport("node-1", [rec]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);

    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b, _deps) => {
        ledger.markDone(b.streamKey, "BV_IDEM");
        return { state: "done", bv: "BV_IDEM" };
      },
    );

    const deps: ReconcilerDeps = {
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: fastSettle,
      sleep: fastSleep,
    };

    const reconciler = new Reconciler(deps);

    // First run: should call runPipeline once
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);

    // Second run with same inventories: already done → should NOT call again
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1); // still 1, not 2

    ledger.close();
  });

  it("死 transport 不阻断其他 transport 对账", async () => {
    const ledger = freshLedger();
    const rec = makeRec();
    const t1: Transport = {
      id: "node-dead",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockRejectedValue(new Error("connection refused")),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(true),
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const t2 = makeTransport("node-live", [rec]);
    const transports = new Map([["node-dead", t1], ["node-live", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);

    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b, _deps) => {
        ledger.markDone(b.streamKey, "BV_LIVE");
        return { state: "done", bv: "BV_LIVE" };
      },
    );

    const deps: ReconcilerDeps = {
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: fastSettle,
      sleep: fastSleep,
    };

    const reconciler = new Reconciler(deps);
    // Should not throw despite dead transport
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
    // The live node's recording should still be processed
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);

    ledger.close();
  });

  it("settle: isDone 前 2 次 false 再 true → 等待后 pipeline 跑一次", async () => {
    const ledger = freshLedger();
    const rec = makeRec();

    let callCount = 0;
    const t1: Transport = {
      id: "node-1",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ tenantId: "node-1", recordings: [rec] }),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockImplementation(async () => {
        callCount += 1;
        return callCount >= 3; // false, false, then true
      }),
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);

    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b, _deps) => {
        ledger.markDone(b.streamKey, "BV_SETTLE");
        return { state: "done", bv: "BV_SETTLE" };
      },
    );

    const deps: ReconcilerDeps = {
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: { maxWaitMs: 100, pollMs: 1 },
      sleep: fastSleep,
    };

    const reconciler = new Reconciler(deps);
    await reconciler.reconcileAll();

    // isDone was called more than once (polled at least twice before returning true)
    expect(t1.isDone).toHaveBeenCalledTimes(3);
    // Pipeline still ran exactly once
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);

    ledger.close();
  });

  it("settle: isDone 始终 false → maxWait 后仍继续 pipeline（不 hang、不抛、有 warn 日志）", async () => {
    const ledger = freshLedger();
    const rec = makeRec();

    const t1: Transport = {
      id: "node-slow",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ tenantId: "node-slow", recordings: [rec] }),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(false),
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-slow", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);

    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b, _deps) => {
        ledger.markDone(b.streamKey, "BV_SLOW");
        return { state: "done", bv: "BV_SLOW" };
      },
    );

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const deps: ReconcilerDeps = {
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: { maxWaitMs: 50, pollMs: 1 },
      sleep: fastSleep,
    };

    const reconciler = new Reconciler(deps);
    // Must not hang and must not throw
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

    // Pipeline still ran (no hang, no skip)
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);

    // A warning was logged mentioning the tenant that was still recording
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("node-slow"),
    );

    warnSpy.mockRestore();
    ledger.close();
  });

  it("场景F(出错标 failed + 重试上限): runPipeline 抛错 → job=failed/fails 自增,达上限后不再重入", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", [makeRec()]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async () => { throw new Error("merge 爆了"); },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: { maxWaitMs: 50, pollMs: 1 }, sleep: fastSleep,
      maxRetries: 2,
    });
    const key = "douyin:test-room:2026-06-22";

    await reconciler.reconcileAll();                 // 第1次 → 抛错 → failed, fails=1
    let job = ledger.get(key);
    expect(job?.state).toBe("failed");
    expect(job?.fails).toBe(1);
    expect(job?.error).toContain("merge 爆了");

    await reconciler.reconcileAll();                 // 第2次 → 重试 → failed, fails=2(达上限)
    expect(ledger.get(key)?.fails).toBe(2);
    expect(spyRunPipeline).toHaveBeenCalledTimes(2);

    await reconciler.reconcileAll();                 // 第3次 → 达上限 → 跳过,不再调 runPipeline
    expect(spyRunPipeline).toHaveBeenCalledTimes(2); // 仍是 2
    expect(ledger.get(key)?.fails).toBe(2);

    errSpy.mockRestore();
    ledger.close();
  });

  it("场景E(防锁死): 一个租户 listInventory 永久挂起 → 超时降级为空,reconcile 仍完成且处理其余租户", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", [makeRec()]);
    // node-hang 的 listInventory 永不 resolve(模拟 hung ssh)
    const tHang: Transport = {
      id: "node-hang",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockReturnValue(new Promise(() => {})),
      isDone: vi.fn<(s: string) => Promise<boolean>>().mockResolvedValue(true),
      pull: vi.fn<(p: string[], d: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-1", t1], ["node-hang", tHang]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);

    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_HANG"); return { state: "done", bv: "BV_HANG" }; },
    );

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: { maxWaitMs: 50, pollMs: 1 }, sleep: fastSleep,
      inventoryTimeoutMs: 30,   // 挂起的租户 30ms 后降级为空
    });

    // 不挂起、不抛错,且仍处理了 node-1 的那一簇(单成员)
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("node-hang"));

    warnSpy.mockRestore();
    ledger.close();
  });
});
