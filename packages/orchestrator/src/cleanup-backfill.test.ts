/**
 * T33 回归:两个「成功却永不删源」的漏网之鱼。
 *
 * 实测背景(2026-10-11):6 个房间 ~28G 源录像删不掉,最终撑爆磁盘致 master 崩溃。
 * 两个成因:
 *  ① 上传成功后被核验误判 mismatch → 在 mismatch 分支**提前 return**,`cleanupSources()`
 *     根本不被调用 → 台账里连 `clean_source` 这一行都**不存在**(不是 failed,是缺失),
 *     而旧 `cleanupBackfillDue` 只认「节点存在且 failed」→ 永远轮不到它补跑。
 *  ② 观察期放宽 mismatch 后,若 B站**少了**分 P(可能真丢片 / 也可能只是没同步完),
 *     仍照删节点源 = 不可逆地销毁最后一份源。
 */
import { describe, it, expect } from "vitest";
import { Reconciler } from "./reconciler.js";
import { runPipeline } from "./pipeline.js";
import { SyncLedger } from "./ledger.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PipelineDeps, PipelineCfg } from "./pipeline.js";

/** 直接调私有方法(它承载判定逻辑;绕开 reconcileAll 的编排,单测只验判定)。 */
function due(ledger: SyncLedger, sourceAfterDone: boolean): string | null {
  const r = new Reconciler({
    platform: "douyin",
    transports: new Map(),
    ledger,
    pipelineDeps: { ledger } as unknown as PipelineDeps,
    // 节流置 0:测试要立刻可补跑(生产默认 15 分钟防刷屏)。
    cleanupBackfillThrottleMs: 0,
  });
  return (r as unknown as { cleanupBackfillDue: (k: string, s?: boolean) => string | null })
    .cleanupBackfillDue("douyin:test:2026-10-11", sourceAfterDone);
}

describe("cleanupBackfillDue:**不再**因「clean_source 缺失」补跑(2026-10-11 撤回了这条)", () => {
  // 撤回原因:补跑走的是整条 runPipeline(不是只删源)。mergeSegments=false 的房间会走
  // runSegmentPipeline,那条路径即使 bv 已存在也**先 select + pull 源回 stage** ——
  // 实测把 14G 从节点拉回 master(磁盘不降反升),且有重复 append/重复投稿风险。
  // 「为省空间反而更费空间、还可能重传」→ 撤回。删源需要独立的收口入口(留 T33 后续)。
  it("done + 有 bv + clean_source 缺失 → **仍返回 null**(不派发,避免 pull 回灌/重传)", () => {
    const l = new SyncLedger(":memory:");
    l.upsertPending("douyin:test:2026-10-11");
    l.markDone("douyin:test:2026-10-11", "BV1");
    l.syncNodeState("douyin:test:2026-10-11", "clean_verify", "failed");
    l.syncNodeState("douyin:test:2026-10-11", "upload_plain", "done");
    expect(due(l, true)).toBeNull();
  });

  it("clean_source=failed → 仍走原分支补跑(回归:这条本来就有,没被撤回影响)", () => {
    const l = new SyncLedger(":memory:");
    l.upsertPending("douyin:test:2026-10-11");
    l.markDone("douyin:test:2026-10-11", "BV1");
    l.syncNodeState("douyin:test:2026-10-11", "clean_source", "failed", { error: "磁盘满" });
    expect(due(l, true)).toContain("clean_source");
  });

  it("clean_verify=pending → 仍补跑(软状态重试,原行为不变)", () => {
    const l = new SyncLedger(":memory:");
    l.upsertPending("douyin:test:2026-10-11");
    l.markDone("douyin:test:2026-10-11", "BV1");
    l.syncNodeState("douyin:test:2026-10-11", "clean_verify", "pending");
    expect(due(l, true)).toContain("clean_verify");
  });
});

