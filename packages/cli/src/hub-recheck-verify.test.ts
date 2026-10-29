/**
 * hub-recheck-verify 单测(T32):**护栏优先**。
 *
 * 这个工具会改生产台账(state needs_manual → done,随后可能删源),所以最要紧的不是
 * 「能不能翻」,而是**绝不能把真故障翻成 done**。三条护栏各有对应用例:
 *  ①只碰「核验失败」的 needs_manual —— `rsync rc=12` 这类真故障必须跳过;
 *  ②无 bv / 无 plain 基线 → 跳过(不能算期望值);
 *  ③口径与修好的 verifyUploaded 一致:不一致要重查,重查后仍不符才认「真 mismatch」。
 */
import { describe, it, expect } from "vitest";
import { recheckNeedsManual, type RecheckDeps } from "./hub-recheck-verify.js";

/** 假台账:只需 get() 与 doneParts()(工具只读这两个)。 */
function fakeLedger(jobs: Record<string, { state: string; bv?: string; error?: string }>, parts: Record<string, Record<string, number[]>> = {}) {
  return {
    get: (k: string) => (jobs[k] ? { state: jobs[k].state, bv: jobs[k].bv, error: jobs[k].error } : undefined),
    doneParts: (k: string, g: string) => new Set(parts[k]?.[g] ?? []),
  } as unknown as RecheckDeps["ledger"];
}

const VERIFY_ERR = "产物核验失败:期望 3 个分 P、实际 1 个(bv=BV1),已保留全部源";

describe("recheckNeedsManual(护栏)", () => {
  it("B站实查与台账一致 → flip-to-done(这正是线上那 13 个的成因)", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger(
        { k: { state: "needs_manual", bv: "BV1", error: VERIFY_ERR } },
        { k: { plain: [0, 1, 2] } },
      ),
      countParts: async () => 3,
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("flip-to-done");
    expect(r.expected).toBe(3);
    expect(r.actual).toBe(3);
  });

  it("护栏①:真故障(`rsync rc=12`)→ skip,绝不翻", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "needs_manual", bv: "BV1", error: "rsync rc=12" } }, { k: { plain: [0] } }),
      countParts: async () => 99, // 就算 B站 数够,也不该翻
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("skip");
    expect(r.why).toContain("非核验失败");
  });

  it("护栏①:非 needs_manual 状态 → skip", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "done", bv: "BV1", error: VERIFY_ERR } }, { k: { plain: [0] } }),
      countParts: async () => 3,
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("skip");
  });

  it("护栏②:无 bv → skip(未建稿,无从核验)", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "needs_manual", error: VERIFY_ERR } }, { k: { plain: [0, 1] } }),
      countParts: async () => 2,
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("skip");
    expect(r.why).toContain("无 bv");
  });

  it("护栏②:无 plain 基线 → skip(期望值算不出来)", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "needs_manual", bv: "BV1", error: VERIFY_ERR } }, { k: { append_danmu: [0] } }),
      countParts: async () => 2,
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("skip");
  });

  it("护栏③:第一次查不一致、重查后一致 → flip-to-done(与 verifyUploaded 同口径)", async () => {
    let n = 0;
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "needs_manual", bv: "BV1", error: VERIFY_ERR } }, { k: { plain: [0, 1, 2] } }),
      countParts: async () => { n++; return n < 2 ? 1 : 3; },
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("flip-to-done");
    expect(n).toBe(2);
  });

  it("护栏③:重查到底仍不符 → still-mismatch(是真问题,保持 needs_manual)", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "needs_manual", bv: "BV1", error: VERIFY_ERR } }, { k: { plain: [0, 1, 2] } }),
      countParts: async () => 1,
      sleep: async () => {},
      maxTries: 2,
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("still-mismatch");
    expect(r.actual).toBe(1);
  });

  it("查不到实际分P数(null)→ unknown(不翻,留人工)", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger({ k: { state: "needs_manual", bv: "BV1", error: VERIFY_ERR } }, { k: { plain: [0, 1] } }),
      countParts: async () => null,
      sleep: async () => {},
      maxTries: 1,
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.verdict).toBe("unknown");
  });

  it("danmu/livechat 组计入期望(与 pipeline 的 on 口径一致)", async () => {
    const deps: RecheckDeps = {
      ledger: fakeLedger(
        { k: { state: "needs_manual", bv: "BV1", error: VERIFY_ERR } },
        { k: { plain: [0], append_danmu: [0], append_livechat: [0, 1] } },
      ),
      countParts: async () => 4,
      sleep: async () => {},
    };
    const [r] = await recheckNeedsManual(["k"], deps);
    expect(r.expected).toBe(4);
    expect(r.verdict).toBe("flip-to-done");
  });
});
