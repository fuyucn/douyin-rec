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

  it("clean_verify=pending(旧版遗留软状态)→ 不再补跑(issue #92:核验改旁路,据它补跑会反复重入且无法收敛)", () => {
    const l = new SyncLedger(":memory:");
    l.upsertPending("douyin:test:2026-10-11");
    l.markDone("douyin:test:2026-10-11", "BV1");
    l.syncNodeState("douyin:test:2026-10-11", "clean_verify", "pending");
    expect(due(l, true)).toBeNull();
  });
});

describe("上传确认后回读数与期望不符也不保源(issue #92,取代 T33 ② 的保源口径)", () => {
  function deps(actual: number | null) {
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
      scheduleSideCheck: () => {}, // 旁路校验不在本组用例范围(见 finalize-verify.test.ts)
    } as unknown as PipelineDeps;
  }

  const finalizeWith = async (actual: number | null, parts: number) => {
    const { finalizeAfterUpload } = await import("./pipeline.js");
    const d = deps(actual);
    d.ledger.upsertPending("k");
    for (let i = 0; i < parts; i++) d.ledger.markPartDone("k", "plain", i);
    let cleaned = 0;
    await finalizeAfterUpload({
      streamKey: "k", bv: "BV1", deps: d, log: () => {},
      cleanupSources: async () => { cleaned++; return { ok: true, failed: [] }; },
      on: { plain: true, danmu: false, livechat: false }, notify: () => {},
    });
    return { cleaned, state: d.ledger.get("k")?.state };
  };

  it("actual < expected(回读少,期望 3 实际 1)→ 照常清理一次,不转人工(返回码 0 即成功)", async () => {
    const r = await finalizeWith(1, 3);
    expect(r.cleaned).toBe(1);
    expect(r.state).not.toBe("needs_manual");
  });

  it("actual === expected → 正常清理", async () => {
    expect((await finalizeWith(3, 3)).cleaned).toBe(1);
  });

  it("actual > expected(多出分 P)→ 正常清理", async () => {
    expect((await finalizeWith(5, 1)).cleaned).toBe(1);
  });
});

