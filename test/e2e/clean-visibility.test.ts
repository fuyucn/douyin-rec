import { afterEach, describe, expect, it } from "vitest";
import { JobAbortedError } from "@drec/core";
import type { Transport } from "@drec/orchestrator";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";

// issue #429 返工:清理失败可见 → 告警一次;合并模式补跑最多 3 次;分段模式只告警不补跑;用户停止不记 failed。
const COMMON = { sourceAfterDone: true, stageAfterDone: true, stageSourceAfterMerge: false } as const;
const CLEAN_ALERT = "清理";

let s: Scenario;
afterEach(() => s?.dispose());

const record = (sc: Scenario): void => {
  sc.record({ sessions: [
    { startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 },
    { startMs: pastStartMs(0, 10, 30) + 10_000, segments: 3, segSec: 600 },
  ] });
};
const cleanAlerts = (sc: Scenario): number =>
  sc.notifications.filter((n) => n.kind === "error" && n.stage === CLEAN_ALERT).length;

/** 包一层 transport:统计 cleanup / pull 调用;`onCleanup` 可在每次删源前注入失败或播种。 */
function probe(onCleanup: (calls: number) => void) {
  const calls = { cleanup: 0, pull: 0 };
  const wrap = (base: Transport): Transport => {
    const t = Object.create(base) as Transport;
    t.cleanup = async (paths) => { calls.cleanup++; onCleanup(calls.cleanup); return base.cleanup!(paths); };
    t.pull = async (remote, dir) => { calls.pull++; return base.pull(remote, dir); };
    return t;
  };
  return { calls, wrap };
}

describe("e2e: 分段模式清理失败只告警、不补跑(#429)", () => {
  it("clean_source failed + 告警 1 次;恢复后多轮对账也不补跑(不重 pull、不再删源、不重复告警)", async () => {
    let fail = true;
    const p = probe(() => { if (fail) throw new Error("注入:节点磁盘只读"); });
    s = await Scenario.create({
      cfg: { steps: { mergeSegments: false }, cleanup: { ...FULL_CLEANUP } },
      cleanupBackfillThrottleMs: 0,
      wrapTransport: (base) => p.wrap(base),
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("done");
    expect(s.ledger.getNodeState(key, "clean_source")?.state).toBe("failed");
    expect(cleanAlerts(s)).toBe(1);
    const pulls = p.calls.pull;
    const cleanups = p.calls.cleanup;

    fail = false;
    for (let i = 0; i < 3; i++) { await s.restart(); await s.reconcile(); }
    expect(p.calls.pull, "补跑会把整场源 pull 回 master").toBe(pulls);
    expect(p.calls.cleanup).toBe(cleanups);
    expect(s.ledger.getNodeState(key, "clean_source")?.state).toBe("failed");
    expect(s.jobState(key)).toBe("done");
    expect(cleanAlerts(s)).toBe(1);
  });
});

describe("e2e: 合并模式补跑次数上限 3(#429)", () => {
  it("清理持续失败:初跑 1 次 + 补跑 3 次后停止;告警只 1 次", async () => {
    const p = probe(() => { throw new Error("注入:节点磁盘只读"); });
    s = await Scenario.create({
      cfg: { cleanup: { ...COMMON } },
      cleanupBackfillThrottleMs: 0,
      wrapTransport: (base) => p.wrap(base),
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    const perRun = p.calls.cleanup; // 每轮对每个成员节点各调一次
    expect(perRun).toBeGreaterThan(0);
    for (let i = 0; i < 6; i++) { await s.restart(); await s.reconcile(); }
    expect(p.calls.cleanup).toBe(perRun * (1 + 3));
    expect(s.ledger.getNodeState(key, "clean_source")?.state).toBe("failed");
    expect(s.ledger.getNodeState(key, "clean_source")?.attempts).toBe(3);
    expect(s.jobState(key)).toBe("done");
    expect(cleanAlerts(s)).toBe(1);
  });

  it("补跑成功 → clean_source 复位 done、attempts 清零,之后不再补跑", async () => {
    let fail = true;
    const p = probe(() => { if (fail) throw new Error("注入:节点磁盘只读"); });
    s = await Scenario.create({
      cfg: { cleanup: { ...COMMON } },
      cleanupBackfillThrottleMs: 0,
      wrapTransport: (base) => p.wrap(base),
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    fail = false;
    await s.restart(); await s.reconcile();
    expect(s.ledger.getNodeState(key, "clean_source")).toMatchObject({ state: "done", attempts: 0 });
    const n = p.calls.cleanup;
    await s.restart(); await s.reconcile();
    expect(p.calls.cleanup).toBe(n);
  });
});

describe("e2e: 成功复位 done 分支(播种旧 failed 行 → 收尾成功后必须翻回 done)(#429)", () => {
  const seed = (keys: string[]) => (sc: () => Scenario) => (): void => {
    for (const k of sc().keys()) for (const node of keys) sc().ledger.syncNodeState(k, node as never, "failed", { error: "旧失败" });
  };

  it("合并主路径 runPipelineInner:clean_stage failed → done", async () => {
    const hook = seed(["clean_stage"]);
    const p = probe(() => hook(() => s)());
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, wrapTransport: (base) => p.wrap(base) });
    record(s);
    await s.reconcile();
    expect(s.ledger.getNodeState(s.onlyKey(), "clean_stage")?.state).toBe("done");
  });

  it("分段主路径 runSegmentPipeline:clean_stage_src / clean_stage failed → done", async () => {
    const hook = seed(["clean_stage_src", "clean_stage"]);
    const p = probe(() => hook(() => s)());
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...FULL_CLEANUP } }, wrapTransport: (base) => p.wrap(base) });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.getNodeState(key, "clean_stage_src")?.state).toBe("done");
    expect(s.ledger.getNodeState(key, "clean_stage")?.state).toBe("done");
  });

  it("合并补跑 resumeAppends:stage 清理首轮失败 → 补跑成功后 clean_stage 复位 done", async () => {
    let fail = true;
    s = await Scenario.create({
      cfg: { cleanup: { stageAfterDone: true, sourceAfterDone: false, stageSourceAfterMerge: false } }, // 不删源:补跑要靠节点上仍有源才会被对账扫到
      cleanupBackfillThrottleMs: 0,
      deps: { rmStage: async (paths: string[]) => { if (fail) throw new Error("注入:stage 只读"); const { rmSync } = await import("node:fs"); for (const x of paths) rmSync(x, { force: true, recursive: true }); } },
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.getNodeState(key, "clean_stage")?.state).toBe("failed");
    expect(cleanAlerts(s)).toBe(1);
    fail = false;
    await s.restart(); await s.reconcile();
    expect(s.ledger.getNodeState(key, "clean_stage")).toMatchObject({ state: "done", attempts: 0 });
  });
});

