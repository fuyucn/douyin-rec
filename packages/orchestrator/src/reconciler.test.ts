import { describe, it, expect, vi, afterEach, onTestFinished } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Reconciler, type ReconcilerDeps } from "./reconciler.js";
import { SyncLedger } from "./ledger.js";
import { ProcUnsupported, type Transport, type NodeRecording, type NodeInventory } from "./transport.js";
import type { PipelineDeps } from "./pipeline.js";
import { clusterBroadcasts, type Broadcast } from "./identity.js";
import type { JobState } from "./ledger.js";
import { processTimeZone, zonedStamp, JobAbortedError, USER_STOP, _resetJobAbort, beginJob, endJob, isJobLive } from "@drec/core";
import type { NotifyEvent } from "@drec/core";

function freshLedger(): SyncLedger {
  return new SyncLedger(join(mkdtempSync(join(tmpdir(), "rec-test-")), "test.db"));
}

function makeRec(overrides: Partial<NodeRecording> = {}): NodeRecording {
  return {
    roomSlug: "test-room",
    platform: "douyin",
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
    listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ workerId: id, recordings }),
    isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(true),
    pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

function makePipelineDeps(ledger: SyncLedger, transports: Map<string, Transport>): PipelineDeps {
  return {
    transports,
    ledger,
    sh: vi.fn<(cmd: string) => Promise<void>>().mockResolvedValue(undefined),
    uploadPlain: vi.fn<(plain: unknown) => Promise<string>>().mockResolvedValue("BV123"),
    appendGroup: vi.fn<(o: unknown) => Promise<void>>().mockResolvedValue(undefined),
    notify: vi.fn<(e: NotifyEvent) => void>(),
    cfg: {
      cleanMaxGapSec: 30,
      stageDir: "/tmp/stage",
      cookies: "/tmp/cookies.json",
      uploadMode: "upload",
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
    const rec1 = makeRec({ workerId: "node-1" } as Partial<NodeRecording>);
    const rec2 = makeRec({ workerId: "node-2" } as Partial<NodeRecording>);

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
    // The single broadcast should include both workers as members
    expect(spyCalls[0].members).toHaveLength(2);
    // Ledger should be done
    const job = ledger.get(spyCalls[0].streamKey);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV_TEST");

    ledger.close();
  });

  it("issue #309: a node whose rolling uploader still owns the session defers the broadcast instead of judging it", async () => {
    const ledger = freshLedger();
    const pending = makeRec({ tsFiles: ["/remote/a_000.ts"], rolling: { uploading: { index: 0, kind: "create" }, confirmed: [], active: true } });
    const t1 = makeTransport("node-1", [pending]);
    const transports = new Map([["node-1", t1]]);
    const runPipeline = vi.fn(async () => ({ state: "done" as const, bv: "BV_TEST" }));
    const base = { platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports), runPipeline, settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0 };
    await new Reconciler(base).reconcileAll();
    expect(runPipeline).not.toHaveBeenCalled();
    expect(ledger.listKeys()).toHaveLength(0); // no job row, so nothing lands in needs_manual

    // Owner closed the session (or is gone): judged as before.
    vi.mocked(t1.listInventory).mockResolvedValue({ workerId: "node-1", recordings: [{ ...pending, rolling: { ...pending.rolling, active: false } }] });
    await new Reconciler(base).reconcileAll();
    expect(runPipeline).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  it("T9b:每轮 reconcileAll 轮询收尾后转格式的回执;节点回滚 → 标注并停止轮询,job 终态不变", async () => {
    const ledger = freshLedger();
    ledger.upsertPending("douyin:test-room:2026-06-22");
    ledger.markDone("douyin:test-room:2026-06-22", "BV1");
    const procStatus = vi.fn(async () => { throw new ProcUnsupported(); });
    const t1 = { ...makeTransport("node-1", []), procStatus } as Transport;
    const transports = new Map([["node-1", t1]]);
    ledger.setFollowups("douyin:test-room:2026-06-22", JSON.stringify({
      v: 1, open: true, notes: [],
      items: [{ target: "node-1", file: "a.ts", jobId: "remux:k@1-1#g1", generation: 1, state: "pending" }],
    }));
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
      settle: fastSettle, sleep: fastSleep,
    });
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(procStatus).toHaveBeenCalledTimes(1);
    expect(ledger.get("douyin:test-room:2026-06-22")!.state).toBe("done");
    const fu = JSON.parse(ledger.getFollowups("douyin:test-room:2026-06-22")!) as { open: boolean; notes: string[] };
    expect(fu.open).toBe(false);
    expect(fu.notes.some((n) => n.includes("已回滚,留存转格式未执行"))).toBe(true);
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

  it("场景B2(hub 任务开始通知): 新建 job 发一次 hubTaskStart,后续对账不重复", async () => {
    const ledger = freshLedger();
    const rec = makeRec();
    const t1 = makeTransport("node-1", [rec]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const notify = vi.fn<(e: NotifyEvent) => void>();
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_START"); return { state: "done", bv: "BV_START" }; },
    );

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep, notify,
    });

    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    const starts = notify.mock.calls.map(([e]) => e).filter((e) => e.kind === "hubTaskStart");
    expect(starts).toHaveLength(1);
    expect(starts[0]).toEqual({
      kind: "hubTaskStart",
      streamKey: "douyin:test-room:2026-06-22",
      room: "test-room",
      workers: ["node-1"],
      mode: "upload",
    });

    // 第二次对账:job 已 done → 不再新建、不重复通知。
    await reconciler.reconcileAll();
    expect(notify.mock.calls.filter(([e]) => e.kind === "hubTaskStart")).toHaveLength(1);
    ledger.close();
  });

  it("streamKey 日期按注入的设置时区(issue #155):宿主机为美西、北京次日凌晨开播 → 北京日期", async () => {
    const prevTZ = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const ledger = freshLedger();
      // 北京 2026-09-13 01:30 = 洛杉矶 09-12 10:30
      const startMs = new Date("2026-09-12T17:30:00Z").getTime();
      const rec = makeRec({ startMs, endMs: startMs + 3_600_000, sessionBase: "主播名_2026-09-13_01-30-00" });
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      const seen: string[] = [];
      const reconciler = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: (async (b: Broadcast) => { seen.push(b.streamKey); return { state: "done" as const, bv: "BV" }; }) as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
        timeZone: () => "Asia/Shanghai",
      });
      await reconciler.reconcileAll();
      expect(seen).toEqual(["douyin:test-room:2026-09-13"]);
      ledger.close();
    } finally {
      if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ;
    }
  });

  it("场景N(重连窗): 广播结束仍在 reconnectWindowMs 内 → 先不建 job/不跑 pipeline", async () => {
    const ledger = freshLedger();
    const endMs = Date.now() - 60_000; // 1 分钟前收播,10 分钟重连窗内
    const rec = makeRec({
      roomSlug: "reconnect-window-room",
      sessionBase: "主播名_2026-08-14_08-00-00",
      startMs: endMs - 3_600_000,
      endMs,
      durationSec: 3600,
    });
    const t1 = makeTransport("node-1", [rec]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      reconnectWindowMs: 10 * 60_000,
    });
    await reconciler.reconcileAll();

    expect(spyRunPipeline).not.toHaveBeenCalled();
    expect(ledger.listActive()).toHaveLength(0); // 还没建 job,等重连窗结束再聚同一场
    ledger.close();
  });

  it("issue #292: configured reconnectWindowMs=600000 still waits 60 min after the broadcast ends", async () => {
    const ledger = freshLedger();
    const endMs = Date.now() - 30 * 60_000; // ended 30 min ago: past the stale 10 min config, inside 60 min
    const rec = makeRec({
      roomSlug: "clamp-wait-room", sessionBase: "主播名_2026-08-14_08-00-00",
      startMs: endMs - 3_600_000, endMs, durationSec: 3600,
    });
    const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 600_000,
    });
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(spyRunPipeline).not.toHaveBeenCalled();
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("reconnectWindowMs=600000"))).toHaveLength(1);
    ledger.close();
  });

  it("issue #292: configured reconnectWindowMs=600000 still clusters a 30 min gap into one broadcast", async () => {
    const ledger = freshLedger();
    const t0 = Date.now() - 6 * 3_600_000;
    const a = makeRec({
      roomSlug: "clamp-cluster-room", sessionBase: "主播名_2026-08-14_08-00-00",
      startMs: t0, endMs: t0 + 3_600_000, durationSec: 3600,
    });
    const b = makeRec({
      roomSlug: "clamp-cluster-room", sessionBase: "主播名_2026-08-14_09-30-00",
      startMs: t0 + 3_600_000 + 30 * 60_000, endMs: t0 + 2 * 3_600_000 + 30 * 60_000, durationSec: 3600,
    });
    const transports = new Map([["node-1", makeTransport("node-1", [a, b])]]);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (x) => { ledger.markDone(x.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 600_000,
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0]![0].members).toHaveLength(2);
    ledger.close();
  });

  it("issue #292: a drifted `_HHMM` job of a broadcast that already has a BV is parked as needs_manual, never run", async () => {
    const ledger = freshLedger();
    const baseKey = "douyin:drift-room:2026-08-14";
    const start = new Date("2026-08-14T08:00:00Z").getTime();
    ledger.upsertPending(baseKey, start);
    ledger.markDone(baseKey, "BV_FIRST");
    ledger.recordCandidates(baseKey,
      [{ workerId: "node-1", coverage: 1, durationSec: 7200, startMs: start, endMs: start + 2 * 3_600_000, totalGapSec: 0 }], "node-1");
    // Legacy drifted scan: same session, start moved 30 min forward, 30 min before the recorded end.
    const rec = makeRec({
      roomSlug: "drift-room", sessionBase: "主播名_2026-08-14_08-00-00",
      startMs: start + 90 * 60_000, endMs: start + 2 * 3_600_000, durationSec: 1800,
    });
    const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
    const runPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => ({ state: "done", bv: b.streamKey }),
    );
    const notify = vi.fn();
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
      runPipeline, settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0, notify,
    });
    await reconciler.reconcileAll();
    expect(runPipeline).not.toHaveBeenCalled();
    const derived = ledger.listKeys().map((k) => k.streamKey).filter((k) => k !== baseKey);
    expect(derived).toHaveLength(1);
    expect(derived[0]).toMatch(/^douyin:drift-room:2026-08-14_\d{4}$/);
    expect(ledger.get(derived[0]!)?.state).toBe("needs_manual");
    expect(ledger.get(derived[0]!)?.error).toMatch(/同场守卫.*BV_FIRST/);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
    ledger.close();
  });

  it("场景O(同日第二场): 已有 done 的 base job → 新场用 _HHMM 后缀,跑自己的 pipeline", async () => {
    const ledger = freshLedger();
    // 第一场已 done(记录 startMs,供聚类判断不是同一场)
    const firstStart = new Date("2026-08-14T08:00:00Z").getTime();
    const secondStart = new Date("2026-08-14T12:00:00Z").getTime();
    const secondEnd = secondStart + 3_600_000;
    ledger.upsertPending("douyin:same-day-room:2026-08-14", firstStart);
    ledger.markDone("douyin:same-day-room:2026-08-14", "BV_FIRST");
    // The first broadcast's real span is on record (every pipeline path writes it), so the same-broadcast guard
    // can prove the 12:00 session is > 60 min later and therefore a genuinely new broadcast.
    ledger.recordCandidates("douyin:same-day-room:2026-08-14",
      [{ workerId: "node-1", coverage: 1, durationSec: 3600, startMs: firstStart, endMs: firstStart + 3_600_000, totalGapSec: 0 }], "node-1");

    const rec2 = makeRec({
      roomSlug: "same-day-room",
      sessionBase: "主播名_2026-08-14_12-00-00",
      startMs: secondStart,
      endMs: secondEnd,
      durationSec: 3600,
    });
    const t1 = makeTransport("node-1", [rec2]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const seen: Broadcast[] = [];
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => {
        seen.push(b);
        ledger.markDone(b.streamKey, "BV_SECOND");
        return { state: "done", bv: "BV_SECOND" };
      },
    );

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
    });
    await reconciler.reconcileAll();

    expect(seen).toHaveLength(1);
    expect(seen[0].streamKey).toMatch(/^douyin:same-day-room:2026-08-14_\d{4}$/);
    expect(ledger.get(seen[0].streamKey)?.state).toBe("done");
    expect(ledger.get(seen[0].streamKey)?.startMs).toBe(secondStart);
    // base job 不受影响
    expect(ledger.get("douyin:same-day-room:2026-08-14")?.state).toBe("done");
    ledger.close();
  });

  it("死 transport 不阻断其他 transport 对账(规则未选中该节点)", async () => {
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
      // 规则只选 node-live:未被选中的 node-dead 失联不影响本场(三态,#27)
      resolveCfg: () => ({ ...pipelineDeps.cfg, workers: ["node-live"] }),
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
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ workerId: "node-1", recordings: [rec] }),
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

  it("settle: isDone 始终 false（仍在录）→ **跳过该场**不处理(等录完),不 hang/不抛,有 warn 日志（Bug B 完整修复）", async () => {
    const ledger = freshLedger();
    const rec = makeRec();

    const t1: Transport = {
      id: "node-slow",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ workerId: "node-slow", recordings: [rec] }),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(false), // 一直在录
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-slow", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_SLOW"); return { state: "done", bv: "BV_SLOW" }; },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: { maxWaitMs: 50, pollMs: 1 }, sleep: fastSleep,
    });
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

    // 关键:仍在录 → pipeline **不跑**(不抓残片),也不建 job;只 warn
    expect(spyRunPipeline).toHaveBeenCalledTimes(0);
    expect(ledger.listActive()).toHaveLength(0);   // 没建任何 job
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("node-slow"));

    warnSpy.mockRestore();
    ledger.close();
  });

  it("Bug C: 首快照为空 → 第二快照才出现刚开播的分段(isDone=false)→ 不建 job、不跑 pipeline", async () => {
    const ledger = freshLedger();
    const rec = makeRec({
      durationSec: 5.7,
      startMs: new Date("2026-06-22T08:00:00Z").getTime(),
      endMs: new Date("2026-06-22T08:00:05Z").getTime(),
    });
    let invCalls = 0;
    const t1: Transport = {
      id: "node-1",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockImplementation(async () => {
        invCalls += 1;
        return { workerId: "node-1", recordings: invCalls === 1 ? [] : [rec] };
      }),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(false), // 仍在录
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_LATE"); return { state: "done", bv: "BV_LATE" }; },
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
    });
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

    // 关键:第二快照新出现的成员仍未被确认收播 → pipeline **不跑**,也不建 job;只 warn
    expect(spyRunPipeline).toHaveBeenCalledTimes(0);
    expect(ledger.listActive()).toHaveLength(0);
    expect(t1.isDone).toHaveBeenCalledTimes(1); // 只为第二快照新出现的成员现查一次
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("node-1"));

    warnSpy.mockRestore();
    ledger.close();
  });

  it("Bug C 对照: 首快照为空,第二快照的分段已收播(isDone=true)→ 正常跑 pipeline", async () => {
    const ledger = freshLedger();
    const rec = makeRec({
      durationSec: 5.7,
      startMs: new Date("2026-06-22T08:00:00Z").getTime(),
      endMs: new Date("2026-06-22T08:00:05Z").getTime(),
    });
    let invCalls = 0;
    const t1: Transport = {
      id: "node-1",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockImplementation(async () => {
        invCalls += 1;
        return { workerId: "node-1", recordings: invCalls === 1 ? [] : [rec] };
      }),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(true), // 已收播
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_LATE_OK"); return { state: "done", bv: "BV_LATE_OK" }; },
    );

    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
    });
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();

    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(t1.isDone).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  it("场景F(出错标 failed + 重试上限): runPipeline 抛错 → failed/fails 自增,达上限升级 needs_manual + 通知一次", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", [makeRec()]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const notify = vi.fn<(e: NotifyEvent) => void>();
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async () => { throw new Error("merge 爆了"); },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: { maxWaitMs: 50, pollMs: 1 }, sleep: fastSleep,
      maxRetries: 2, notify,
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

    await reconciler.reconcileAll();                 // 第3次 → 达上限 → 升级 needs_manual + 通知,不再调 runPipeline
    expect(spyRunPipeline).toHaveBeenCalledTimes(2); // 仍是 2
    expect(ledger.get(key)?.state).toBe("needs_manual");
    expect(ledger.get(key)?.fails).toBe(2);
    expect(notify.mock.calls.filter(([e]) => e.kind === "error")).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", stage: "同步" }));

    await reconciler.reconcileAll();                 // 第4次 → 已 needs_manual(终态)→ 跳过,不重复通知
    expect(notify.mock.calls.filter(([e]) => e.kind === "error")).toHaveLength(1);

    errSpy.mockRestore();
    ledger.close();
  });

  it("场景E(防锁死): 一个worker listInventory 永久挂起 → 超时判 unreachable(规则未选中它),reconcile 仍完成且处理其余worker", async () => {
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
      inventoryTimeoutMs: 30,   // 挂起的worker 30ms 后判 unreachable
      resolveCfg: () => ({ ...pipelineDeps.cfg, workers: ["node-1"] }),   // 规则未选中 hang 节点
    });

    // 不挂起、不抛错,且仍处理了 node-1 的那一簇(单成员)
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("node-hang"));

    warnSpy.mockRestore();
    ledger.close();
  });

  it("场景G(按任务取配置): resolveCfg 返回 null(房间没开 hub)→ 跳过不建 job/不跑 pipeline", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", [makeRec()]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "X"); return { state: "done", bv: "X" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => null,   // 该房间没有开 hub 的任务
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(0);
    expect(ledger.listActive()).toHaveLength(0);
    ledger.close();
  });

  it("场景H(按任务取配置): resolveCfg 返回 cfg → 用它跑 pipeline", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", [makeRec()]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    let usedCfg: unknown;
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b, d) => { usedCfg = d.cfg; ledger.markDone(b.streamKey, "X"); return { state: "done", bv: "X" }; },
    );
    const perTaskCfg = { cleanMaxGapSec: 5, stageDir: "/s", cookies: "/c", uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 }, steps: { burnDanmu: false } };
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => perTaskCfg,
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(usedCfg).toEqual(perTaskCfg);   // pipeline 收到的是任务的 cfg
    ledger.close();
  });

  it("实时重载:loadTransports 返回变化 → 下一轮用新 transports 重建", async () => {
    const ledger = freshLedger();
    const recA = makeRec();
    const tOld = makeTransport("old-node", [recA]);
    let current = new Map<string, Transport>([["old-node", tOld]]);
    const pipelineDeps = makePipelineDeps(ledger, current);
    const seen: string[][] = [];
    const spy = vi.fn(async (b: Broadcast) => { seen.push(b.members.map((m) => m.workerId)); ledger.markDone(b.streamKey, "BV"); return { state: "done" as JobState }; });
    const rec = new Reconciler({
      platform: "douyin", transports: current, ledger, pipelineDeps,
      runPipeline: spy, loadTransports: () => current, settle: fastSettle, sleep: fastSleep,
    });
    await rec.reconcileAll();
    expect(seen.at(-1)).toEqual(["old-node"]);
    // 换一台节点(模拟改 hub.config.json 后 loadWorkers→重建)。不同 roomSlug 避免撞上 old-node
    // 那场已 done 的 streamKey(否则幂等跳过掩盖了「用没用新 transports」这个断言点)。
    const tNew = makeTransport("new-node", [makeRec({ roomSlug: "test-room-2" })]);
    current = new Map<string, Transport>([["new-node", tNew]]);
    await rec.reconcileAll();
    expect(seen.at(-1)).toEqual(["new-node"]);   // 用的是重建后的 transports
    // old-node 已不在 current 里 → 第二轮的 inventory 只应来自 new-node(证明真的重建了 Map,不是沿用旧的)。
    // 每轮 reconcile = settle 前收一次清单 + settle 后刷新一次权威清单。
    expect(tOld.listInventory).toHaveBeenCalledTimes(2);
    expect(tNew.listInventory).toHaveBeenCalledTimes(2);
    ledger.close();
  });

  it("场景M(settle 后刷新清单): 收播等待期间新分段落盘 → pipeline 用刷新后的完整分段", async () => {
    const ledger = freshLedger();
    const partial = makeRec({
      sessionBase: "主播_2026-06-22_08-00-00",
      tsFiles: ["/remote/a_000.ts"],
      xmlPath: "/remote/danmu.xml",
      durationSec: 60,
      startMs: new Date("2026-06-22T08:00:00Z").getTime(),
      endMs: new Date("2026-06-22T08:01:00Z").getTime(),
    });
    const full = {
      ...partial,
      tsFiles: ["/remote/a_000.ts", "/remote/a_001.ts"],
      durationSec: 120,
      endMs: new Date("2026-06-22T08:02:00Z").getTime(),
    };
    let inv = [partial];        // settle 前:只扫到第 1 段
    let isDoneCalls = 0;
    const t1: Transport = {
      id: "node-1",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockImplementation(async () => ({ workerId: "node-1", recordings: inv })),
      // 第一次说未收播并模拟「等待期间新分段落盘」;第二次起收播 → 刷新清单必须拿到 full。
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockImplementation(async () => {
        isDoneCalls++;
        if (isDoneCalls === 1) { inv = [full]; return false; }
        return true;
      }),
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    let captured: Broadcast | undefined;
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => {
        captured = b;
        ledger.markDone(b.streamKey, "BV_M");
        return { state: "done", bv: "BV_M" };
      },
    );
    const reconciler = new Reconciler({
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: { maxWaitMs: 50, pollMs: 1 },
      sleep: fastSleep,
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(captured?.members[0].rec.tsFiles).toHaveLength(2);   // 用了刷新后的完整分段
    expect(captured?.members[0].rec.durationSec).toBe(120);
    ledger.close();
  });

  it("场景I(worker 硬过滤): workers=[local] → 即使 vps2 也录了该场,vps2 被过滤,winner 只能 local", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);
    const t2 = makeTransport("vps2", [makeRec()]);      // vps2 也录了同一场
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        workers: ["local"],   // 只选 local
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    const members = spyRunPipeline.mock.calls[0][0].members;
    expect(members).toHaveLength(1);
    expect(members[0].workerId).toBe("local");   // vps2 被硬过滤
    ledger.close();
  });

  it("场景J(向后兼容): resolveCfg 返回的 cfg 无 workers → 全部 members 参与", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);
    const t2 = makeTransport("vps2", [makeRec()]);
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        // 无 workers → 不过滤
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(2);
    ledger.close();
  });

  it("能力门控: requires=[danmu:douyin] → 无该能力的 worker 被排除,有能力者保留(冗余语义不变)", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);   // local 有能力
    const t2 = makeTransport("vps2", [makeRec()]);     // vps2 出口拿不到弹幕 → 无能力
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const caps: Record<string, string[]> = { local: ["danmu:douyin"], vps2: ["record"] };
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      workerCapabilities: (id) => caps[id],
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        requires: ["danmu:douyin"],
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    const members = spyRunPipeline.mock.calls[0][0].members;
    expect(members).toHaveLength(1);
    expect(members[0].workerId).toBe("local");   // vps2 被能力门控排除
    ledger.close();
  });

  it("能力门控是过滤不是去重: 多台都有能力 → 全部保留(与冗余选优并存)", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);
    const t2 = makeTransport("vps2", [makeRec()]);
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      workerCapabilities: () => ["danmu:douyin"],   // 两台都有能力
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        requires: ["danmu:douyin"],
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(2);
    ledger.close();
  });

  it("能力门控过滤到一个不剩 → 不建 job/不跑 pipeline(不静默漏处理)", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);
    const t2 = makeTransport("vps2", [makeRec()]);
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      workerCapabilities: () => ["record"],   // 都没弹幕能力
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        requires: ["danmu:douyin"],
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(0);
    expect(ledger.listActive()).toHaveLength(0);
    ledger.close();
  });

  it("场景K(选中的没人录): workers=[local] 但只有 vps2 录到 → 不建 job/不跑 pipeline", async () => {
    const ledger = freshLedger();
    const t2 = makeTransport("vps2", [makeRec()]);   // 只有 vps2 录了
    // local transport 存在但本场没录像(inventory 空)
    const t1 = makeTransport("local", []);
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        workers: ["local"],
      }),
    });
    await reconciler.reconcileAll();
    expect(spyRunPipeline).toHaveBeenCalledTimes(0);
    expect(ledger.listActive()).toHaveLength(0);   // 没建任何 job
    ledger.close();
  });

  it("场景L(settle 只等选中): 未选中的 vps2 仍在录(isDone=false)不阻塞;local 已收播 → pipeline 跑", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("local", [makeRec()]);   // isDone 默认 true
    const t2: Transport = {
      id: "vps2",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ workerId: "vps2", recordings: [makeRec()] }),
      isDone: vi.fn<(s: string) => Promise<boolean>>().mockResolvedValue(false),   // 仍在录
      pull: vi.fn<(p: string[], d: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const transports = new Map([["local", t1], ["vps2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV"); return { state: "done", bv: "BV" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: { maxWaitMs: 50, pollMs: 1 }, sleep: fastSleep,
      resolveCfg: () => ({
        cleanMaxGapSec: 30, stageDir: "/s", cookies: "/c",
        uploadMode: "stage" as const, uploadMeta: { tag: "t", tid: 21 },
        workers: ["local"],
      }),
    });
    await reconciler.reconcileAll();
    // vps2 被过滤 → settle 不查它;local 已收播 → pipeline 跑一次(只含 local)。
    expect(t2.isDone).not.toHaveBeenCalled();
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members).toHaveLength(1);
    ledger.close();
  });
});


