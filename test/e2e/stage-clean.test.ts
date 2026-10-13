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

  it("核验取不到分P数(待重试)→ 源段副本保留,弹幕/session 保留,节点源也不删", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } } });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

  // ── 核验语义收紧:stage 视频类清理只在核验真正通过时执行 ──
  it("B站分P数少于提交数 → stage 源段副本保留,节点源也保留", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, deps: { countParts: async () => 1 } });
    record(s);
    await s.reconcile();
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

  it("核验被跳过(未注入分P查询)→ stage 源段副本保留(旧行为)", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, deps: { countParts: undefined } });
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

  // ── 收尾补跑 ──
  const keep = (sc: Scenario): string[] => sc.stageResidue().filter((f) => /\.(xml|ass)$|\.session\.json$/.test(f));

  it("收尾补跑:核验仍待重试 → 补跑不清 stage", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, cleanupBackfillThrottleMs: 0 });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    const before = s.stageResidue();
    await s.reconcile(); // 仍取不到分P数 → 仍是待重试
    expect(s.stageResidue()).toEqual(before);
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

  it("收尾补跑:核验通过后补清视频类,.xml/.session.json/job.log 保留", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, cleanupBackfillThrottleMs: 0 });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    const kept = keep(s);
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    s.fake.countAvailable = true;
    await s.reconcile();
    expect(stageVideos(s)).toEqual([]);
    expect(s.jobState(s.onlyKey())).toBe("done");
    expect(keep(s)).toEqual(kept);
    expect(existsSync(join(s.stageSubOf(s.onlyKey()), "job.log"))).toBe(true);
  });

  // ── 删除路径反向用例:续跑 / 分段主路径 / 分段续跑,核验未真正通过时 stage 源段必须保留 ──
  const tsCount = (sc: Scenario): number => stageVideos(sc).filter((f) => f.endsWith(".ts")).length;
  // .work 目录本身(基线行为会在 stageAfterDone 时删其中的分P plain 文件,但目录属「中间产物」,核验未过必须留)
  const hasWork = (sc: Scenario): boolean => existsSync(join(sc.stageSubOf(sc.onlyKey()), ".work"));
  // 核验未真正通过的两种形态:待重试(取不到分P数) / 被跳过(未注入分P查询,无基线)
  const UNVERIFIED = [
    { name: "核验待重试", mk: (sc: Scenario): void => { sc.fake.countAvailable = false; }, deps: {} },
    { name: "核验被跳过", mk: (): void => {}, deps: { countParts: undefined } },
  ] as const;

  describe.each(UNVERIFIED)("核验未通过($name)", ({ name, mk, deps }) => {
    it("合并续跑(烧录中断、稿件号已落库、成品仍在)→ 拉回的源段副本保留,节点源保留", async () => {
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
      expect(tsCount(s), "续跑核验未通过,不得清 stage 源段副本").toBe(6);
      if (name === "核验待重试") expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    });

    it("分段主路径 → stage 源段副本与 .work 保留,节点源保留", async () => {
      s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...COMMON } }, deps });
      mk(s);
      record(s);
      await s.reconcile();
      expect(s.jobState(s.onlyKey())).toBe("done");
      expect(tsCount(s)).toBe(6);
      expect(hasWork(s), ".work 中间产物应保留").toBe(true);
      if (name === "核验待重试") expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    });

    it("分段续跑(上传已完成、markDone 前中断,稿件号已落库、成品仍在)→ stage 源段副本与 .work 保留", async () => {
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
      expect(tsCount(s), "分段续跑核验未通过,不得清 stage 源段副本").toBe(6);
      expect(hasWork(s), ".work 中间产物应保留").toBe(true);
    });
  });
});
