import { afterEach, describe, expect, it } from "vitest";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone, expectLegalTrail, expectSourceSidecarsKept } from "./harness/invariants.js";

let s: Scenario;
afterEach(() => s?.dispose());

const THREE = ["主播甲_2026-06-27.mp4", "主播甲_2026-06-27_danmu.mp4", "主播甲_2026-06-27_livechat.mp4"];
const rec = (sc: Scenario): void => {
  sc.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
};
const create = (): Promise<Scenario> => Scenario.create({ cfg: { cleanup: FULL_CLEANUP } });
const tsLeft = (sc: Scenario): number => sc.recordingFiles().filter((f) => f.endsWith(".ts")).length;

describe("e2e: 上传超时/故障后的重试与降级", () => {
  it("P1 建稿网关超时 → 真实包装换线重试成功:只建一份稿", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "upload", mode: "gateway-timeout" });
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: THREE });
    const ups = s.fake.calls.filter((c) => c.op === "upload");
    expect(ups.map((c) => c.outcome)).toEqual(["rejected", "ok"]);
    expect(new Set(ups.map((c) => c.line)).size, "第二次应换了线路").toBe(2);
  });

  it("append 整次包装失败(所有线路网关超时、服务端未提交)→ 管线内重试成功:分P不重不漏", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "gateway-timeout", times: 5 }); // 5 条线路全败 = 一次包装调用失败
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: THREE });
    expect(s.fake.calls.filter((c) => c.op === "append" && c.outcome === "rejected")).toHaveLength(5);
  });

  it("append 已提交但响应丢失,分P数可查 → 识别为已成功,不重复追加", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: THREE });
    expect(s.fake.calls.filter((c) => c.files[0]?.endsWith("_danmu.mp4"))).toHaveLength(1);
  });

  it("append 进程被杀(未提交)→ 就地重试成功;重启后再对账不重复", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "killed" });
    await s.reconcile();
    await s.restart();
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: THREE });
  });

  it("append 结果不确定且分P数不可查 → 不重传:失败→转人工,源与 stage 成品保留,不重复建稿", async () => {
    s = await create(); rec(s);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    s.fake.countAvailable = false;
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("failed");
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
});
