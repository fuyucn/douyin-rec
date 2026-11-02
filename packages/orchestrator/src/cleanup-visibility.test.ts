/**
 * issue #429 返工:清理失败的记账 / 告警 / 复位口径(单点 helper + cleanupSourcesShared + finalizeOnly)。
 * 删哪些文件的判定不在此测(见 survivors-cleanup.test.ts);这里只验「失败是否被看见、是否收敛」。
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobAbortedError, type NotifyEvent } from "@drec/core";
import { SyncLedger } from "./ledger.js";
import {
  cleanupSourcesShared, clearCleanFailure, finalizeOnly, recordCleanFailure,
  type PipelineCfg, type PipelineDeps,
} from "./pipeline.js";
import type { Transport } from "./transport.js";

const K = "douyin:r1:2026-01-01";
let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

const alerts = (ev: NotifyEvent[]): NotifyEvent[] => ev.filter((e) => e.kind === "error" && e.stage === "清理");

describe("recordCleanFailure / clearCleanFailure", () => {
  it("首次失败记 failed 并告警;再次失败(补跑)不重复告警、attempts 原样保留", () => {
    const l = new SyncLedger(":memory:"); l.upsertPending(K);
    const ev: NotifyEvent[] = [];
    const rec = () => recordCleanFailure({ ledger: l, streamKey: K, node: "clean_stage", error: "x", notify: (e) => ev.push(e), log: () => {} });
    rec();
    l.syncNodeState(K, "clean_stage", "failed", { error: "x", attempts: 2 });
    rec();
    expect(l.getNodeState(K, "clean_stage")).toMatchObject({ state: "failed", attempts: 2 });
    expect(alerts(ev)).toHaveLength(1);
  });

  it("用户停止(abort)→ 不记 failed、不告警", () => {
    const l = new SyncLedger(":memory:"); l.upsertPending(K);
    const ev: NotifyEvent[] = []; const logs: string[] = [];
    recordCleanFailure({ ledger: l, streamKey: K, node: "clean_stage", error: "x", cause: new JobAbortedError(), notify: (e) => ev.push(e), log: (m) => logs.push(m) });
    expect(l.getNodeState(K, "clean_stage")).toBeNull();
    expect(ev).toHaveLength(0);
    expect(logs.join()).toContain("用户停止");
  });

  it("clear:仅把 failed 复位 done(attempts 清零);无旧行不造行", () => {
    const l = new SyncLedger(":memory:"); l.upsertPending(K);
    clearCleanFailure(l, K, "clean_stage");
    expect(l.getNodeState(K, "clean_stage")).toBeNull();
    l.syncNodeState(K, "clean_stage", "failed", { error: "x", attempts: 3 });
    clearCleanFailure(l, K, "clean_stage");
    expect(l.getNodeState(K, "clean_stage")).toMatchObject({ state: "done", error: null, attempts: 0 });
  });
});

describe("cleanupSourcesShared:失败记账 + 无可删/开关关 → 复位", () => {
  const mk = (cleanupFn: Transport["cleanup"]) => {
    const l = new SyncLedger(":memory:"); l.upsertPending(K);
    const t = { id: "n1", cleanup: cleanupFn } as unknown as Transport;
    const ev: NotifyEvent[] = [];
    const run = (cleanup: Parameters<typeof cleanupSourcesShared>[0]["cleanup"], extra: { stagePulledSources?: string[]; rmStage?: (p: string[]) => Promise<void> } = {}) =>
      cleanupSourcesShared({
        streamKey: K, ledger: l, transports: new Map([["n1", t]]),
        members: [{ workerId: "n1", rec: { tsFiles: ["/r/a.ts"] } }],
        cleanup, rmStage: extra.rmStage ?? (async () => {}), stagePulledSources: extra.stagePulledSources,
        log: () => {}, notify: (e) => ev.push(e),
      });
    return { l, ev, run };
  };

  it("transport 失败 → clean_source failed + 告警一次;二次失败不再告警", async () => {
    const { l, ev, run } = mk(async () => { throw new Error("只读"); });
    expect((await run({ sourceAfterDone: true })).ok).toBe(false);
    expect((await run({ sourceAfterDone: true })).ok).toBe(false);
    expect(l.getNodeState(K, "clean_source")?.state).toBe("failed");
    expect(alerts(ev)).toHaveLength(1);
  });

  it("transport 抛 abort → 不记 failed、不告警(outcome 仍 ok=false,不会被当成已删净)", async () => {
    const { l, ev, run } = mk(async () => { throw new JobAbortedError(); });
    expect((await run({ sourceAfterDone: true })).ok).toBe(false);
    expect(l.getNodeState(K, "clean_source")).toBeNull();
    expect(ev).toHaveLength(0);
  });

  it("成功 → 旧 failed 的 clean_source 复位 done", async () => {
    const { l, run } = mk(async () => {});
    l.syncNodeState(K, "clean_source", "failed", { error: "旧", attempts: 2 });
    expect((await run({ sourceAfterDone: true })).ok).toBe(true);
    expect(l.getNodeState(K, "clean_source")).toMatchObject({ state: "done", attempts: 0 });
  });

  it("开关已关(sourceAfterDone / stageSourceAfterMerge 关)→ 旧 failed 行复位 done,不能无限补跑", async () => {
    const { l, run } = mk(async () => {});
    l.syncNodeState(K, "clean_source", "failed", { error: "旧" });
    l.syncNodeState(K, "clean_stage_src", "failed", { error: "旧" });
    await run({ sourceAfterDone: false, stageSourceAfterMerge: false }, { stagePulledSources: ["/s/a.ts"] });
    expect(l.getNodeState(K, "clean_source")?.state).toBe("done");
    expect(l.getNodeState(K, "clean_stage_src")?.state).toBe("done");
  });

  it("clean_stage_src:rmStage 失败 → failed + 告警;成功 → 复位 done", async () => {
    const { l, ev, run } = mk(async () => {});
    const cfg = { stageSourceAfterMerge: true };
    await run(cfg, { stagePulledSources: ["/s/a.ts"], rmStage: async () => { throw new Error("busy"); } });
    expect(l.getNodeState(K, "clean_stage_src")?.state).toBe("failed");
    expect(alerts(ev)).toHaveLength(1);
    await run(cfg, { stagePulledSources: ["/s/a.ts"] });
    expect(l.getNodeState(K, "clean_stage_src")?.state).toBe("done");
  });
});

describe("clean_source 失败节点集合(同场多节点,#429 二轮)", () => {
  const mk = (failing: Set<string>, abortFor: Set<string> = new Set()) => {
    const l = new SyncLedger(":memory:"); l.upsertPending(K);
    const ev: NotifyEvent[] = [];
    const transport = (id: string) => ({
      id,
      cleanup: async () => { if (abortFor.has(id)) throw new JobAbortedError(); if (failing.has(id)) throw new Error(`${id} 只读`); },
    }) as unknown as Transport;
    const run = (ids: string[]) => cleanupSourcesShared({
      streamKey: K, ledger: l, transports: new Map(ids.map((id) => [id, transport(id)])),
      members: ids.map((id) => ({ workerId: id, rec: { tsFiles: [`/r/${id}.ts`] } })),
      cleanup: { sourceAfterDone: true }, rmStage: async () => {}, log: () => {}, notify: (e) => ev.push(e),
    });
    return { l, ev, run, failing, abortFor };
  };

  it("A、B 双录都失败 → 下轮 A 失联、B 删净 → 行仍 failed(不复位、不重复告警);A、B 都在且删净才复位", async () => {
    const { l, ev, run, failing } = mk(new Set(["A", "B"]));
    await run(["A", "B"]);
    expect(l.getNodeState(K, "clean_source")?.state).toBe("failed");
    failing.clear();
    await run(["B"]); // A 失联:只含可达成员
    expect(l.getNodeState(K, "clean_source")?.state).toBe("failed");
    expect(alerts(ev)).toHaveLength(1);
    await run(["B"]);
    expect(l.getNodeState(K, "clean_source")?.state).toBe("failed");
    await run(["A", "B"]);
    expect(l.getNodeState(K, "clean_source")).toMatchObject({ state: "done", attempts: 0 });
  });

  it("A 失败 B 成功 → 失败集只含 A;下轮 A 回来删净 → 复位", async () => {
    const { l, run, failing } = mk(new Set(["A"]));
    await run(["A", "B"]);
    expect(JSON.parse(l.getNodeState(K, "clean_source")!.error!).nodes).toEqual(["A"]);
    failing.clear();
    await run(["A", "B"]);
    expect(l.getNodeState(K, "clean_source")?.state).toBe("done");
  });

  it("本轮 B 失败、上轮失败的 A 不在成员内 → 失败集 = A ∪ B(旧失败不丢)", async () => {
    const { l, run, failing } = mk(new Set(["A"]));
    await run(["A"]);
    failing.clear(); failing.add("B");
    await run(["B"]);
    expect(JSON.parse(l.getNodeState(K, "clean_source")!.error!).nodes.sort()).toEqual(["A", "B"]);
  });

  it("老行(error 是纯文本、无节点集合)→ 成功后照旧整行复位(向后兼容)", async () => {
    const { l, run } = mk(new Set());
    l.syncNodeState(K, "clean_source", "failed", { error: "磁盘满", attempts: 1 });
    await run(["B"]);
    expect(l.getNodeState(K, "clean_source")?.state).toBe("done");
  });

  it("混合:A abort、B 真失败 → 按真实失败记 failed(集合只含 B)并告警一次;全是 abort 才跳过记账", async () => {
    const { l, ev, run, failing, abortFor } = mk(new Set(["B"]), new Set(["A"]));
    await run(["A", "B"]);
    expect(l.getNodeState(K, "clean_source")?.state).toBe("failed");
    expect(JSON.parse(l.getNodeState(K, "clean_source")!.error!).nodes).toEqual(["B"]);
    expect(alerts(ev)).toHaveLength(1);

    const only = mk(new Set(), new Set(["A", "B"]));
    await only.run(["A", "B"]);
    expect(only.l.getNodeState(K, "clean_source")).toBeNull();
    expect(failing.size + abortFor.size).toBeGreaterThan(0);
  });
});

describe("finalizeOnly:补清 stage 的记账 / 复位", () => {
  const setup = (cleanup: PipelineCfg["cleanup"], rmStage: (p: string[]) => Promise<void>, withLeftover: boolean) => {
    dir = mkdtempSync(join(tmpdir(), "cv-"));
    const stageSub = join(dir, "sub"); mkdirSync(stageSub);
    if (withLeftover) writeFileSync(join(stageSub, "a.ts"), "x");
    const ledger = new SyncLedger(":memory:"); ledger.upsertPending(K);
    ledger.markDone(K, "BV1");
    const ev: NotifyEvent[] = [];
    const deps = {
      ledger, transports: new Map(), cfg: { stageDir: dir, cleanup } as PipelineCfg,
      rmStage, notify: (e: NotifyEvent) => ev.push(e), countParts: async () => 0, sleep: async () => {},
    } as unknown as PipelineDeps;
    const run = () => finalizeOnly(K, "BV1", deps, () => {}, (e) => ev.push(e), [], stageSub);
    return { ledger, ev, run };
  };

  it("rmStage 失败 → clean_stage failed + 告警;换成功后补跑 → 复位 done", async () => {
    let fail = true;
    const { ledger, ev, run } = setup({ stageAfterDone: true }, async () => { if (fail) throw new Error("busy"); }, true);
    await run();
    expect(ledger.getNodeState(K, "clean_stage")?.state).toBe("failed");
    expect(alerts(ev)).toHaveLength(1);
    fail = false;
    await run();
    expect(ledger.getNodeState(K, "clean_stage")?.state).toBe("done");
  });

  it("补跑时 stage 已无可补清内容(left 为空)→ 直接复位 done", async () => {
    const { ledger, run } = setup({ stageAfterDone: true }, async () => { throw new Error("不该被调用"); }, false);
    ledger.syncNodeState(K, "clean_stage", "failed", { error: "旧", attempts: 2 });
    await run();
    expect(ledger.getNodeState(K, "clean_stage")).toMatchObject({ state: "done", attempts: 0 });
  });

  it("stageAfterDone 已关 → 旧 failed 复位 done", async () => {
    const { ledger, run } = setup({ stageAfterDone: false }, async () => {}, true);
    ledger.syncNodeState(K, "clean_stage", "failed", { error: "旧" });
    await run();
    expect(ledger.getNodeState(K, "clean_stage")?.state).toBe("done");
  });

  it("rmStage 抛 abort → 不记 failed、不告警", async () => {
    const { ledger, ev, run } = setup({ stageAfterDone: true }, async () => { throw new JobAbortedError(); }, true);
    await run();
    expect(ledger.getNodeState(K, "clean_stage")).toBeNull();
    expect(alerts(ev)).toHaveLength(0);
  });
});