describe("Reconciler.stopJob / runNow", () => {
  afterEach(() => _resetJobAbort());

  const key = "douyin:test-room:2026-06-22";

  function setup(recs: NodeRecording[] = [makeRec()], extra: Partial<ReconcilerDeps> = {}) {
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", recs);
    const t2 = makeTransport("node-2", recs);
    const transports = new Map([["node-1", t1], ["node-2", t2]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => {
        ledger.markDone(b.streamKey, "BV_NOW");
        return { state: "done", bv: "BV_NOW" };
      },
    );
    const reconciler = new Reconciler({
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: fastSettle,
      sleep: fastSleep,
      ...extra,
    });
    return { ledger, reconciler, spyRunPipeline, t1, transports, pipelineDeps };
  }

  it("stopJob: 无 job → 200 且不建行", async () => {
    const { ledger, reconciler } = setup();
    const r = await reconciler.stopJob(key);
    expect(r).toEqual({ ok: true });
    expect(ledger.get(key)).toBeNull();
    ledger.close();
  });

  it("stopJob: done → 409", async () => {
    const { ledger, reconciler } = setup();
    ledger.upsertPending(key, Date.now());
    ledger.markDone(key, "BV1");
    const r = await reconciler.stopJob(key);
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(ledger.get(key)?.state).toBe("done");
    ledger.close();
  });

  it("stopJob: 已 needs_manual → 200 不改写", async () => {
    const { ledger, reconciler } = setup();
    ledger.upsertPending(key);
    ledger.setState(key, "needs_manual", { error: "旧错误" });
    const r = await reconciler.stopJob(key);
    expect(r).toEqual({ ok: true });
    expect(ledger.get(key)?.error).toBe("旧错误");
    ledger.close();
  });

  it("stopJob: 空闲 pending → needs_manual,reconcile 不再重入", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    ledger.upsertPending(key, new Date("2026-06-22T08:00:00Z").getTime());
    const r = await reconciler.stopJob(key);
    expect(r).toEqual({ ok: true });
    expect(ledger.get(key)?.state).toBe("needs_manual");
    expect(ledger.get(key)?.error).toBe(USER_STOP);
    await reconciler.reconcileAll();
    expect(spyRunPipeline).not.toHaveBeenCalled();
    ledger.close();
  });

  it("reconcile 收到 abort → needs_manual,不 markFailed", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    spyRunPipeline.mockImplementation(async () => { throw new JobAbortedError(); });
    await reconciler.reconcileAll();
    expect(ledger.get(key)?.state).toBe("needs_manual");
    expect(ledger.get(key)?.error).toBe(USER_STOP);
    expect(ledger.get(key)?.fails ?? 0).toBe(0);
    ledger.close();
  });

  it("runNow: 无录像 → 404", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup([]);
    const r = await reconciler.runNow({ streamKey: key, wait: true });
    expect(r).toMatchObject({ ok: false, code: 404 });
    expect(spyRunPipeline).not.toHaveBeenCalled();
    expect(ledger.get(key)).toBeNull();
    ledger.close();
  });

  it("runNow: live / 持锁 → 409", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    beginJob(key);
    expect(isJobLive(key)).toBe(true);
    const r = await reconciler.runNow({ streamKey: key, wait: true });
    endJob(key);
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(spyRunPipeline).not.toHaveBeenCalled();
    ledger.close();
  });

  it("runNow: done+BV → 409", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    ledger.upsertPending(key);
    ledger.markDone(key, "BV_EXIST");
    const r = await reconciler.runNow({ streamKey: key, wait: true });
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(spyRunPipeline).not.toHaveBeenCalled();
    ledger.close();
  });

  it("runNow: a BV on the base key also blocks the -N submission, and force lets it through (plan 038 T17)", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    ledger.upsertPending(key);
    ledger.markDone(key, "BV_EXIST");
    const blocked = await reconciler.runNow({ streamKey: `${key}-1`, wait: true });
    expect(blocked).toMatchObject({ ok: false, code: 409, forceable: true });
    expect(spyRunPipeline).not.toHaveBeenCalled();
    const forced = await reconciler.runNow({ streamKey: `${key}-1`, wait: true, force: true });
    expect(forced).toMatchObject({ ok: true, code: 200, streamKey: `${key}-1` });
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  it("runNow: force does not override an already-running job", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    beginJob(key);
    const r = await reconciler.runNow({ streamKey: key, wait: true, force: true });
    endJob(key);
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(r.forceable).toBeUndefined();
    expect(spyRunPipeline).not.toHaveBeenCalled();
    ledger.close();
  });

  it("runNow: 无行则 upsertPending,跳过 settle/重连窗,wait 则 200", async () => {
    const rec = makeRec({
      endMs: Date.now(), // 仍在重连窗内,reconcileAll 会跳过
    });
    const stillRecording: Transport = {
      id: "node-1",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockResolvedValue({ workerId: "node-1", recordings: [rec] }),
      isDone: vi.fn<(s: string) => Promise<boolean>>().mockResolvedValue(false),
      pull: vi.fn<(p: string[], d: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    const ledger = freshLedger();
    const transports = new Map([["node-1", stillRecording]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_NOW"); return { state: "done", bv: "BV_NOW" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline: spyRunPipeline, settle: fastSettle, sleep: fastSleep,
      reconnectWindowMs: 10 * 60_000,
    });
    expect(ledger.get(key)).toBeNull();
    const r = await reconciler.runNow({ streamKey: key, wait: true });
    expect(r).toMatchObject({ ok: true, code: 200, streamKey: key });
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(stillRecording.isDone).not.toHaveBeenCalled();
    expect(ledger.get(key)?.state).toBe("done");
    ledger.close();
  });

  it("runNow: winnerWorker 过滤成员且不改原清单", async () => {
    const rec = makeRec();
    const { ledger, reconciler, spyRunPipeline, t1 } = setup([rec]);
    const r = await reconciler.runNow({ streamKey: key, winnerWorker: "node-2", wait: true });
    expect(r.ok).toBe(true);
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].members.map((m) => m.workerId)).toEqual(["node-2"]);
    // collect 后再跑 reconcile 仍能看到两台
    const inv = await t1.listInventory();
    expect(inv.recordings).toHaveLength(1);
    ledger.close();
  });

  it("runNow: 默认 wait=false → 202 且异步点火", async () => {
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const { ledger, reconciler, spyRunPipeline } = setup();
    spyRunPipeline.mockImplementation(async (b) => {
      await gate;
      ledger.markDone(b.streamKey, "BV_ASYNC");
      return { state: "done", bv: "BV_ASYNC" };
    });
    const r = await reconciler.runNow({ streamKey: key });
    expect(r).toMatchObject({ ok: true, code: 202, streamKey: key });
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(ledger.get(key)?.state).toBe("retrying");
    release();
    await vi.waitFor(() => expect(ledger.get(key)?.state).toBe("done"));
    ledger.close();
  });

  it("runNow: 前缀 _HHMM 多场取 startMs 最新", async () => {
    // 钉死进程时区 = 北京(env 未设),不随跑测机器 TZ 漂(streamKey 日期按设置时区算,issue #155)。
    const prevTZ = process.env.TZ;
    delete process.env.TZ;
    onTestFinished(() => { if (prevTZ === undefined) delete process.env.TZ; else process.env.TZ = prevTZ; });
    const early = makeRec({
      startMs: new Date("2026-06-22T02:00:00Z").getTime(),
      endMs: new Date("2026-06-22T03:00:00Z").getTime(),
      sessionBase: "主播名_2026-06-22_10-00-00",
    });
    const late = makeRec({
      startMs: new Date("2026-06-22T10:00:00Z").getTime(),
      endMs: new Date("2026-06-22T11:00:00Z").getTime(),
      sessionBase: "主播名_2026-06-22_18-00-00",
    });
    // 同日两簇且 base 无 job → 两场都带 _HHMM;runNow(base) 走前缀,取 startMs 最新。
    const { ledger, reconciler, spyRunPipeline } = setup([early, late]);
    const r = await reconciler.runNow({ streamKey: key, wait: true });
    const z = zonedStamp(late.startMs, processTimeZone()); // streamKey 的 _HHMM 按设置时区,不看宿主机本地(issue #155)
    const hhmm = `${z.hh}${z.mm}`;
    expect(r.ok).toBe(true);
    expect(r.streamKey).toBe(`${key}_${hhmm}`);
    expect(spyRunPipeline.mock.calls[0][0].startMs).toBe(late.startMs);
    ledger.close();
  });

  it("runNow: -N 后缀解析回 base 广播,用后缀 key 建独立 job(新建投稿)", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    const r = await reconciler.runNow({ streamKey: `${key}-1`, wait: true });
    expect(r).toMatchObject({ ok: true, code: 200, streamKey: `${key}-1` });
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][0].streamKey).toBe(`${key}-1`);
    expect(ledger.get(`${key}-1`)?.state).toBe("done");
    expect(ledger.get(key)).toBeNull(); // 原 key 不被占用/覆盖
    ledger.close();
  });

  it("runNow: -N 后缀已 done+BV → 409(不重复建稿)", async () => {
    const { ledger, reconciler, spyRunPipeline } = setup();
    ledger.upsertPending(`${key}-1`);
    ledger.markDone(`${key}-1`, "BV_SUB");
    const r = await reconciler.runNow({ streamKey: `${key}-1`, wait: true });
    expect(r).toMatchObject({ ok: false, code: 409 });
    expect(spyRunPipeline).not.toHaveBeenCalled();
    ledger.close();
  });

  it("runNow: -N 后缀按广播身份取房间 cfg(不回落全局 stage,上传节点不 skip)", async () => {
    const ledger = freshLedger();
    const t1 = makeTransport("node-1", [makeRec()]);
    const transports = new Map([["node-1", t1]]);
    const pipelineDeps = makePipelineDeps(ledger, transports);
    pipelineDeps.cfg = { ...pipelineDeps.cfg, uploadMode: "stage" }; // 全局默认 stage,模拟真实回落陷阱
    const spyRunPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => {
        ledger.markDone(b.streamKey, "BV_NOW");
        return { state: "done", bv: "BV_NOW" };
      },
    );
    const reconciler = new Reconciler({
      platform: "douyin",
      transports,
      ledger,
      pipelineDeps,
      runPipeline: spyRunPipeline,
      settle: fastSettle,
      sleep: fastSleep,
      resolveCfg: () => ({ ...pipelineDeps.cfg, uploadMode: "upload" }),
    });

    const r = await reconciler.runNow({ streamKey: `${key}-1`, wait: true });
    expect(r).toMatchObject({ ok: true, code: 200, streamKey: `${key}-1` });
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);
    expect(spyRunPipeline.mock.calls[0][1].cfg.uploadMode).toBe("upload");
    ledger.close();
  });
});

