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
    isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(false),
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
      isDone: vi.fn<(roomSlug: string) => Promise<boolean>>().mockResolvedValue(false),
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
    };

    const reconciler = new Reconciler(deps);
    // Should not throw despite dead transport
    await expect(reconciler.reconcileAll()).resolves.toBeUndefined();
    // The live node's recording should still be processed
    expect(spyRunPipeline).toHaveBeenCalledTimes(1);

    ledger.close();
  });
});
