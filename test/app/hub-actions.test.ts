/**
 * hub-actions.test.ts — operator actions extracted from the hub starter (plan 050.5).
 *
 * These are the web API's 400/409 gatekeepers. The cases pin the verdicts that used to be
 * unreachable from a unit test: upload nodes need an explicit force, a live/locked stream cannot
 * be re-run, and the drain probe must skip local and ghost workers while failing on old bundles.
 * Install/uninstall is pinned too - a stop() that leaves handlers behind would let requests hit a
 * dead reconciler.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  createHubActions,
  type HubActions,
  type HubActionsDeps,
} from "../../packages/hub-compose/src/hub-actions.js";
import {
  readBlockedBroadcasts,
  readPoolSnapshot,
  requestHubProbeDrainSupport,
  requestHubRetryNode,
  requestHubStopJob,
} from "../../packages/hub-compose/src/hub-runtime.js";
import type { HubPoolSnapshotDTO } from "../../packages/core/src/api-types.js";
import type { PipelineDeps, Reconciler, ResourcePool, SyncLedger, WorkflowNodeKey } from "../../packages/orchestrator/src/index.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";

const STREAM = "douyin:room1:2026-11-12T10:00:00";

const node = (name: string): WorkflowNodeKey => name as WorkflowNodeKey;

function makePool(lockedKeys: string[] = []) {
  const locked = new Set(lockedKeys);
  const withStreamLock = vi.fn(async (_key: string, fn: () => Promise<unknown>) => fn());
  const snapshot = vi.fn(() => ({ marker: "pool" }) as unknown as HubPoolSnapshotDTO);
  const pool = {
    hasStreamLock: (key: string) => locked.has(key),
    withStreamLock,
    snapshot,
  } as unknown as ResourcePool;
  return { pool, withStreamLock, snapshot };
}

function makeReconciler() {
  return {
    stopJob: vi.fn(async () => ({ ok: true })),
    ackJob: vi.fn(() => ({ ok: true })),
    runNow: vi.fn(async () => ({ ok: true })),
    blockedBroadcasts: vi.fn(() => [{ marker: "blocked" }]),
  } as unknown as Reconciler;
}

interface HarnessOptions {
  job?: { bv?: string; outputStem?: string };
  nodeState?: Record<string, { state: string; error?: string }>;
  poolLocked?: string[];
  workers?: Array<{ id: string; kind: string; name?: string }>;
  transports?: Map<string, Transport>;
}

let live: HubActions | undefined;

function makeActions(over: Partial<HubActionsDeps> = {}, opts: HarnessOptions = {}) {
  const setState = vi.fn();
  const warnings: string[] = [];
  const poolParts = makePool(opts.poolLocked);
  const ledger = {
    get: vi.fn(() => opts.job),
    getNodeState: vi.fn((_key: string, n: WorkflowNodeKey) => opts.nodeState?.[n]),
    setState,
    backfillNodeStates: vi.fn(),
    markDone: vi.fn(),
  } as unknown as SyncLedger;
  const deps: HubActionsDeps = {
    log: () => {},
    warn: (m: string) => warnings.push(m),
    ledger,
    pool: poolParts.pool,
    resolveCfg: () => null,
    workers: () => opts.workers ?? [{ id: "local", kind: "local" }, { id: "w1", kind: "remote", name: "VPS2" }],
    transports: () => opts.transports ?? new Map(),
    pipelineDeps: {} as PipelineDeps,
    onEvent: () => {},
    stageDir: () => "/tmp/stage",
    ...over,
  };
  const actions = createHubActions(deps);
  live = actions;
  return { actions, deps, ledger, warnings, poolParts, setState };
}

afterEach(() => {
  live?.uninstall();
  live = undefined;
});

describe("retryNode verdicts", () => {
  it("rejects a node outside the re-run whitelist before touching the ledger", async () => {
    const { actions, setState, poolParts } = makeActions();
    const r = await actions.retryNode(STREAM, node("probe"));
    expect(r.code).toBe(400);
    expect(r.error).toContain("不可重跑的节点");
    expect(setState).not.toHaveBeenCalled();
    expect(poolParts.withStreamLock).not.toHaveBeenCalled();
  });

  it("holds upload nodes behind an explicit force", async () => {
    const { actions, setState } = makeActions();
    const refused = await actions.retryNode(STREAM, node("upload_plain"));
    expect(refused.code).toBe(400);
    expect(refused.error).toContain("需确认后才可重跑");
    expect(setState).not.toHaveBeenCalled();

    // force=true walks past the confirmation gate and reaches the ledger transition.
    const forced = await actions.retryNode(STREAM, node("upload_plain"), true);
    expect(setState).toHaveBeenCalledWith(STREAM, "retrying", {}, { force: true });
    expect(forced.code).toBe(400);
    expect(forced.error).toContain("房间未开 hub");
  });

  it("rejects a malformed stream key", async () => {
    const { actions } = makeActions();
    expect(await actions.retryNode("douyin:room1", node("merge"))).toMatchObject({ code: 400 });
  });

  it("refuses a live or locked stream with 409 instead of queueing behind it", async () => {
    const { actions, poolParts, setState } = makeActions({}, { poolLocked: [STREAM] });
    const r = await actions.retryNode(STREAM, node("merge"));
    expect(r).toMatchObject({ code: 409, ok: false });
    expect(r.error).toContain("任务正在执行");
    expect(poolParts.withStreamLock).not.toHaveBeenCalled();
    expect(setState).not.toHaveBeenCalled();
  });

  it("blocks a P1 re-run once the submission already has parts", async () => {
    const { actions } = makeActions({}, {
      job: { bv: "BV1abc" },
      nodeState: { append_danmu: { state: "done" } },
    });
    const r = await actions.retryNode(STREAM, node("upload_plain"), true);
    expect(r.code).toBe(409);
    expect(r.error).toContain("BV1abc");
  });
});

describe("probeDrainSupport", () => {
  const caps = (drain: boolean, id = "w1"): Transport => ({
    id,
    nodeCapabilities: async () => ({ biliup: true, cookies: true, diskFreeGB: 100, zeroDisk: true, drain }),
  }) as unknown as Transport;

  it("skips local and unknown workers without probing their transport", async () => {
    const asked: string[] = [];
    const transports = new Map<string, Transport>([[
      "local",
      { id: "local", nodeCapabilities: async () => { asked.push("local"); return { drain: false }; } } as unknown as Transport,
    ]]);
    const { actions, warnings } = makeActions({}, { transports });
    const r = await actions.probeDrainSupport(["local", "ghost"]);
    expect(r).toEqual({ ok: true });
    expect(asked).toEqual([]);
    expect(warnings.join("\n")).toContain("ghost");
  });

  it("passes only when every bound node reports drain support", async () => {
    const transports = new Map<string, Transport>([["w1", caps(true)]]);
    const { actions } = makeActions({}, { transports });
    expect(await actions.probeDrainSupport(["w1"])).toEqual({ ok: true });
  });

  it("fails on an old bundle instead of falling back to a hard stop", async () => {
    const transports = new Map<string, Transport>([["w1", { id: "w1" } as unknown as Transport]]);
    const { actions } = makeActions({}, { transports });
    const r = await actions.probeDrainSupport(["w1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("旧 bundle");
  });

  it("fails when the node is unreachable", async () => {
    const transports = new Map<string, Transport>([["w1", {
      id: "w1",
      nodeCapabilities: async () => { throw new Error("ssh timeout"); },
    } as unknown as Transport]]);
    const { actions } = makeActions({}, { transports });
    const r = await actions.probeDrainSupport(["w1"]);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("ssh timeout");
  });

  it("fails when a node has no transport at all", async () => {
    const { actions } = makeActions({}, { transports: new Map() });
    const r = await actions.probeDrainSupport(["w1"]);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toContain("没有可用通道");
  });
});

describe("install / uninstall", () => {
  it("publishes every handler on install and clears them on uninstall", async () => {
    const { actions, poolParts } = makeActions();
    const reconciler = makeReconciler();
    actions.install(reconciler);

    expect(await requestHubRetryNode(STREAM, "probe")).toMatchObject({ code: 400 });
    expect(await requestHubStopJob(STREAM)).toEqual({ ok: true });
    expect(readPoolSnapshot()).toEqual({ marker: "pool" });
    expect(readBlockedBroadcasts()).toEqual([{ marker: "blocked" }]);

    actions.uninstall();
    expect(await requestHubRetryNode(STREAM, "merge")).toEqual({ ok: false, error: "hub 未启动", code: 400 });
    expect(await requestHubStopJob(STREAM)).toEqual({ ok: false, error: "hub 未启动", code: 400 });
    expect(await requestHubProbeDrainSupport(["w1"])).toEqual({ ok: false, error: "hub 未启动" });
    expect(readPoolSnapshot()).toBeUndefined();
    expect(readBlockedBroadcasts()).toEqual([]);
    expect(poolParts.withStreamLock).not.toHaveBeenCalled();
  });
});