describe("磁盘看门狗(节点剩余空间告警)", () => {
  function depsWith(transports: Map<string, Transport>, notify = vi.fn()) {
    const ledger = freshLedger();
    return {
      deps: {
        platform: "douyin",
        transports,
        ledger,
        pipelineDeps: makePipelineDeps(ledger, transports),
        notify,
        resolveCfg: () => ({ ...makePipelineDeps(ledger, transports).cfg, workers: [] }),
      },
      ledger,
      notify,
    };
  }

  it("节点剩余低于阈值 → 发一次告警;回升后复位可再报", async () => {
    let free = 3; // GB,低于默认阈值 10
    const t: Transport = { ...makeTransport("vps2", []), diskFreeGB: async () => free };
    const { deps, notify } = depsWith(new Map([["vps2", t]]));
    const r = new Reconciler({ ...deps, diskMinGB: 10, reconnectWindowMs: 0 });

    await r.reconcileAll();
    await new Promise((res) => setTimeout(res, 10)); // checkDiskSpace 是 fire-and-forget
    expect(notify).toHaveBeenCalledTimes(1);
    const msg = (notify.mock.calls[0][0] as { message: string }).message;
    expect(msg).toContain("vps2");
    expect(msg).toContain("低于阈值");

    // 仍低 → 不重复报
    await r.reconcileAll();
    await new Promise((res) => setTimeout(res, 10));
    expect(notify).toHaveBeenCalledTimes(1);

    // 回升 → 复位;再低 → 再报一次
    free = 50;
    await r.reconcileAll();
    await new Promise((res) => setTimeout(res, 10));
    free = 2;
    await r.reconcileAll();
    await new Promise((res) => setTimeout(res, 10));
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it("diskMinGB<=0 → 关闭看门狗(不告警)", async () => {
    const t: Transport = { ...makeTransport("vps2", []), diskFreeGB: async () => 0 };
    const { deps, notify } = depsWith(new Map([["vps2", t]]));
    const r = new Reconciler({ ...deps, diskMinGB: 0, reconnectWindowMs: 0 });
    await r.reconcileAll();
    await new Promise((res) => setTimeout(res, 10));
    expect(notify).not.toHaveBeenCalled();
  });

  it("diskMinGB 缺省 / 非数字(字符串)→ 回落 10GB,看门狗仍生效(issue #38)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const v of [undefined, "abc" as unknown as number]) {
        const t: Transport = { ...makeTransport("vps2", []), diskFreeGB: async () => 3 };
        const { deps, notify } = depsWith(new Map([["vps2", t]]));
        const r = new Reconciler({ ...deps, diskMinGB: v, reconnectWindowMs: 0 });
        await r.reconcileAll();
        await new Promise((res) => setTimeout(res, 10));
        expect(notify).toHaveBeenCalledTimes(1);
        expect((notify.mock.calls[0][0] as { message: string }).message).toContain("阈值 10GB");
      }
      // 仅非数字那次告警,缺省不告警(只数 [disk] 告警;节点孤儿摘要行不计)
      expect(warn.mock.calls.filter((c) => String(c[0]).startsWith("[disk]"))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("transport 不支持 / 查询抛错 → 静默跳过(不误报)", async () => {
    const noCap = makeTransport("a", []); // 无 diskFreeGB
    const throws: Transport = { ...makeTransport("b", []), diskFreeGB: async () => { throw new Error("ssh down"); } };
    const { deps, notify } = depsWith(new Map([["a", noCap], ["b", throws]]));
    const r = new Reconciler({ ...deps, diskMinGB: 10, reconnectWindowMs: 0 });
    await r.reconcileAll();
    await new Promise((res) => setTimeout(res, 10));
    expect(notify).not.toHaveBeenCalled();
  });
  // ── T12:上传后收尾补跑(清理失败 / 核验待重试的 done job)────────────────────
  describe("收尾补跑(T12:done job 的 clean_* failed / clean_verify pending)", () => {
    /** 造一个已 done 的 job + 一份节点清单(源仍在 → 能被扫到)。 */
    async function doneJobWith(depsExtra: {
      /** 待补的节点名;undefined = 无待补(对照组)。 */
      node?: "clean_source" | "clean_stage" | "clean_verify";
      nodeState?: "failed" | "pending" | "done";
    }): Promise<{ ledger: SyncLedger; runPipeline: ReturnType<typeof vi.fn>; reconciler: Reconciler }> {
      const ledger = freshLedger();
      const rec = makeRec();
      // key 必须与 reconciler 实际聚出来的 streamKey 一致:已有 job 会让聚类强制加 _HHMM 后缀
      // (否则测试里的 job 永远匹配不上,看起来像"补跑没触发")。
      const key = clusterBroadcasts(
        [{ workerId: "node-1", recordings: [rec] }], 0, "douyin",
      )[0].streamKey;
      ledger.upsertPending(key, rec.startMs);
      ledger.setBv(key, "BV1");
      ledger.markDone(key, "BV1");
      if (depsExtra.node) {
        ledger.syncNodeState(key, depsExtra.node, depsExtra.nodeState ?? "failed", { error: "清理失败" });
      }
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      const pipelineDeps = makePipelineDeps(ledger, transports);
      const runPipeline = vi.fn(async () => ({ state: "done" as const, bv: "BV1" }));
      // reconnectWindowMs=0:跳过「刚结束先不处理」的门,让本轮直接走到补跑判定。
      const reconciler = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps,
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep,
        reconnectWindowMs: 0,
        cleanupBackfillThrottleMs: 0, // 0 = 无节流,便于测试
      });
      return { ledger, runPipeline, reconciler };
    }

    it("done + clean_source=failed → 补跑一次(终态短路之前!)", async () => {
      const { ledger, runPipeline, reconciler } = await doneJobWith({ node: "clean_source" });
      await reconciler.reconcileAll();
      expect(runPipeline).toHaveBeenCalledTimes(1);
      // 补跑**不改终态**:上传已成功,不能变 failed(否则自动重跑 = 重复投稿)。
      const [job] = ledger.listKeys();
      expect(ledger.get(job.streamKey)?.state).toBe("done");
      ledger.close();
    });

    it("done + clean_verify=pending(旧版遗留软状态)→ 不再补跑(issue #92:核验改旁路,据它补跑无法收敛)", async () => {
      const { ledger, runPipeline, reconciler } = await doneJobWith({ node: "clean_verify", nodeState: "pending" });
      await reconciler.reconcileAll();
      expect(runPipeline).not.toHaveBeenCalled();
      ledger.close();
    });

    it("台账单调时钟 vs 墙钟(updatedAt 可能比 Date.now() 大 1ms)→ throttle=0 也必须补跑", async () => {
      // 回归:SyncLedger.now() 进程内单调递增,同一毫秒内多次写入会 +1 递推,
      // 于是 `Date.now() - updatedAt` 可能是负数 → 未夹到 0 时 throttleMs=0 也被判「刚失败」而跳过。
      const { ledger, runPipeline, reconciler } = await doneJobWith({ node: "clean_source" });
      await reconciler.reconcileAll();
      expect(runPipeline).toHaveBeenCalledTimes(1);
      ledger.close();
    });

    it("done + 无待补节点 → 不补跑(幂等:不会每轮空转)", async () => {
      const { ledger, runPipeline, reconciler } = await doneJobWith({});
      await reconciler.reconcileAll();
      expect(runPipeline).not.toHaveBeenCalled();
      ledger.close();
    });

    it("节流:刚 failed 的 clean_* 在 throttle 窗口内不补跑", async () => {
      const ledger = freshLedger();
      const rec = makeRec();
      const key = `douyin:test-room:${new Date(rec.endMs).toISOString().slice(0, 10)}`;
      ledger.upsertPending(key, rec.startMs);
      ledger.markDone(key, "BV1");
      ledger.syncNodeState(key, "clean_source", "failed", { error: "x" });
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      const runPipeline = vi.fn(async () => ({ state: "done" as const, bv: "BV1" }));
      const reconciler = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never, settle: fastSettle, sleep: fastSleep,
        reconnectWindowMs: 0,
        cleanupBackfillThrottleMs: 60_000, // 刚写的 failed 落在窗口内 → 不补跑
      });
      await reconciler.reconcileAll();
      expect(runPipeline).not.toHaveBeenCalled();
      ledger.close();
    });

    it("补跑抛错 → job 仍 done(不改 failed),下轮再试", async () => {
      const { ledger } = await doneJobWith({ node: "clean_source" });
      const [jobRow] = ledger.listKeys();
      const boom = new Reconciler({
        platform: "douyin", transports: new Map([["node-1", makeTransport("node-1", [makeRec()])]]),
        ledger, pipelineDeps: makePipelineDeps(ledger, new Map()),
        runPipeline: (async () => { throw new Error("ssh 不通"); }) as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0, cleanupBackfillThrottleMs: 0,
      });
      await boom.reconcileAll();
      expect(ledger.get(jobRow.streamKey)?.state).toBe("done");   // 绝不被补跑失败改成 failed
      ledger.close();
    });
  });

  describe("T7 非阻塞派发(两阶段:job 先行 + 有界并发)", () => {
    /** 两个房间(不同 roomSlug/sessionBase),同一 worker 一次报上来。 */
    function twoRooms(): { ledger: SyncLedger; transports: Map<string, Transport>; keys: string[] } {
      const ledger = freshLedger();
      const recA = makeRec({ roomSlug: "room-a", sessionBase: "主播A_2026-06-22_08-00-00" });
      const recB = makeRec({ roomSlug: "room-b", sessionBase: "主播B_2026-06-22_08-00-00" });
      const transports = new Map([["node-1", makeTransport("node-1", [recA, recB])]]);
      const keys = clusterBroadcasts(
        [{ workerId: "node-1", recordings: [recA, recB] }], 0, "douyin",
      ).map((b) => b.streamKey);
      return { ledger, transports, keys };
    }

    it("房间 A 的 pipeline 还在跑 → 房间 B 的 job 行**已经**建好(不再被 N+1 阻塞)", async () => {
      const { ledger, transports, keys } = twoRooms();
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const started: string[] = [];
      const runPipeline = vi.fn(async (b: Broadcast) => {
        started.push(b.roomSlug);
        if (b.roomSlug === "room-a") await gate;   // A 挂住,B 应该照样被派发
        ledger.markDone(b.streamKey, "BV");
        return { state: "done" as const, bv: "BV" };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
        maxConcurrentPipelines: 2,
      });

      const done = r.reconcileAll();
      // 等 A 真的开始跑(B 是否已派发取决于 pump 顺序,但两行 job 必须已建)
      while (started.length === 0) await new Promise((res) => setImmediate(res));
      const rowsAtA = ledger.listKeys().map((k) => k.streamKey);
      expect(rowsAtA).toEqual(expect.arrayContaining(keys));  // 两行都在
      release();
      await done;
      expect(runPipeline).toHaveBeenCalledTimes(2);
      ledger.close();
    });

    it("maxConcurrentPipelines=1 → 两场严格串行(与旧行为一致,不夸大收益)", async () => {
      const { ledger, transports } = twoRooms();
      const order: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const runPipeline = vi.fn(async (b: Broadcast) => {
        order.push(`start:${b.roomSlug}`);
        if (order.length === 1) await gate;
        order.push(`end:${b.roomSlug}`);
        ledger.markDone(b.streamKey, "BV");
        return { state: "done" as const, bv: "BV" };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
        maxConcurrentPipelines: 1,
      });
      const done = r.reconcileAll();
      while (order.length === 0) await new Promise((res) => setImmediate(res));
      await new Promise((res) => setImmediate(res));
      expect(order).toEqual(["start:room-a"]);   // 第二个还在排队
      release();
      await done;
      expect(order).toEqual(["start:room-a", "end:room-a", "start:room-b", "end:room-b"]);
      ledger.close();
    });

    it("同一房间被信号两次(并发两轮 reconcileAll)→ 只跑一次,不重复建稿", async () => {
      const ledger = freshLedger();
      const rec = makeRec();
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let calls = 0;
      const runPipeline = vi.fn(async (b: Broadcast) => {
        calls++;
        await gate;
        ledger.markDone(b.streamKey, "BV");
        return { state: "done" as const, bv: "BV" };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
        maxConcurrentPipelines: 2,
      });
      // 第一轮还挂在 pipeline 里时(hub 的 running 守卫之外的直接重入)第二轮到达
      const first = r.reconcileAll();
      while (calls === 0) await new Promise((res) => setImmediate(res));
      await r.reconcileAll();
      release();
      await first;
      expect(calls).toBe(1);
      expect(ledger.listKeys()).toHaveLength(1);
      ledger.close();
    });

    it("上传类节点失败(不可自动重试)→ 转人工时 error 必须非空(issue #188)", async () => {
      const ledger = freshLedger();
      const rec = makeRec();
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      const key = clusterBroadcasts([{ workerId: "node-1", recordings: [rec] }], 0, "douyin")[0].streamKey;
      let n = 0;
      const runPipeline = vi.fn(async (b: Broadcast) => {
        n++;
        if (n === 1) {
          ledger.markFailed(b.streamKey, "");
          ledger.syncNodeState(b.streamKey, "upload_plain", "failed", { error: "" });
          return { state: "failed" as const };
        }
        ledger.markDone(b.streamKey, "BV");
        return { state: "done" as const, bv: "BV" };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
      });
      await r.reconcileAll();
      await r.reconcileAll();
      const job = ledger.get(key);
      expect(job?.state).toBe("needs_manual");
      expect((job?.error ?? "").trim()).not.toBe("");
      ledger.close();
    });

    it("failed 且达重试上限 → 转人工时 error 必须非空(issue #188:空串不得落库)", async () => {
      const ledger = freshLedger();
      const rec = makeRec();
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      const key = clusterBroadcasts([{ workerId: "node-1", recordings: [rec] }], 0, "douyin")[0].streamKey;
      // 空串 error:修复前 `?? ` 不会回落,会把空 error 写进 needs_manual。
      const runPipeline = vi.fn(async (b: Broadcast) => {
        ledger.markFailed(b.streamKey, "");
        return { state: "failed" as const };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0, maxRetries: 0,
      });
      await r.reconcileAll();
      await r.reconcileAll();
      const job = ledger.get(key);
      expect(job?.state).toBe("needs_manual");
      expect((job?.error ?? "").trim()).not.toBe("");
      ledger.close();
    });

    it("上一轮 failed(fails<maxRetries)→ 下一轮重新派发(dedup 不压合法重试)", async () => {
      const ledger = freshLedger();
      const rec = makeRec();
      const transports = new Map([["node-1", makeTransport("node-1", [rec])]]);
      const key = clusterBroadcasts([{ workerId: "node-1", recordings: [rec] }], 0, "douyin")[0].streamKey;
      let n = 0;
      const runPipeline = vi.fn(async (b: Broadcast) => {
        n++;
        if (n === 1) { ledger.markFailed(b.streamKey, "第一次炸了"); return { state: "failed" as const }; }
        ledger.markDone(b.streamKey, "BV");
        return { state: "done" as const, bv: "BV" };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
      });
      await r.reconcileAll();
      expect(ledger.get(key)?.state).toBe("failed");
      await r.reconcileAll();          // drain 后 active 集合已清空 → 必须能再派发
      expect(runPipeline).toHaveBeenCalledTimes(2);
      expect(ledger.get(key)?.state).toBe("done");
      ledger.close();
    });

    it("某场 pipeline 抛错 → 只标该场 failed,另一场照常完成", async () => {
      const { ledger, transports, keys } = twoRooms();
      const runPipeline = vi.fn(async (b: Broadcast) => {
        if (b.roomSlug === "room-a") throw new Error("ffmpeg 挂了");
        ledger.markDone(b.streamKey, "BV");
        return { state: "done" as const, bv: "BV" };
      });
      const r = new Reconciler({
        platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
        runPipeline: runPipeline as never,
        settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
        maxConcurrentPipelines: 2,
      });
      await r.reconcileAll();
      const keyA = keys.find((k) => k.includes("room-a"))!;
      const keyB = keys.find((k) => k.includes("room-b"))!;
      expect(ledger.get(keyA)?.state).toBe("failed");
      expect(ledger.get(keyB)?.state).toBe("done");
      expect(ledger.get(keyA)?.fails).toBe(1);   // 失败计数仍要自增(重试上限靠它)
      ledger.close();
    });
  });

});