describe("观察期:核验**少**分 P 时保住节点源(T33 ②)", () => {
  function deps(actual: number | null, cleanupCalls: Array<{ skipNodeSources?: boolean }>) {
    const dir = mkdtempSync(join(tmpdir(), "t33-"));
    mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "sub", "a.ts"), "x");
    const ledger = new SyncLedger(":memory:");
    const cfg = {
      cleanMaxGapSec: 30, stageDir: dir, cookies: "/tmp/c.json", uploadMode: "upload",
      uploadMeta: { tag: "t", tid: 21, desc: "d" }, cleanup: { sourceAfterDone: true },
    } as PipelineCfg;
    return {
      ledger,
      sh: async () => {},
      uploadPlain: async () => "BV1",
      appendGroup: async () => {},
      splitForUpload: async (m: string) => [m],
      notify: () => {},
      cfg,
      countParts: async () => actual,
      sleep: async () => {},
    } as unknown as PipelineDeps & { __calls?: unknown };
  }

  it("actual < expected(疑似缺失)→ cleanupSources 收到 skipNodeSources=true", async () => {
    const calls: Array<{ skipNodeSources?: boolean }> = [];
    const { finalizeAfterUpload } = await import("./pipeline.js");
    const d = deps(1, calls);
    // 期望 3(plain 3 段),实际 1 → 疑似缺失
    d.ledger.upsertPending("k");
    d.ledger.markPartDone("k", "plain", 0);
    d.ledger.markPartDone("k", "plain", 1);
    d.ledger.markPartDone("k", "plain", 2);
    const r = await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: d, log: () => {},
      cleanupSources: async (o) => { calls.push(o ?? {}); return { ok: true, failed: [] }; },
      on: { plain: true, danmu: false, livechat: false }, notify: () => {},
    });
    expect(r.verifyBlocked).toBeUndefined();       // 观察期不阻塞
    expect(calls[0]?.skipNodeSources).toBe(true);  // 但保住节点源
  });

  it("actual === expected → 正常删源(不带 skipNodeSources)", async () => {
    const calls: Array<{ skipNodeSources?: boolean }> = [];
    const { finalizeAfterUpload } = await import("./pipeline.js");
    const d = deps(3, calls);
    d.ledger.upsertPending("k");
    d.ledger.markPartDone("k", "plain", 0);
    d.ledger.markPartDone("k", "plain", 1);
    d.ledger.markPartDone("k", "plain", 2);
    await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: d, log: () => {},
      cleanupSources: async (o) => { calls.push(o ?? {}); return { ok: true, failed: [] }; },
      on: { plain: true, danmu: false, livechat: false }, notify: () => {},
    });
    expect(calls[0]?.skipNodeSources).toBeUndefined();
  });

  it("actual > expected(多出分 P)→ 不保源(我们没丢东西,源可安全删)", async () => {
    const calls: Array<{ skipNodeSources?: boolean }> = [];
    const { finalizeAfterUpload } = await import("./pipeline.js");
    const d = deps(5, calls);
    d.ledger.upsertPending("k");
    d.ledger.markPartDone("k", "plain", 0);
    const r = await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: d, log: () => {},
      cleanupSources: async (o) => { calls.push(o ?? {}); return { ok: true, failed: [] }; },
      on: { plain: true, danmu: false, livechat: false }, notify: () => {},
    });
    expect(r.verifyBlocked).toBeUndefined();
    expect(calls[0]?.skipNodeSources).toBeUndefined();
  });
});

describe("cleanupSourcesShared:skipNodeSources 只跳节点源,不跳 stage", () => {
  it("skipNodeSources=true → 不调 transport.cleanup(节点源),但仍按配置清 stage", async () => {
    const { cleanupSourcesShared } = await import("./pipeline.js");
    let nodeCleaned = 0;
    const dir = mkdtempSync(join(tmpdir(), "t33b-"));
    writeFileSync(join(dir, "s.ts"), "x");
    const l = new SyncLedger(":memory:");
    l.upsertPending("k");
    const out = await cleanupSourcesShared({
      streamKey: "k", ledger: l,
      transports: new Map([["n1", { cleanup: async () => { nodeCleaned++; } } as never]]),
      members: [{ workerId: "n1", rec: { tsFiles: ["/remote/a.ts"] } }],
      cleanup: { sourceAfterDone: true, stageSourceAfterMerge: true },
      stagePulledSources: [join(dir, "s.ts")],
      rmStage: async () => { writeFileSync(join(dir, "s.ts"), ""); }, // 模拟删除
      log: () => {},
      skipNodeSources: true,
    });
    expect(nodeCleaned).toBe(0);   // 节点源**没**被碰
    expect(out.ok).toBe(true);
  });
});
