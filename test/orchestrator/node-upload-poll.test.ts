// plan 038 T13: nodeUpload config, queue/blocking gate, queue poller, sweep exemption, re-entry guard.
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NotifyEvent, ProcessReceipt } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { Reconciler } from "../../packages/orchestrator/src/reconciler.js";
import {
  DEFAULT_NODE_UPLOAD, QUEUE_CAPABILITY, canFallbackToBlocking, decideUploadMode, parseNodeUploadConfig, rollingEnabledCount,
  type NodeUploadConfig,
} from "../../packages/orchestrator/src/node-upload-config.js";
import { createUploadQueuePoller } from "../../packages/orchestrator/src/node-upload-poll.js";
import { ensureUploadPlan, type UploadInput } from "../../packages/orchestrator/src/node-upload-queue.js";
import { ProcUnsupported, type NodeTasks, type Transport } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:1:2026-10-17";
const fresh = (): SyncLedger => new SyncLedger(join(mkdtempSync(join(tmpdir(), "nup-")), "j.db"));
const input: UploadInput = {
  prep: { segments: ["/n/recordings/a.ts"], stageDir: "/n/stage/k", stem: "s", mergeSegments: true, segmentGroupSec: 0, minSegmentSec: 2, tsDirect: false },
  meta: { cookies: "/n/c.json", title: "t", tid: 21, tag: "x", expectedDurationSec: 600 },
  owner: { streamKey: KEY },
};
const queueCfg: NodeUploadConfig = { ...DEFAULT_NODE_UPLOAD, mode: "queue" };
const rec = (id: string, state: ProcessReceipt["state"]): ProcessReceipt => ({ jobId: id, state, leaseAlive: true });

describe("parseNodeUploadConfig", () => {
  it("defaults to blocking with safe numbers when absent or not an object", () => {
    for (const raw of [undefined, null, "queue", 5, []]) expect(parseNodeUploadConfig(raw)).toEqual(DEFAULT_NODE_UPLOAD);
    expect(DEFAULT_NODE_UPLOAD.mode).toBe("blocking");
  });

  it("only the exact string 'queue' opts in; typos stay blocking", () => {
    expect(parseNodeUploadConfig({ mode: "queue" }).mode).toBe("queue");
    for (const mode of ["Queue", "queued", true, 1, ""]) expect(parseNodeUploadConfig({ mode }).mode).toBe("blocking");
  });

  it("falls back per field for bad or too-small numbers and keeps good ones", () => {
    expect(parseNodeUploadConfig({ pollMs: 120_000, unreachableAlertMs: 5_000, concurrency: 2 }))
      .toEqual({ mode: "blocking", pollMs: 120_000, unreachableAlertMs: 5_000, concurrency: 2 });
    expect(parseNodeUploadConfig({ pollMs: 10, unreachableAlertMs: "x", concurrency: 0 }))
      .toEqual(DEFAULT_NODE_UPLOAD);
  });
});

describe("decideUploadMode", () => {
  const ok = { cfg: queueCfg, capabilities: [QUEUE_CAPABILITY], rollingEnabledCount: 0, runNowGuard: true };

  it("queues only when configured and every precondition is confirmed", () => {
    expect(decideUploadMode(ok)).toEqual({ mode: "queue" });
  });

  it.each([
    ["default config", { ...ok, cfg: DEFAULT_NODE_UPLOAD }, /blocking \(default\)/],
    ["biliup-queue capability absent (before T15)", { ...ok, capabilities: ["biliup", "upload-prep"] }, /biliup-queue/],
    ["capabilities unknown", { ...ok, capabilities: undefined }, /biliup-queue/],
    ["rolling upload present", { ...ok, rollingEnabledCount: 2 }, /rolling/],
    ["rolling status unknown", { ...ok, rollingEnabledCount: null }, /could not confirm/],
    ["-N 409 gate absent (T17)", { ...ok, runNowGuard: false }, /runNow/],
  ])("stays blocking: %s", (_n, i, re) => {
    const d = decideUploadMode(i);
    expect(d.mode).toBe("blocking");
    expect((d as { reason: string }).reason).toMatch(re);
  });
});