// ── #27:清单三态(ok / empty / unreachable)────────────────────────────────
describe("清单三态:失联节点所在的场不选优不收口(#27)", () => {
  type Behavior = "ok" | "reject" | "hang";

  /** 可切换行为的假节点:模拟 空 / reject / 挂起超时 / 恢复。 */
  function flaky(id: string, recordings: NodeRecording[], initial: Behavior) {
    let mode: Behavior = initial;
    const t: Transport = {
      id,
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockImplementation(() => {
        if (mode === "reject") return Promise.reject(new Error("ssh: connection refused"));
        if (mode === "hang") return new Promise<NodeInventory>(() => {});
        return Promise.resolve({ workerId: id, recordings });
      }),
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(true),
      pull: vi.fn<(remotePaths: string[], localDir: string) => Promise<void>>().mockResolvedValue(undefined),
    };
    return { t, set: (m: Behavior) => { mode = m; } };
  }

  function setup(opts: {
    transports: Transport[];
    cfgFor?: (roomSlug: string) => { workers?: string[] };
    extra?: Partial<ReconcilerDeps>;
  }) {
    const ledger = freshLedger();
    const transports = new Map(opts.transports.map((t) => [t.id, t]));
    const pipelineDeps = makePipelineDeps(ledger, transports);
    const notify = vi.fn<(e: NotifyEvent) => void>();
    const runPipeline = vi.fn<(b: Broadcast, deps: PipelineDeps) => Promise<{ state: JobState; bv?: string }>>(
      async (b) => { ledger.markDone(b.streamKey, "BV_OK"); return { state: "done", bv: "BV_OK" }; },
    );
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps,
      runPipeline, settle: fastSettle, sleep: fastSleep,
      reconnectWindowMs: 0, inventoryTimeoutMs: 30, notify,
      ...(opts.cfgFor ? { resolveCfg: (_p: string, room: string) => ({ ...pipelineDeps.cfg, ...opts.cfgFor!(room) }) } : {}),
      ...opts.extra,
    });
    return { ledger, runPipeline, reconciler, notify };
  }

  const warns = (spy: ReturnType<typeof vi.spyOn>): string => spy.mock.calls.map((c) => String(c[0])).join("\n");

  afterEach(() => { vi.restoreAllMocks(); });

  it("empty(可达但无录像)≠ unreachable:空节点不阻塞本场", async () => {
    const live = flaky("live", [makeRec()], "ok");
    const empty = flaky("empty", [], "ok");
    const { ledger, runPipeline, reconciler } = setup({ transports: [live.t, empty.t] });
    await reconciler.reconcileAll();
    expect(runPipeline).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  for (const mode of ["reject", "hang"] as const) {
    it(`${mode}:参与节点失联 → 本轮不选优不建 job、日志含节点;恢复后下一轮正常收口`, async () => {
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [makeRec()], mode);
      const { ledger, runPipeline, reconciler } = setup({ transports: [live.t, lost.t] });

      await reconciler.reconcileAll();
      expect(runPipeline).not.toHaveBeenCalled();
      expect(ledger.listKeys()).toHaveLength(0);          // 没留半截 job
      expect(warns(warnSpy)).toContain("lost");            // 日志指出是哪个节点

      await reconciler.reconcileAll();                      // 仍失联 → 仍不推进、不锁死
      expect(runPipeline).not.toHaveBeenCalled();

      lost.set("ok");                                       // 节点恢复
      await reconciler.reconcileAll();
      expect(runPipeline).toHaveBeenCalledTimes(1);
      expect(runPipeline.mock.calls[0][0].members.map((m) => m.workerId).sort()).toEqual(["live", "lost"]);
      const [k] = ledger.listKeys();
      expect(ledger.get(k.streamKey)?.state).toBe("done");
      ledger.close();
    });
  }

  it("无关场照常:失联节点只挡住规则选中它的房间,其它房间照常收口", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = flaky("live", [makeRec({ roomSlug: "room-a" }), makeRec({ roomSlug: "room-b" })], "ok");
    const lost = flaky("lost", [], "reject");
    const { ledger, runPipeline, reconciler } = setup({
      transports: [live.t, lost.t],
      cfgFor: (room) => (room === "room-a" ? { workers: ["live"] } : { workers: ["live", "lost"] }),
    });
    await reconciler.reconcileAll();
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline.mock.calls[0][0].roomSlug).toBe("room-a");
    ledger.close();
  });

  it("规则未选中的节点失联不影响本场", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = flaky("live", [makeRec()], "ok");
    const lost = flaky("lost", [], "hang");
    const { ledger, runPipeline, reconciler } = setup({
      transports: [live.t, lost.t],
      cfgFor: () => ({ workers: ["live"] }),
    });
    await reconciler.reconcileAll();
    expect(runPipeline).toHaveBeenCalledTimes(1);
    ledger.close();
  });

  it("已 done 的场不受影响:失联期间仍可做收尾补跑,状态不变", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = makeRec();
    const live = flaky("live", [rec], "ok");
    const lost = flaky("lost", [rec], "reject");
    const { ledger, runPipeline, reconciler } = setup({
      transports: [live.t, lost.t],
      extra: { cleanupBackfillThrottleMs: 0 },
    });
    const key = clusterBroadcasts([{ workerId: "live", recordings: [rec] }], 0, "douyin")[0].streamKey;
    ledger.upsertPending(key, rec.startMs);
    ledger.setBv(key, "BV1");
    ledger.markDone(key, "BV1");
    ledger.syncNodeState(key, "clean_source", "failed", { error: "清理失败" });

    await reconciler.reconcileAll();
    expect(runPipeline).toHaveBeenCalledTimes(1);            // 补跑照常
    expect(ledger.get(key)?.state).toBe("done");
    ledger.close();
  });

  it("失联阈值通知:连续 N 轮才发、一次失联期只发一条;恢复后再失联可再报", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = flaky("live", [makeRec()], "ok");
    const lost = flaky("lost", [makeRec()], "reject");
    const { ledger, runPipeline, reconciler, notify } = setup({
      transports: [live.t, lost.t],
      extra: { unreachableAlertRounds: 3 },
    });
    const alerts = (): NotifyEvent[] => notify.mock.calls.map((c) => c[0]).filter((e) => e.kind === "error");

    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(alerts()).toHaveLength(0);                         // 2 轮 < 阈值
    await reconciler.reconcileAll();
    expect(alerts()).toHaveLength(1);                         // 第 3 轮发
    expect(JSON.stringify(alerts()[0])).toContain("lost");
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(alerts()).toHaveLength(1);                         // 之后不重复
    expect(runPipeline).not.toHaveBeenCalled();               // 不转人工、不推进、不删
    expect(ledger.listKeys()).toHaveLength(0);

    lost.set("ok");
    await reconciler.reconcileAll();                           // 恢复 → 计数清零并正常收口
    expect(runPipeline).toHaveBeenCalledTimes(1);
    lost.set("reject");
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(alerts()).toHaveLength(2);                          // 新一轮失联期可再报
    ledger.close();
  });

  it("单轮抖动不累计:失联—恢复—失联 交替不触发通知", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const live = flaky("live", [], "ok");
    const flap = flaky("flap", [], "reject");
    const { ledger, reconciler, notify } = setup({
      transports: [live.t, flap.t],
      extra: { unreachableAlertRounds: 2 },
    });
    for (let i = 0; i < 6; i++) {
      flap.set(i % 2 === 0 ? "reject" : "ok");
      await reconciler.reconcileAll();
    }
    expect(notify.mock.calls.filter((c) => c[0].kind === "error")).toHaveLength(0);
    ledger.close();
  });

  describe("blocked broadcast: queue visibility, needs_manual threshold, run-now 409 (#69)", () => {
    const errors = (n: ReturnType<typeof setup>["notify"]): NotifyEvent[] => n.mock.calls.map((c) => c[0]).filter((e) => e.kind === "error");

    it("exposes the blocked broadcast (node, since, rounds) while a selected worker is unreachable; clears on recovery", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [makeRec()], "reject");
      const { ledger, reconciler } = setup({ transports: [live.t, lost.t], extra: { blockedManualRounds: 5 } });

      expect(reconciler.blockedBroadcasts()).toEqual([]);
      await reconciler.reconcileAll();
      await reconciler.reconcileAll();
      const [b] = reconciler.blockedBroadcasts();
      expect(b).toMatchObject({ workers: ["lost"], rounds: 2, threshold: 5, platform: "douyin" });
      expect(b.sinceMs).toBeGreaterThan(0);
      expect(reconciler.blockedBroadcasts()).toHaveLength(1);

      lost.set("ok");
      await reconciler.reconcileAll();
      expect(reconciler.blockedBroadcasts()).toEqual([]);
      ledger.close();
    });

    it("threshold reached -> needs_manual naming the node + one notify; no pipeline call; never auto-cleared", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [makeRec()], "reject");
      const { ledger, runPipeline, reconciler, notify } = setup({
        transports: [live.t, lost.t], extra: { blockedManualRounds: 3, unreachableAlertRounds: 0 },
      });

      await reconciler.reconcileAll();
      await reconciler.reconcileAll();
      expect(ledger.listKeys()).toHaveLength(0);
      expect(errors(notify)).toHaveLength(0);
      await reconciler.reconcileAll();                       // 3rd consecutive round
      const [k] = ledger.listKeys();
      expect(ledger.get(k.streamKey)?.state).toBe("needs_manual");
      expect(ledger.get(k.streamKey)?.error).toContain("lost");
      expect(errors(notify)).toHaveLength(1);
      expect(JSON.stringify(errors(notify)[0])).toContain("lost");
      expect(reconciler.blockedBroadcasts()).toEqual([]);   // parked rows show in jobs, not in the blocked list

      lost.set("ok");                                        // recovery must NOT auto-clear: a human decides
      await reconciler.reconcileAll();
      await reconciler.reconcileAll();
      expect(ledger.get(k.streamKey)?.state).toBe("needs_manual");
      expect(errors(notify)).toHaveLength(1);
      expect(runPipeline).not.toHaveBeenCalled();
      ledger.close();
    });

    it("blockedManualRounds <= 0 disables the transition (stays blocked and visible)", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [makeRec()], "reject");
      const { ledger, runPipeline, reconciler } = setup({ transports: [live.t, lost.t], extra: { blockedManualRounds: 0 } });
      for (let i = 0; i < 15; i++) await reconciler.reconcileAll();
      expect(ledger.listKeys()).toHaveLength(0);
      expect(runPipeline).not.toHaveBeenCalled();
      expect(reconciler.blockedBroadcasts()[0]).toMatchObject({ rounds: 15, threshold: 0 });
      ledger.close();
    });

    it("recovery before the threshold resumes normally and restarts the count", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [makeRec()], "reject");
      const { ledger, runPipeline, reconciler, notify } = setup({
        transports: [live.t, lost.t], extra: { blockedManualRounds: 3, unreachableAlertRounds: 0 },
      });
      await reconciler.reconcileAll();
      await reconciler.reconcileAll();
      lost.set("ok");
      await reconciler.reconcileAll();
      expect(runPipeline).toHaveBeenCalledTimes(1);
      const [k] = ledger.listKeys();
      expect(ledger.get(k.streamKey)?.state).toBe("done");
      expect(errors(notify)).toHaveLength(0);
      ledger.close();
    });

    it("run-now with an unreachable selected node -> 409 forceable, no pipeline; force proceeds and logs the node", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [makeRec()], "reject");
      const { ledger, runPipeline, reconciler } = setup({ transports: [live.t, lost.t] });
      const key = clusterBroadcasts([{ workerId: "live", recordings: [makeRec()] }], 0, "douyin")[0].streamKey;

      const r = await reconciler.runNow({ streamKey: key, wait: true });
      expect(r).toMatchObject({ ok: false, code: 409, forceable: true });
      expect(r.error).toContain("lost");
      expect(runPipeline).not.toHaveBeenCalled();
      expect(ledger.get(key)).toBeNull();

      const warn = vi.mocked(console.warn);
      const f = await reconciler.runNow({ streamKey: key, wait: true, force: true });
      expect(f.ok).toBe(true);
      expect(runPipeline).toHaveBeenCalledTimes(1);
      expect(runPipeline.mock.calls[0][0].members.map((m) => m.workerId)).toEqual(["live"]);
      expect([...warn.mock.calls, ...info.mock.calls].map((c) => String(c[0])).join("\n")).toMatch(/force over unreachable node\(s\): lost/);
      ledger.close();
    });

    it("run-now is unaffected when the unreachable node is not selected by the rule", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const live = flaky("live", [makeRec()], "ok");
      const lost = flaky("lost", [], "reject");
      const { ledger, runPipeline, reconciler } = setup({ transports: [live.t, lost.t], cfgFor: () => ({ workers: ["live"] }) });
      const key = clusterBroadcasts([{ workerId: "live", recordings: [makeRec()] }], 0, "douyin")[0].streamKey;
      const r = await reconciler.runNow({ streamKey: key, wait: true });
      expect(r.ok).toBe(true);
      expect(runPipeline).toHaveBeenCalledTimes(1);
      ledger.close();
    });
  });
});

