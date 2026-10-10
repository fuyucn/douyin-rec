/**
 * verify.ts 单测(T11):期望分 P 推导 + 判定 + 组名兼容。
 * 重点覆盖评审点名的两类错误:① 用上界估 ② 组名只认一种拼写。
 */
import { describe, it, expect } from "vitest";
import {
  expectedPartCount,
  partCountOf,
  submittedPlanFromLedger,
  verifyParts,
  verifyUploaded,
  verifyAllowsCleanup,
  isRetryableVerify,
  PART_GROUP_ALIASES,
  PART_GROUP_CANONICAL,
  type PartsReader,
} from "./verify.js";

/** 假台账:parts = {groupName: [段号...]}。 */
function fakeLedger(parts: Record<string, number[]>): PartsReader {
  return {
    doneParts: (_k: string, g: string) => new Set(parts[g] ?? []),
  };
}

const ALL_ON = { plain: true, danmu: true, livechat: true };

describe("expectedPartCount(基线=实际上提交的 checkpoint 数,不用上界估)", () => {
  it("分段路径:plain 3 段 + danmu 3 + livechat 3 → 期望 9", () => {
    const l = fakeLedger({ plain: [0, 1, 2], append_danmu: [0, 1, 2], append_livechat: [0, 1, 2] });
    expect(expectedPartCount(submittedPlanFromLedger(l, "k", ALL_ON))).toBe(9);
  });

  it("合并路径基线(P1 + 追两个 P):期望 3 —— 合并路径此前不写 sync_parts 会恒为 0", () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0], append_livechat: [0] });
    expect(expectedPartCount(submittedPlanFromLedger(l, "k", ALL_ON))).toBe(3);
  });

  it("只开 plain(两个烧录步都关):期望 = plain 段数,不含已记的 danmu/livechat 行", () => {
    const l = fakeLedger({ plain: [0, 1, 2, 3], append_danmu: [0], append_livechat: [0] });
    expect(expectedPartCount(submittedPlanFromLedger(l, "k", { plain: true, danmu: false, livechat: false }))).toBe(4);
  });

  it("台账零 checkpoint(本次上线前的合并路径老 job)→ 0,交由 verifyParts 判为无基线", () => {
    expect(expectedPartCount(submittedPlanFromLedger(fakeLedger({}), "k", ALL_ON))).toBe(0);
  });

  it("批量提交口径:append 一次提交多个分 P 记多个段号 → 期望按**提交的分 P 数**,不按 append 次数", () => {
    // uploadBatchSize=5 时一次 append 传 5 个段 → 期望 +5(若按批次数算会得 1)。
    const l = fakeLedger({ plain: [0, 1, 2, 3, 4, 5] });
    expect(expectedPartCount(submittedPlanFromLedger(l, "k", { plain: true, danmu: false, livechat: false }))).toBe(6);
  });
});

describe("组名兼容(历史包袱:append_danmu / danmu 都得读到)", () => {
  it("分段路径的现有拼写(append_danmu/append_livechat)能算出正确 expected", () => {
    const l = fakeLedger({ plain: [0, 1], append_danmu: [0, 1, 2], append_livechat: [0] });
    expect(partCountOf(l, "k", "danmu")).toBe(3);
    expect(partCountOf(l, "k", "livechat")).toBe(1);
    expect(expectedPartCount(submittedPlanFromLedger(l, "k", ALL_ON))).toBe(6);
  });

  it("历史短名拼写(danmu/livechat)同样算得出(兼容旧行)", () => {
    const l = fakeLedger({ plain: [0], danmu: [0, 1], livechat: [0, 1, 2, 3] });
    expect(partCountOf(l, "k", "danmu")).toBe(2);
    expect(partCountOf(l, "k", "livechat")).toBe(4);
    expect(expectedPartCount(submittedPlanFromLedger(l, "k", ALL_ON))).toBe(7);
  });

  it("两种拼写混记同一段号 → 按段号去重,不重复计数", () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0, 1], danmu: [1, 2] });
    expect(partCountOf(l, "k", "danmu")).toBe(3); // 段号并集 {0,1,2}
  });

  it("规范组名 = 步骤名,且**派生**自别名表首项(读写两侧不可能漂移)", () => {
    expect(PART_GROUP_CANONICAL).toEqual({ plain: "plain", danmu: "append_danmu", livechat: "append_livechat" });
    for (const g of ["plain", "danmu", "livechat"] as const) {
      expect(PART_GROUP_ALIASES[g][0]).toBe(PART_GROUP_CANONICAL[g]);
    }
  });
});

