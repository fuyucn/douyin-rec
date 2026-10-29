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
  verifyBlocksOnMismatch,
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

  it("合并路径 期望 3 实际 2 → mismatch(观察期:判定仍是 mismatch,但**不再**因此保留源)", () => {
    // 判定逻辑(verifyParts)与阻塞策略(verifyAllowsCleanup)刻意分开:观察期只放宽后者。
    const r = verifyParts(3, 2);
    expect(r.kind).toBe("mismatch");
    expect(verifyAllowsCleanup(r)).toBe(verifyBlocksOnMismatch() ? false : true);
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
    // 注入 no-op 休眠 + 缩短间隔:核验现在会**重查**(B站 pages 最终一致),
    // 用真实 3s 退避会让本例等 ~45s。生产默认即 5 次 × 3s 起步。
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => 2,
      { sleep: async () => {}, retryDelayMs: 0, maxVerifyTries: 2 });
    expect(r.kind).toBe("mismatch");
    // 观察期:仍判 mismatch(留痕),但允许删源。传 blocking=true 即恢复「保留源」。
    expect(verifyAllowsCleanup(r)).toBe(!verifyBlocksOnMismatch());
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

/**
 * T32 回归:**B站 pages 列表最终一致**(append 返回 ≠ view 立刻可见)。
 *
 * 线上实测(2026-10-10):`douyin:347071634383:2026-10-11` 最后一个 append 完成于
 * 00:51:34.712,核验判定在 00:51:35.217 —— **间隔 0.5 秒**,此刻查 `view?bvid=` 只看到 P1,
 * 于是判「期望 3 / 实际 1」→ 永久 needs_manual + 保留全部源。而 B站上其实**有 3 个分 P**
 * (`BV1pqpL6kEeH` 实查 3 个)。同理 `douyin:63171491268:2026-10-11` 间隔 0.6 秒、实际 2 个。
 *
 * 所以「不匹配」必须先**重查确认是稳定事实**,而不是刚 append 完那一刻的快照。
 */
describe("verifyUploaded:pages 列表最终一致(重试后才判 mismatch)", () => {
  it("第一次查少一个分P(append 刚返回)、重查后一致 → 必须 ok,绝不转人工", async () => {
    const l = fakeLedger({ plain: [0, 1, 2], append_danmu: [0, 1, 2], append_livechat: [0, 1, 2] });
    let calls = 0;
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => {
      calls++;
      // 前两次模拟 B站 还没同步完(只看到 1 个),第三次才真的齐 —— 实测 ~1~2 秒内同步。
      return calls < 3 ? 1 : 9;
    }, { sleep: async () => {}, retryDelayMs: 0 });
    expect(calls).toBe(3);
    expect(r.kind).toBe("ok");
    expect(verifyAllowsCleanup(r)).toBe(true);
  });

  it("**稳定不一致**(重试到耗尽都少一个)→ 才判 mismatch(观察期:不阻塞,但仍留痕)", async () => {
    const l = fakeLedger({ plain: [0, 1, 2] });
    let calls = 0;
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => { calls++; return 1; },
      { sleep: async () => {}, retryDelayMs: 0, maxVerifyTries: 3 });
    expect(calls).toBe(3);
    expect(r).toEqual({ kind: "mismatch", expected: 3, actual: 1 });
    // 「重试到耗尽才判」是判定层;「是否保留源」是策略层(观察期=false → 照常删源)。
    expect(verifyAllowsCleanup(r)).toBe(!verifyBlocksOnMismatch());
  });

  it("实际数**超过**期望(如 B站多出历史分P)也要重查稳定后才判 —— 同样不立刻转人工", async () => {
    const l = fakeLedger({ plain: [0, 1] });
    let calls = 0;
    const r = await verifyUploaded(l, "k", "BV1", ALL_ON, async () => { calls++; return calls < 2 ? 3 : 2; },
      { sleep: async () => {}, retryDelayMs: 0 });
    expect(r.kind).toBe("ok");
  });
});

/**
 * T32 观察期:**核验不再阻塞**(只记录)。
 *
 * 依据(实测):全 61 个 job 里判过 mismatch 的只有 2 个,而这 2 个经实查 B站分P **都齐全**
 * —— 核验从未抓到真失败,只在 append 成功后 ~0.5 秒读到 B站未同步的旧值。
 * 代价却是实的:永久 needs_manual(reconciler 不重跑 → 不自愈)+ 源永不删。
 */
describe("观察期:核验只记录,不阻塞删源/不转人工", () => {
  it("verifyAllowsCleanup(mismatch) 在观察期为 true(照常删源)", () => {
    expect(verifyParts(3, 1).kind).toBe("mismatch");
    expect(verifyAllowsCleanup({ kind: "mismatch", expected: 3, actual: 1 })).toBe(true);
  });

  it("策略谓词当前为 false(= 不阻塞)", () => {
    expect(verifyBlocksOnMismatch()).toBe(false);
  });

  it("ok / skipped 仍允许删源(行为不变)", () => {
    expect(verifyAllowsCleanup({ kind: "ok", expected: 3, actual: 3 })).toBe(true);
    expect(verifyAllowsCleanup({ kind: "skipped", reason: "no-baseline" })).toBe(true);
  });

  it("unknown 仍**不允许**删源(取不到实际数 = 不能确认交付完整,这条不放宽)", () => {
    // 观察期只放宽 mismatch;unknown 是「查不到」而非「不符」,源仍保留。
    expect(verifyAllowsCleanup({ kind: "unknown", reason: "x" })).toBe(false);
  });
});
