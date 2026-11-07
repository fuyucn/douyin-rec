import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordRoomSessions, roomStatsDbPath, readStatsSessions } from "../../packages/app/src/room-stats.js";
import { Reconciler } from "../../packages/orchestrator/src/reconciler.js";
import type { Transport, NodeInventory } from "../../packages/orchestrator/src/transport.js";

// 旁路采集(plans/041)的接线测试:reconciler 每轮清单成功后回调 observeInventory,
// unreachable/empty 节点跳过;回调抛异常不影响 collect(对账主流程)。

const NOW = Date.UTC(2026, 10, 3, 12, 0, 0);

function mkTransport(id: string, recordings: NodeInventory["recordings"], fail = false): Transport {
  return {
    id,
    listInventory: vi.fn(async () => {
      if (fail) throw new Error("ssh boom");
      return { workerId: id, recordings };
    }),
  } as unknown as Transport;
}

/** 构造一个最小可用 Reconciler:只测 collect 阶段,不跑管线(空 broadcasts → 不进 pipeline)。 */
function mkReconciler(transports: Transport[], observe?: (workerId: string, sessions: unknown[]) => void): Reconciler {
  return new Reconciler({
    platform: "douyin",
    transports: new Map(transports.map((t) => [t.id, t])),
    ledger: {
      sweepStale: vi.fn(),
      listKeys: vi.fn(() => []),
      getUploadPlan: vi.fn(() => null),
      get: vi.fn(() => null),
      getCandidates: vi.fn(() => []),
      getNodeStates: vi.fn(() => []),
      listOpenFollowups: vi.fn(() => []),
      listUploadPlans: vi.fn(() => []),
      upsertPending: vi.fn(),
      setState: vi.fn(),
      markFailed: vi.fn(),
      getNodeState: vi.fn(() => null),
      getFailedNodes: vi.fn(() => []),
      syncNodeState: vi.fn(),
    } as unknown as ConstructorParameters<typeof Reconciler>[0]["ledger"],
    // resolveCfg 返回 null = 房间没开 hub → 清空 members、不进管线;collect 仍会跑(我们要测的就是它)
    pipelineDeps: { cfg: undefined } as unknown as ConstructorParameters<typeof Reconciler>[0]["pipelineDeps"],
    resolveCfg: () => null,
    // settle 配置:测试里没有录像在写盘,等 1 轮即过,避免默认 600s 卡死测试
    settle: { maxWaitMs: 50, pollMs: 20 },
    observeInventory: observe as never,
    // 磁盘看门狗/followup/上传轮询等旁路在本测试都无可依赖对象,deps 缺省即跳过
  });
}

const REC = {
  roomSlug: "123",
  platform: "douyin",
  sessionBase: "s_1",
  tsFiles: [],
  durationSec: 3600,
  startMs: NOW - 3_600_000,
  endMs: NOW,
  totalGapSec: 0,
};

describe("reconciler → observeInventory 旁路采集", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "stats-observe-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("ok 节点的清单会回调;empty 与 unreachable 节点跳过", async () => {
    const db = roomStatsDbPath(dir);
    const seen: string[] = [];
    const r = mkReconciler(
      [
        mkTransport("ok-node", [REC]),
        mkTransport("empty-node", []),
        mkTransport("bad-node", [], true),
      ],
      (workerId, sessions) => { seen.push(workerId); recordRoomSessions(db, workerId, sessions as never, NOW); },
    );
    await r.reconcileAll();
    // collect 每轮跑两次(settle 前后各一份权威清单)→ 同一节点回调两次,upsert 幂等
    expect(new Set(seen)).toEqual(new Set(["ok-node"]));
    const rows = readStatsSessions(db, NOW - 24 * 3_600_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].workerId).toBe("ok-node");
  });

  it("observe 回调抛异常不影响对账(不向上传播)", async () => {
    const r = mkReconciler([mkTransport("ok-node", [REC])], () => { throw new Error("stats db locked"); });
    await expect(r.reconcileAll()).resolves.toBeUndefined();
  });
});