describe("verifyParts(判定)", () => {
  it("期望 9 实际 9 → ok", () => {
    expect(verifyParts(9, 9)).toEqual({ kind: "ok", expected: 9, actual: 9 });
  });

  it("合并路径 期望 3 实际 2 → mismatch(转人工 + 保留源)", () => {
    const r = verifyParts(3, 2);
    expect(r.kind).toBe("mismatch");
    expect(verifyAllowsCleanup(r)).toBe(false);
  });

  it("实际多于期望(重复提交/分 P 被人工加过)也是 mismatch", () => {
    expect(verifyParts(3, 4).kind).toBe("mismatch");
  });

  it("actual=null → unknown(软状态:不转人工,可重试)", () => {
    const r = verifyParts(3, null);
    expect(r.kind).toBe("unknown");
    expect(isRetryableVerify(r)).toBe(true);
    expect(verifyAllowsCleanup(r)).toBe(false); // 不删源
  });

  it("expected=0(无基线)→ skipped 而不是 mismatch(否则老 job 全部永不删源)", () => {
    const r = verifyParts(0, 5);
    expect(r.kind).toBe("skipped");
    expect(verifyAllowsCleanup(r)).toBe(true);
  });
});

describe("verifyUploaded(端到端 + 接缝)", () => {
  it("未注入 countParts → 核验关闭(行为与现状一致)", async () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0] });
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON);
    expect(r).toEqual({ kind: "skipped", reason: "no-countParts" });
  });

  it("注入 countParts 且一致 → ok → 允许删源", async () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0], append_livechat: [0] });
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => 3);
    expect(r.kind).toBe("ok");
    expect(verifyAllowsCleanup(r)).toBe(true);
  });

  it("期望 3 实际 2 → mismatch → 不删源", async () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0], append_livechat: [0] });
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => 2);
    expect(r.kind).toBe("mismatch");
    expect(verifyAllowsCleanup(r)).toBe(false);
  });

  it("countParts 返回 null → unknown:不删源、不转人工;下轮正常后转 ok", async () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0], append_livechat: [0] });
    const unknown = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => null);
    expect(unknown.kind).toBe("unknown");
    expect(isRetryableVerify(unknown)).toBe(true);
    const ok = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => 3);
    expect(ok.kind).toBe("ok");
  });

  it("countParts 抛错(接口 500/网络)同样按软状态处理,不转人工", async () => {
    const l = fakeLedger({ plain: [0], append_danmu: [0], append_livechat: [0] });
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => { throw new Error("network down"); });
    expect(r.kind).toBe("unknown");
    expect(r.kind === "unknown" && r.reason).toContain("network down");
  });

  it("**老 job(只有 append checkpoint、无 plain/P1)→ 无基线跳过**,不拿 2 去比实际 3 误判 mismatch", async () => {
    // 回归:本次上线前的合并路径完全不写 sync_parts;若某个在途 job 只被补写过 append 组,
    // Σ(其余组)=2 而 B站实际有 3 个分 P → 假 mismatch → 全场转人工 + 永不删源。
    // plain=0 是「本次上传没有基线」的可靠信号(两条路径都在建稿成功时记 plain/0)。
    const l = fakeLedger({ append_danmu: [0], append_livechat: [0] });
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => 3);
    expect(r).toEqual({ kind: "skipped", reason: "no-baseline" });
    expect(verifyAllowsCleanup(r)).toBe(true);
  });

  it("无基线时**不调** countParts(省一次外部调用;老 job 直接按现状清理)", async () => {
    let called = 0;
    const r = await verifyUploaded(fakeLedger({}), "k", "BV1", ALL_ON, async () => { called++; return 9; });
    expect(r.kind).toBe("skipped");
    expect(called).toBe(0);
  });
});