describe("e2e: 用户停止不记 failed(#429)", () => {
  it("rmStage 抛 JobAbortedError → 不记 clean_stage failed、不告警", async () => {
    s = await Scenario.create({
      cfg: { cleanup: { ...COMMON } },
      deps: { rmStage: async () => { throw new JobAbortedError(); } },
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.getNodeState(key, "clean_stage")?.state).not.toBe("failed");
    expect(cleanAlerts(s)).toBe(0);
  });

  it("transport.cleanup 抛 JobAbortedError → 不记 clean_source failed、不告警", async () => {
    const p = probe(() => { throw new JobAbortedError(); });
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, wrapTransport: (base) => p.wrap(base) });
    record(s);
    await s.reconcile();
    expect(s.ledger.getNodeState(s.onlyKey(), "clean_source")?.state ?? "none").not.toBe("failed");
    expect(cleanAlerts(s)).toBe(0);
  });
});

describe("e2e: 补跑次数只在派发被接受时计数(#429 二轮)", () => {
  it("同场已在执行 → 补跑派发被去重挡掉:attempts 不增、不删源", async () => {
    let fail = true;
    const p = probe(() => { if (fail) throw new Error("注入:节点磁盘只读"); });
    s = await Scenario.create({
      cfg: { cleanup: { ...COMMON } },
      cleanupBackfillThrottleMs: 0,
      wrapTransport: (base) => p.wrap(base),
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.getNodeState(key, "clean_source")?.attempts).toBe(0);
    fail = false;
    await s.restart();
    const before = p.calls.cleanup;
    // 占住该场的活动去重槽(短暂后释放,reconcileAll 末尾的 drain 才不会卡住)。
    const d = (s.reconciler as unknown as { dispatcher: { tryDispatch: (k: string, r: () => Promise<void>) => Promise<void> | null } }).dispatcher;
    expect(d.tryDispatch(key, () => new Promise<void>((r) => setTimeout(r, 100)))).not.toBeNull();
    await s.reconcile();
    expect(p.calls.cleanup).toBe(before);
    expect(s.ledger.getNodeState(key, "clean_source")?.attempts).toBe(0);
    await s.restart(); await s.reconcile(); // 槽已空 → 正常补跑并收敛
    expect(s.ledger.getNodeState(key, "clean_source")?.state).toBe("done");
  });
});

describe("e2e: done 场补跑只清理(#429 二轮)", () => {
  it("done + stage 成品部分已删 + clean_stage failed → 补跑后仍 done、无「删稿重来」告警、不重传", async () => {
    let fail = true;
    s = await Scenario.create({
      cfg: { cleanup: { stageAfterDone: true, sourceAfterDone: false, stageSourceAfterMerge: false } },
      cleanupBackfillThrottleMs: 0,
      deps: { rmStage: async (paths: string[]) => { if (fail) throw new Error("注入:stage 只读"); const { rmSync } = await import("node:fs"); for (const x of paths) rmSync(x, { force: true, recursive: true }); } },
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.getNodeState(key, "clean_stage")?.state).toBe("failed");
    // 部分成品已被(人工 / 上一轮部分成功)删掉:只剩 plain
    const { readdirSync, rmSync } = await import("node:fs");
    const sub = s.stageSubOf(key);
    for (const f of readdirSync(sub)) if (/_(danmu|livechat)\.mp4$/.test(f)) rmSync(`${sub}/${f}`, { force: true });
    const calls = s.fake.calls.length;
    fail = false;
    await s.restart(); await s.reconcile();
    expect(s.jobState(key)).toBe("done");
    expect(s.fake.calls).toHaveLength(calls);
    expect(s.notifications.filter((n) => /删稿重来|产物缺失/.test(String((n as { message?: string }).message)))).toEqual([]);
    expect(s.ledger.getNodeState(key, "clean_stage")?.state).toBe("done");
  });
});

describe("e2e: 分段续跑 resumeSegmentAppends 清理复位 / 记账分支(#429 二轮)", () => {
  const cfg = { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: { ...FULL_CLEANUP, sourceAfterDone: false } } as const;
  const interrupt = async (sc: Scenario): Promise<string> => {
    sc.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });
    await sc.reconcile();
    const key = sc.onlyKey();
    expect(sc.jobState(key)).toBe("done");
    sc.ledger.setState(key, "failed", { error: "进程重启中断" }, { force: true });
    return key;
  };

  it("续跑成功清理 → 旧 failed 的 clean_stage_src / clean_stage 复位 done", async () => {
    s = await Scenario.create({ cfg });
    const key = await interrupt(s);
    s.ledger.syncNodeState(key, "clean_stage_src", "failed", { error: "旧", attempts: 2 });
    s.ledger.syncNodeState(key, "clean_stage", "failed", { error: "旧", attempts: 2 });
    await s.reconcile();
    expect(s.jobState(key)).toBe("done");
    expect(s.ledger.getNodeState(key, "clean_stage_src")).toMatchObject({ state: "done", attempts: 0 });
    expect(s.ledger.getNodeState(key, "clean_stage")).toMatchObject({ state: "done", attempts: 0 });
  });

  it("续跑清理失败 → 记 failed 并告警一次,job 仍 done", async () => {
    let fail = false;
    s = await Scenario.create({
      cfg,
      deps: { rmStage: async (paths: string[]) => { if (fail) throw new Error("注入:stage 只读"); const { rmSync } = await import("node:fs"); for (const x of paths) rmSync(x, { force: true, recursive: true }); } },
    });
    const key = await interrupt(s);
    fail = true;
    await s.reconcile();
    expect(s.jobState(key)).toBe("done");
    expect(s.ledger.getNodeState(key, "clean_stage_src")?.state).toBe("failed");
    expect(s.ledger.getNodeState(key, "clean_stage")?.state).toBe("failed");
    expect(cleanAlerts(s)).toBe(2); // 每个失败节点各告警一次(节点此前非 failed)
  });
});