describe("unclaimed-segment pass-through + deduped summary log (#225)", () => {
  const seg = (sessionBase: string, segmentIndex: number) => ({
    path: `/r/A/${sessionBase}_00${segmentIndex}.mp4`, sizeBytes: 1, mtimeMs: 1, sessionBase, segmentIndex,
    stampMs: null, stampSource: null, sidecar: "missing" as const, platform: null, roomSlug: null, segmentSec: null,
  });

  function setup(invs: Record<string, () => NodeInventory>) {
    const ledger = freshLedger();
    const transports = new Map<string, Transport>(Object.entries(invs).map(([id, inv]) => [id, {
      ...makeTransport(id, []),
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockImplementation(async () => inv()),
    }]));
    const runPipeline = vi.fn();
    const reconciler = new Reconciler({
      platform: "douyin", transports, ledger, pipelineDeps: makePipelineDeps(ledger, transports),
      runPipeline, settle: fastSettle, sleep: fastSleep, reconnectWindowMs: 0,
    });
    return { ledger, reconciler, transports, runPipeline };
  }
  const summaryLines = (spy: ReturnType<typeof vi.spyOn>) =>
    spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("unclaimed segments") || m.includes("orphan state unknown"));

  afterEach(() => { vi.restoreAllMocks(); });

  it("inventoryWithTimeout copies the unclaimed fields; status still derives from recordings", async () => {
    const { ledger, reconciler, transports } = setup({
      w1: () => ({ workerId: "w1", recordings: [], unclaimedSegments: [seg("A_1", 0)], unclaimedTruncated: 2 }),
      w2: () => ({ workerId: "w2", recordings: [], unclaimedSegments: [seg("A_1", 0)] }),
      old: () => ({ workerId: "old", recordings: [] }),
    });
    const withTimeout = (id: string) =>
      (reconciler as unknown as { inventoryWithTimeout(t: Transport): Promise<unknown> }).inventoryWithTimeout(transports.get(id)!);
    expect(await withTimeout("w1")).toEqual({
      status: "empty", workerId: "w1", recordings: [], unclaimedSegments: [seg("A_1", 0)], unclaimedTruncated: 2,
    });
    expect(await withTimeout("w2")).toMatchObject({ status: "empty", unclaimedTruncated: 0 });
    const old = await withTimeout("old");
    expect(old).toEqual({ status: "empty", workerId: "old", recordings: [] });
    ledger.close();
  });

  it("logs the summary once across identical rounds and again when the count changes", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let segs = [seg("A_1", 0), seg("A_1", 1), seg("A_2", 0)];
    const { ledger, reconciler, runPipeline } = setup({
      w1: () => ({ workerId: "w1", recordings: [], unclaimedSegments: segs, unclaimedTruncated: 0 }),
    });
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(summaryLines(warn)).toEqual(["[reconciler] worker w1 unclaimed segments: 3 in 2 sessions (truncated 0)"]);
    segs = [seg("A_1", 0)];
    await reconciler.reconcileAll();
    expect(summaryLines(warn)).toHaveLength(2);
    expect(summaryLines(warn)[1]).toBe("[reconciler] worker w1 unclaimed segments: 1 in 1 sessions (truncated 0)");
    expect(runPipeline).not.toHaveBeenCalled();
    expect(ledger.listKeys()).toEqual([]);
    ledger.close();
  });

  it("old worker → exactly one 'unknown' line across rounds; empty first sighting logs nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { ledger, reconciler } = setup({
      old: () => ({ workerId: "old", recordings: [] }),
      clean: () => ({ workerId: "clean", recordings: [], unclaimedSegments: [], unclaimedTruncated: 0 }),
    });
    await reconciler.reconcileAll();
    await reconciler.reconcileAll();
    expect(summaryLines(warn)).toEqual([
      "[reconciler] worker old orphan state unknown (worker does not report unclaimed segments)",
    ]);
    ledger.close();
  });
});
