import { afterEach, describe, expect, it, vi } from "vitest";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone, expectLegalTrail, expectSourceSidecarsKept } from "./harness/invariants.js";
import { ResourcePool } from "../../packages/orchestrator/src/workflow.js";
import { join } from "node:path";
import { rmSync } from "node:fs";

let s: Scenario;
afterEach(() => s?.dispose());

const THREE = ["主播甲_2026-06-27.mp4", "主播甲_2026-06-27_danmu.mp4", "主播甲_2026-06-27_livechat.mp4"];
const rec = (sc: Scenario): void => {
  sc.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
};
const create = (): Promise<Scenario> => Scenario.create({ cfg: { cleanup: FULL_CLEANUP } });
const tsLeft = (sc: Scenario): number => sc.recordingFiles().filter((f) => f.endsWith(".ts")).length;

describe("e2e: 上传超时/故障后的重试与降级", () => {
  it.each([
    [true, "upload"], [true, "append"], [false, "upload"], [false, "append"],
  ] as const)("明确限流回队列并跨重启续跑(merge=%s,op=%s),只建一稿且不重复分P", async (mergeSegments, op) => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments }, cleanup: FULL_CLEANUP },
      deps: { pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0, uploadCooldownMs: 0 }) } });
    rec(s); s.fake.inject({ op, mode: "rate-limit" });
    await s.reconcile();
    const key = s.onlyKey();
    const queued = s.ledger.get(key)!;
    expect(queued).toMatchObject({ state: "failed", fails: 0,
      failureClass: op === "upload" ? "safe-retry" : "resume-append" });
    expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
    const calls = s.fake.calls.length;
    await s.reconcile();
    expect(s.fake.calls).toHaveLength(calls);
    expect(tsLeft(s)).toBe(3);
    await s.restart();
    s.ledger.setFailurePlan(key, { failureClass: queued.failureClass, nextAttemptAt: 0 });
    await s.reconciler.pollUploadRetries();
    await vi.waitFor(() => expect(s.jobState(key)).toBe("done"));
    expectHealthyDone(s, key, { parts: mergeSegments ? 3 : 9 });
    expect(s.fake.draftCount).toBe(1);
    const accepted = s.fake.calls.filter((call) => call.outcome === "ok").flatMap((call) => call.files);
    expect(new Set(accepted).size).toBe(accepted.length);
    expectLegalTrail(s, key);
  });

  it("退避期间过滤规则变化不能让旧下标跳过另一源段并误删源", async () => {
    s = await Scenario.create({ cfg: { minSegmentSec: 2,
      steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: FULL_CLEANUP },
      deps: { pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0, uploadCooldownMs: 0 }),
        segmentDuration: async (file) => file.endsWith("_000.ts") ? 10 : 30 } });
    rec(s); s.fake.inject({ op: "append", mode: "rate-limit" });
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.get(key)?.failureClass).toBe("resume-append");
    const before = s.fake.calls.length;
    s.patchConfig({ minSegmentSec: 20 });
    s.ledger.setFailurePlan(key, { failureClass: "resume-append", nextAttemptAt: 0 });
    await s.reconcile();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.ledger.get(key)?.error).toContain("plan changed");
    expect(s.fake.calls).toHaveLength(before);
    expect(s.fake.onlyArchive.parts).toHaveLength(1);
    expect(tsLeft(s)).toBe(3);
  });

  it("历史限流不豁免后来产物缺失的失败预算,耗尽后保留源转人工", async () => {
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP }, deps: {
      pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0, uploadCooldownMs: 0 }) } });
    rec(s); s.fake.inject({ op: "upload", mode: "rate-limit" });
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.get(key)?.fails).toBe(0);
    rmSync(join(s.stageSubOf(key), THREE[0]));
    for (let count = 1; count <= 3; count++) {
      s.ledger.setFailurePlan(key, { failureClass: "safe-retry", nextAttemptAt: 0 });
      await s.reconcile();
      expect(s.ledger.get(key)?.fails).toBe(count);
    }
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.fake.calls.filter((call) => call.op === "upload")).toHaveLength(1);
    expect(tsLeft(s)).toBe(3);
  });

  it.each(["upload", "append"] as const)("立即执行的 %s 限流同样不计失败并进入自动队列", async (op) => {
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP }, deps: {
      pool: new ResourcePool({ minBurnFreeMemMB: 0, uploadRateLimit: 0, uploadCooldownMs: 0 }) } });
    rec(s); s.fake.inject({ op, mode: "rate-limit" });
    const keys = await s.transports.get("local")!.listInventory();
    expect(keys.recordings.length).toBeGreaterThan(0);
    const key = "douyin:" + keys.recordings[0].roomSlug + ":2026-06-27";
    await s.reconciler.runNow({ streamKey: key, wait: true, force: true });
    const job = s.ledger.get(key)!;
    expect(job).toMatchObject({ state: "failed", fails: 0,
      failureClass: op === "upload" ? "safe-retry" : "resume-append" });
    expect(job.nextAttemptAt).toBeGreaterThan(Date.now());
  });

  it("P1 建稿网关超时 → 主控禁止内部换线重发未知建稿", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "upload", mode: "gateway-timeout" });
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(s.fake.draftCount).toBe(0);
    expect(tsLeft(s)).toBe(3);
  });

  it("append 整次包装网关超时 → 客户端缺少未提交证明,转人工且不重发", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "gateway-timeout", times: 5 }); // 5 条线路全败 = 一次包装调用失败
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.fake.calls.filter((c) => c.op === "append" && c.outcome === "rejected")).toHaveLength(1);
    const before = s.fake.calls.length;
    await s.restart(); await s.reconcile();
    expect(s.fake.calls).toHaveLength(before);
    expect(s.fake.draftCount).toBe(1);
    expect(tsLeft(s)).toBe(3);
  });

  it("append 已提交但回读延迟超过内部窗口 → 仍只发一次,不换线路", async () => {
    s = await create(); rec(s);
    s.fake.countLagReads = 50;
    s.fake.inject({ op: "append", mode: "ambiguous" });
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.fake.calls.filter((c) => c.op === "append")).toHaveLength(1);
    expect(s.fake.onlyArchive.parts).toHaveLength(2);
    const before = s.fake.calls.length;
    await s.restart(); await s.reconcile();
    expect(s.fake.calls).toHaveLength(before);
    expect(tsLeft(s)).toBe(3);
  });

  it("append 已提交但响应丢失,分P数可查 → 识别为已成功,不重复追加", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: THREE });
    expect(s.fake.calls.filter((c) => c.files[0]?.endsWith("_danmu.mp4"))).toHaveLength(1);
  });

  it("append 进程被杀 → 不能从退出码证明未提交,重启仍不重传", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "killed" });
    await s.reconcile();
    const calls = s.fake.calls.length;
    await s.restart();
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.fake.calls).toHaveLength(calls);
    expect(s.fake.draftCount).toBe(1);
    expect(tsLeft(s)).toBe(3);
  });

  it("建稿完成后、追加前进程重启 → 当前口径:上传类节点被中断视为不确定,转人工;不重复建稿、不再上传、保留源", async () => {
    // 现行为:append 中途进程死亡 → sweep 标「进程重启中断」→ 上传类节点禁止自动重试 → needs_manual
    // (保守取舍:不确定服务端是否已追加,不盲目续传)。若将来改成可按分P数续跑,改这里的期望即可。
    // staleMs=0:生产里僵尸 merging job 要等 600s 才被 sweep,这里视作重启已过去足够久。
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP }, staleMs: 0 }); rec(s);
    s.fake.inject({ op: "append", mode: "hang" }); // 第一次 append 调用中途「进程死亡」
    void s.reconcile(); // 永不返回;重启后丢弃
    for (let i = 0; i < 200 && !s.fake.calls.some((c) => c.outcome === "hung"); i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.fake.calls.some((c) => c.outcome === "hung"), "应已卡在 append").toBe(true);
    const calls = s.fake.calls.length;
    await s.restart();
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.fake.calls, "转人工后不得再有任何上传调用").toHaveLength(calls);
    expect(s.fake.draftCount, "没有第二份稿").toBe(1);
    expect(tsLeft(s), "不得删源").toBe(3);
    expectSourceSidecarsKept(s);
    expectLegalTrail(s, key);
    expect(s.ledgerRejections()).toEqual([]);
  });

  it("append 结果不确定且分P数不可查 → 不重传:失败→转人工,源与 stage 成品保留,不重复建稿", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    s.fake.countAvailable = false;
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.ledger.get(key)?.error).toContain("append-ambiguous");
    const calls = s.fake.calls.length;
    await s.restart();
    await s.reconcile();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.fake.calls, "转人工后不得再有任何上传调用").toHaveLength(calls);
    expect(s.fake.draftCount).toBe(1);
    expect(tsLeft(s), "不确定时不得删源").toBe(3);
    expectSourceSidecarsKept(s);
    expectLegalTrail(s, key);
    expect(s.ledgerRejections()).toEqual([]);
  });

  it("P1 建稿被杀但服务端已提交(BV 未知)→ 绝不重建稿:转人工", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "upload", mode: "killed", applied: true });
    await s.reconcile();
    await s.restart();
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.fake.draftCount, "没有第二份稿").toBe(1);
    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(1);
    expect(tsLeft(s)).toBe(3);
    expectLegalTrail(s, key);
    expect(s.ledgerRejections()).toEqual([]);
  });

  it("P1 所有线路都超时(服务端从未提交)→ 当前口径:转人工、不建稿、保留源", async () => {
    // 现行为:upload_plain 失败一律视为「不可自动重试」(UNSAFE_RETRY_NODES)。
    // 即使确认没建稿也不自动重来——保守取舍;若将来放宽,改这里的期望即可。
    s = await create(); rec(s);
    s.fake.inject({ op: "upload", mode: "timeout", times: 5 });
    await s.reconcile();
    await s.restart();
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.fake.draftCount).toBe(0);
    expect(tsLeft(s)).toBe(3);
    expect(s.ledgerRejections()).toEqual([]);
  });

  // #66: the part list refreshes about 0.5-1s after an append returns. If the append was applied but the
  // response was lost, appendGroup re-reads at intervals before switching line (no duplicate part).
  // The fake lag is counted in reads and the fake injects a no-op sleep; backoff timing is unit-tested
  // next to appendGroup (test/upload/biliup-append.test.ts).
  it("fake: countLagReads keeps the pre-append count for N reads", async () => {
    // appendGroup 成功后现在也会回读并消耗 lag（生产行为）；这里用不带 countParts 的裸 append 验证 fake 语义。
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP }, deps: { countParts: undefined } }); rec(s);
    await s.reconcile();
    const bv = s.fake.onlyArchive.bv;
    expect(s.fake.onlyArchive.parts).toHaveLength(3);
    s.fake.countLagReads = 2;
    await s.fake.appendGroup({ cookies: "", bv, files: ["lag-probe.mp4"] });
    expect(s.fake.onlyArchive.parts).toHaveLength(4);
    // 提交后前两次读仍是提交前的分 P 数，第三次才看到真实值。
    expect(await s.fake.countVideoParts(bv)).toBe(3);
    expect(await s.fake.countVideoParts(bv)).toBe(3);
    expect(await s.fake.countVideoParts(bv)).toBe(4);
  });

  it.each([true, false])("continues later uploads after accepted but missing parts, then retains sources (merge=%s)", async (mergeSegments) => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments }, cleanup: FULL_CLEANUP } }); rec(s);
    s.fake.inject({ op: "append", mode: "drop", match: (files) => files.some((f) => f.endsWith("_danmu.mp4")) });
    await s.reconcile();
    const key = s.onlyKey();
    const appended = s.fake.calls.filter((c) => c.op === "append");
    expect(appended.some((call) => call.files.some((file) => file.endsWith("_livechat.mp4")))).toBe(true);
    expect(s.fake.onlyArchive.parts).toHaveLength(mergeSegments ? 2 : 8);
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.ledger.get(key)?.error).toContain("分 P 数不足");
    expect(tsLeft(s)).toBe(3);
    expectSourceSidecarsKept(s);
    const calls = s.fake.calls.length;
    await s.restart();
    await s.reconcile();
    expect(s.fake.calls).toHaveLength(calls);
    expect(tsLeft(s)).toBe(3);
  });

  it.each([true, false])("uploads later parts while visibility lags and verifies before cleanup (merge=%s)", async (mergeSegments) => {
    let finalReads = 0;
    s = await Scenario.create({
      cfg: { steps: { mergeSegments }, cleanup: FULL_CLEANUP },
      deps: {
        countParts: async () => {
          finalReads++;
          expect(tsLeft(s)).toBe(3);
          expect(s.fake.calls.some((call) => call.files.some((file) => file.endsWith("_livechat.mp4")))).toBe(true);
          return finalReads < 3 ? 1 : s.fake.onlyArchive.parts.length;
        },
      },
    });
    rec(s);
    s.fake.countLagReads = 6;
    await s.reconcile();
    expect(finalReads).toBeGreaterThanOrEqual(3);
    expectHealthyDone(s, s.onlyKey(), { parts: mergeSegments ? 3 : 9 });
    const appendedFiles = s.fake.calls.filter((call) => call.op === "append").flatMap((call) => call.files);
    expect(new Set(appendedFiles).size).toBe(appendedFiles.length);
  });

  it("keeps immediate append verification without a final reader", async () => {
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP }, deps: { countParts: undefined } });
    rec(s);
    s.fake.inject({ op: "append", mode: "drop", match: (files) => files.some((file) => file.endsWith("_danmu.mp4")) });
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.fake.calls.some((call) => call.files.some((file) => file.endsWith("_livechat.mp4")))).toBe(false);
    expect(tsLeft(s)).toBe(3);
  });

  it("append applied but response lost + delayed readback → must not append twice (#66)", async () => {
    s = await create(); rec(s);
    s.fake.countLagReads = 1;
    s.fake.inject({ op: "append", mode: "ambiguous" });
    await s.reconcile();
    expect(s.fake.calls.filter((c) => c.files[0]?.endsWith("_danmu.mp4")), "danmu appended once").toHaveLength(1);
    expectHealthyDone(s, s.onlyKey(), { parts: THREE });
  });
});
