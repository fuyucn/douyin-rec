import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone } from "./harness/invariants.js";

// #60:常见配置 = 只开「完成后删源 + 完成后清 stage」,不开「合并后删 stage 源段」。
const COMMON = { sourceAfterDone: true, stageAfterDone: true, stageSourceAfterMerge: false } as const;
const VIDEO = /\.(ts|flv|mp4)$/i;

let s: Scenario;
afterEach(() => s?.dispose());

const record = (sc: Scenario): void => {
  sc.record({ sessions: [
    { startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 },
    { startMs: pastStartMs(0, 10, 30) + 10_000, segments: 3, segSec: 600 },
  ] });
};
const stageVideos = (sc: Scenario): string[] => sc.stageResidue().filter((f) => VIDEO.test(f) || /(^|\/)\.(work|upload)\//.test(f));

describe("e2e: 完成后清 stage 一并清视频类内容(#60)", () => {
  it("合并:整稿核验通过 → stage 内拉回的源段副本与成品全清,节点源只剩 xml/session", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } } });
    record(s);
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: 3 });
    expect(stageVideos(s)).toEqual([]);
  });

  it("分段:整稿核验通过 → stage 内源段副本 + .work 中间产物全清", async () => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...COMMON } } });
    record(s);
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: 18 });
    expect(stageVideos(s)).toEqual([]);
  });

  it("未开 stageAfterDone → stage 视频一概不动(回归)", async () => {
    s = await Scenario.create({ cfg: { cleanup: { sourceAfterDone: true, stageAfterDone: false, stageSourceAfterMerge: false } } });
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    expect(stageVideos(s).some((f) => f.endsWith(".mp4"))).toBe(true);
  });

  it("stage 模式(无稿件号、needs_manual)→ 即便开了 stageAfterDone 也不动 stage", async () => {
    s = await Scenario.create({ cfg: { uploadMode: "stage", cleanup: { ...COMMON } } });
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    expect(stageVideos(s).some((f) => f.endsWith(".mp4"))).toBe(true);
  });

  // ── issue #92:上传是否成功只看 biliup 返回码;回读分 P 数不再是清理的闸门(只做延迟的旁路校验)──
  it("回读取不到分P数 → 照常清:stage 源段副本与节点源都删,弹幕/session 保留", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } } });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(stageVideos(s)).toEqual([]);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(0);
    expect(s.recordingFiles().some((f) => /\.(xml|session\.json)$/.test(f))).toBe(true);
  });

  it("B站回读分P数少于提交数 → 照常清:stage 源段副本与节点源都删(不再保源)", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, deps: { countParts: async () => 1 } });
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(stageVideos(s)).toEqual([]);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(0);
  });

  it("未注入分P查询 → 同样照常清", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, deps: { countParts: undefined } });
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(stageVideos(s)).toEqual([]);
  });

  // ── 收尾补跑 ──
  const keep = (sc: Scenario): string[] => sc.stageResidue().filter((f) => /\.(xml|ass)$|\.session\.json$/.test(f));

  it("回读取不到分P数:首轮已清完,再对账一轮不产生变化、不再有 clean_verify=pending 让补跑反复重入", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, cleanupBackfillThrottleMs: 0 });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    const before = s.stageResidue();
    const calls = s.fake.calls.length;
    await s.reconcile();
    expect(s.stageResidue()).toEqual(before);
    expect(s.fake.calls, "补跑不得重复上传").toHaveLength(calls);
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(s.ledger.getNodeState(s.onlyKey(), "clean_verify")?.state).toBe("done");
  });

  it("清理后 .xml/.session.json/job.log 保留(不删最后一份弹幕)", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, cleanupBackfillThrottleMs: 0 });
    record(s);
    await s.reconcile();
    expect(stageVideos(s)).toEqual([]);
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(existsSync(join(s.stageSubOf(s.onlyKey()), "job.log"))).toBe(true);
    // xmlKeepRule:stage 清空时保留节点源 xml,绝不两处同时删光。
    expect(s.recordingFiles().some((f) => f.endsWith(".xml"))).toBe(true);
  });

  // ── 续跑 / 分段主路径 / 分段续跑:回读无结论(取不到 / 未注入)也照常清 stage 源段 ──
  const tsCount = (sc: Scenario): number => stageVideos(sc).filter((f) => f.endsWith(".ts")).length;
  const NO_READBACK = [
    { name: "回读取不到", mk: (sc: Scenario): void => { sc.fake.countAvailable = false; }, deps: {} },
    { name: "未注入分P查询", mk: (): void => {}, deps: { countParts: undefined } },
  ] as const;

  describe.each(NO_READBACK)("$name", ({ mk, deps }) => {
    it("合并续跑(烧录中断、稿件号已落库、成品仍在)→ 续跑完成后 stage 源段副本清空,节点源删除", async () => {
      let boom = true;
      s = await Scenario.create({
        cfg: { cleanup: { ...COMMON } }, deps,
        shellFault: (cmd) => boom && /\bburn\b/.test(cmd) && /--style\s+livechat/.test(cmd),
      });
      mk(s);
      record(s);
      await s.reconcile();
      const key = s.onlyKey();
      expect(s.jobState(key)).toBe("failed");           // 中途中断
      expect(s.ledger.get(key)?.bv).toBeTruthy();       // 稿件号已落库
      expect(tsCount(s)).toBe(6);
      boom = false;
      await s.reconcile();                              // 续跑(resumeAppends)
      expect(s.jobState(key)).toBe("done");
      expect(tsCount(s)).toBe(0);
      expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(0);
    });

    it("分段主路径 → stage 源段副本清空,节点源删除", async () => {
      s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...COMMON } }, deps });
      mk(s);
      record(s);
      await s.reconcile();
      expect(s.jobState(s.onlyKey())).toBe("done");
      expect(tsCount(s)).toBe(0);
      expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(0);
    });

    it("分段续跑(上传已完成、markDone 前中断,稿件号已落库)→ 续跑不重复上传,完成后 stage 源段副本清空", async () => {
      s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...COMMON, sourceAfterDone: false } }, deps }); // 节点源保留,下一轮才能重新发现该场续跑
      mk(s);
      record(s);
      await s.reconcile();
      const key = s.onlyKey();
      expect(s.ledger.get(key)?.bv).toBeTruthy();
      // 模拟「进程重启中断」:job 退回 failed(稿件号与 stage 产物保留),下一轮对账走 resumeSegmentAppends。
      // merge 节点标 failed(而非全部 done)= 不走「所有节点已完成 → 仅收尾」的幂等捷径。
      s.ledger.setState(key, "failed", { error: "进程重启中断" }, { force: true });
      s.ledger.syncNodeState(key, "merge", "failed", { error: "进程重启中断" });
      const calls = s.fake.calls.length;
      await s.reconcile();
      expect(s.jobState(key)).toBe("done");
      expect(s.fake.calls, "续跑不得重复上传").toHaveLength(calls);
      expect(tsCount(s)).toBe(0);
    });
  });
});