describe("rollingEnabledCount (T13b)", () => {
  const withTasks = (tasks: Array<Record<string, unknown>>): Transport =>
    ({ id: "n1", listTasks: async () => ({ workerId: "n1", tasks } as unknown as NodeTasks) } as Transport);

  it("counts tasks with rolling enabled by config, including disabled ones", async () => {
    const t = withTasks([
      { rollingEffective: true, rollingUpload: true, enabled: true },
      { rollingEffective: true, rollingUpload: true, enabled: false },
      { rollingEffective: false, rollingUpload: false, enabled: true },
    ]);
    expect(await rollingEnabledCount(t)).toBe(2);
  });

  it("zero when no task uses rolling; legacy flag alone still counts", async () => {
    expect(await rollingEnabledCount(withTasks([{ rollingEffective: false, rollingUpload: false }]))).toBe(0);
    expect(await rollingEnabledCount(withTasks([{ rollingUpload: true }]))).toBe(1);
    expect(await rollingEnabledCount(withTasks([]))).toBe(0);
  });

  it("unknown (null) without a channel, on failure, or when the DTO has no rolling fields", async () => {
    expect(await rollingEnabledCount({ id: "n1" } as Transport)).toBeNull();
    expect(await rollingEnabledCount({ id: "n1", listTasks: async () => { throw new Error("ssh"); } } as Transport)).toBeNull();
    expect(await rollingEnabledCount(withTasks([{ enabled: true }]))).toBeNull();
  });

  it("feeds the gate: rolling present -> blocking, absent -> queue allowed", async () => {
    const gate = async (tasks: Array<Record<string, unknown>>) => decideUploadMode({
      cfg: queueCfg, capabilities: [QUEUE_CAPABILITY], runNowGuard: true, rollingEnabledCount: await rollingEnabledCount(withTasks(tasks)),
    });
    expect((await gate([{ rollingEffective: true, rollingUpload: true }])).mode).toBe("blocking");
    expect((await gate([{ rollingEffective: false, rollingUpload: false }])).mode).toBe("queue");
  });
});

describe("canFallbackToBlocking", () => {
  const t = (fn: Transport["procStatus"]): Transport => ({ id: "n1", procStatus: fn } as Transport);

  it.each(["pending", "running", "uncertain"] as const)("refuses while a row is %s", async (state) => {
    const r = await canFallbackToBlocking(t(async () => [rec("j1", state)]), ["j1"]);
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain(state);
  });

  it.each(["done", "failed", "cancelled"] as const)("allows when every row is %s, or the node knows no rows", async (state) => {
    expect(await canFallbackToBlocking(t(async () => [rec("j1", state)]), ["j1"])).toEqual({ ok: true });
    expect(await canFallbackToBlocking(t(async () => []), ["j1"])).toEqual({ ok: true });
  });

  it("treats an unreachable node, an old bundle and a missing channel as unknown (refused)", async () => {
    const down = await canFallbackToBlocking(t(async () => { throw new Error("ssh timeout"); }), ["j1"]);
    expect(down).toMatchObject({ ok: false });
    expect((down as { reason: string }).reason).toMatch(/unreachable.*unknown/);
    expect(await canFallbackToBlocking(t(async () => { throw new ProcUnsupported(); }), ["j1"])).toMatchObject({ ok: false });
    expect(await canFallbackToBlocking({ id: "n1" } as Transport, ["j1"])).toMatchObject({ ok: false });
  });
});

describe("createUploadQueuePoller", () => {
  function setup(procStatus: Transport["procStatus"], over: { nodeIds?: string[] } = {}) {
    const ledger = fresh();
    ledger.upsertPending(KEY);
    ledger.setState(KEY, "syncing"); ledger.setState(KEY, "merging"); ledger.setState(KEY, "uploading");
    const plan = ensureUploadPlan(ledger, KEY, "n1", input);
    const abort = vi.fn();
    const enqueue = vi.fn(async (req) => ({ v: 1 as const, results: req.jobs.map((j: { jobId: string }) => ({ jobId: j.jobId, state: "pending" as const })) }));
    const t = { id: "n1", procStatus, enqueue, abortNodePipeline: abort } as unknown as Transport;
    const map = new Map(over.nodeIds ? over.nodeIds.map((id) => [id, t]) : [["n1", t]]);
    const clock = { t: 1_000_000 };
    const notify = vi.fn<(e: NotifyEvent) => void>();
    const seen: string[] = [];
    const poller = createUploadQueuePoller({
      ledger, transports: () => map, unreachableAlertMs: 600_000, notify, now: () => clock.t,
      onDispatch: (_k, _p, d) => { seen.push(d.phase); },
    });
    return { ledger, plan, abort, enqueue, poller, clock, notify, seen, map };
  }

  it("advances an order, touches the ledger and never calls _node-abort", async () => {
    const s = setup(async () => []);
    const before = s.ledger.get(KEY)!.updatedAt;
    await new Promise((r) => setTimeout(r, 5));
    await s.poller.poll();
    expect(s.seen).toEqual(["prep-enqueued"]);
    expect(s.enqueue).toHaveBeenCalledTimes(1);
    expect(s.ledger.get(KEY)!.updatedAt).toBeGreaterThan(before);
    expect(s.ledger.get(KEY)!.state).toBe("uploading");
    expect(s.abort).not.toHaveBeenCalled();
  });

  it("an unreachable node changes nothing, alerts once after the grace period, and recovery re-arms it", async () => {
    let up = false;
    const s = setup(async () => { if (!up) throw new Error("ssh timeout"); return []; });
    await s.poller.poll();
    expect(s.notify).not.toHaveBeenCalled();
    s.clock.t += 600_000;
    await s.poller.poll();
    await s.poller.poll();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.ledger.get(KEY)!.state).toBe("uploading");
    expect(s.abort).not.toHaveBeenCalled();
    up = true;
    await s.poller.poll();
    up = false;
    s.clock.t += 1;
    await s.poller.poll();
    s.clock.t += 600_000;
    await s.poller.poll();
    expect(s.notify).toHaveBeenCalledTimes(2);
  });

  it("an old node bundle (ProcUnsupported) alerts immediately; other orders still get polled", async () => {
    const s = setup(async () => { throw new ProcUnsupported("old"); });
    await s.poller.poll();
    expect(s.notify).toHaveBeenCalledTimes(1);
    expect(s.ledger.get(KEY)!.state).toBe("uploading");
  });

  it("an order pinned to a node missing from the hub config is skipped without state change", async () => {
    const s = setup(async () => [], { nodeIds: ["other"] });
    await s.poller.poll();
    expect(s.seen).toEqual([]);
    expect(s.ledger.get(KEY)!.state).toBe("uploading");
  });

  it("skips a malformed persisted plan instead of throwing", async () => {
    const s = setup(async () => []);
    s.ledger.setUploadPlan(KEY, "{not json");
    await expect(s.poller.poll()).resolves.toBeUndefined();
    expect(s.seen).toEqual([]);
  });

  it("terminal ledger states are not polled", async () => {
    const s = setup(async () => []);
    s.ledger.markDone(KEY, "BV1abcdefghi"); // issue-guard: allow (fake BV fixture)
    await s.poller.poll();
    expect(s.seen).toEqual([]);
  });
});

describe("Reconciler with queue-managed orders", () => {
  async function staleOrder(withPlan: boolean): Promise<SyncLedger> {
    const ledger = fresh();
    ledger.upsertPending(KEY);
    ledger.setState(KEY, "syncing"); ledger.setState(KEY, "merging"); ledger.setState(KEY, "uploading");
    if (withPlan) ensureUploadPlan(ledger, KEY, "n1", input);
    await new Promise((r) => setTimeout(r, 5));
    const r = new Reconciler({
      platform: "douyin", transports: new Map(), ledger, staleMs: 0,
      pipelineDeps: { transports: new Map(), ledger, sh: async () => {}, uploadPlain: async () => "BV", appendGroup: async () => {}, notify: () => {}, cfg: { cleanMaxGapSec: 30, stageDir: "/tmp/s", cookies: "/c", uploadMode: "upload", uploadMeta: { tag: "x", tid: 21, desc: "" } } },
      settle: { maxWaitMs: 1, pollMs: 1 }, sleep: async () => {},
    });
    await r.reconcileAll();
    return ledger;
  }

  it("sweepStale does not fail an in-flight queued order, but still fails an unplanned stale one", async () => {
    expect((await staleOrder(true)).get(KEY)!.state).toBe("uploading");
    expect((await staleOrder(false)).get(KEY)!.state).toBe("failed");
  });

  it("never re-enters the pipeline for a failed order that has a queue plan", async () => {
    const ledger = fresh();
    const recording = { roomSlug: "test-room", platform: "douyin", sessionBase: "a_2026-06-22_08-00-00", tsFiles: ["/r/a.ts"], durationSec: 3600,
      startMs: new Date("2026-06-22T08:00:00Z").getTime(), endMs: new Date("2026-06-22T09:00:00Z").getTime(), totalGapSec: 0 };
    const t: Transport = {
      id: "n1", listInventory: async () => ({ workerId: "n1", recordings: [recording] }), isDone: async () => true, pull: async () => {},
    };
    const keys: string[] = [];
    const runPipeline = vi.fn(async (b: { streamKey: string }) => { keys.push(b.streamKey); throw new Error("boom"); });
    const mk = (): Reconciler => new Reconciler({
      platform: "douyin", transports: new Map([["n1", t]]), ledger, runPipeline: runPipeline as never,
      pipelineDeps: { transports: new Map([["n1", t]]), ledger, sh: async () => {}, uploadPlain: async () => "BV", appendGroup: async () => {}, notify: () => {}, cfg: { cleanMaxGapSec: 30, stageDir: "/tmp/s", cookies: "/c", uploadMode: "upload", uploadMeta: { tag: "x", tid: 21, desc: "" } } },
      settle: { maxWaitMs: 1, pollMs: 1 }, sleep: async () => {},
    });
    await mk().reconcileAll();
    // Dispatch is non-blocking, so wait for the failure to land instead of assuming reconcileAll awaited it.
    await vi.waitFor(() => {
      expect(runPipeline).toHaveBeenCalledTimes(1);
      expect(ledger.get(keys[0]!)?.state).toBe("failed");
    });

    ensureUploadPlan(ledger, keys[0]!, "n1", { ...input, owner: { streamKey: keys[0]! } });
    await mk().reconcileAll();
    await new Promise((r) => setTimeout(r, 50));
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });
});
