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

  // ── issue #327:上传是否成功仍只看 biliup 返回码,但删最后一份源之前先延后回读分 P 数;
  //    窗口耗尽仍少 / 读不到 → 保留全部源(stage 产物 + 节点源)并转人工 ──
  it("回读取不到分P数 → 保留:stage 产物与节点源都不删,转 needs_manual", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } } });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(stageVideos(s).filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    expect(stageVideos(s).some((f) => f.endsWith(".mp4"))).toBe(true);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

  it("B站回读分P数少于提交数(窗口耗尽仍少)→ 保留 stage 与节点源 + needs_manual(中文原因含期望/回读)", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, deps: { countParts: async () => 1 } });
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.ledger.get(s.onlyKey())?.error).toMatch(/期望 3.*回读 1/);
    expect(stageVideos(s).some((f) => f.endsWith(".mp4"))).toBe(true);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

  it("回读首读偏少、稍后读到期望(列表延迟)→ 照常清并 done", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } } });
    s.fake.countLagReads = 2;
    record(s);
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: 3 });
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

  it("回读取不到分P数:首轮转人工后再对账一轮不产生变化、不重复上传、不重复清理", async () => {
    s = await Scenario.create({ cfg: { cleanup: { ...COMMON } }, cleanupBackfillThrottleMs: 0 });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    const before = s.stageResidue();
    const calls = s.fake.calls.length;
    await s.reconcile();
    expect(s.stageResidue()).toEqual(before);
    expect(s.fake.calls, "补跑不得重复上传").toHaveLength(calls);
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
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

  // ── 续跑 / 分段主路径 / 分段续跑:未注入分 P 查询(核验关闭)照常清 stage 源段 ──
  const tsCount = (sc: Scenario): number => stageVideos(sc).filter((f) => f.endsWith(".ts")).length;
  const NO_READBACK = [
    { name: "未注入分P查询", mk: (): void => {}, deps: { countParts: undefined } },
  ] as const;

  it("分段主路径 回读取不到 → 保留 stage 与节点源 + needs_manual(#327)", async () => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...COMMON } } });
    s.fake.countAvailable = false;
    record(s);
    await s.reconcile();
    expect(s.jobState(s.onlyKey())).toBe("needs_manual");
    expect(tsCount(s)).toBe(6);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
  });

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

// ── 「biliup 返回非 0 → 不 markDone、不删源」是唯一护栏:续跑路径必须有测试钉住 ──
describe("e2e: 续跑里 append 返回非 0 → 不 markDone、不清 stage / 节点源(#92)", () => {
  const stageTs = (sc: Scenario): number => sc.stageResidue().filter((f) => f.endsWith(".ts")).length;

  it("合并续跑:append 持续失败 → job 不为 done,stage 源段副本与节点源都保留", async () => {
    let boom = true;
    s = await Scenario.create({
      cfg: { cleanup: { ...COMMON } },
      shellFault: (cmd) => boom && /\bburn\b/.test(cmd) && /--style\s+livechat/.test(cmd),
    });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("failed");
    expect(s.ledger.get(key)?.bv).toBeTruthy();
    boom = false;
    s.fake.inject({ op: "append", mode: "timeout", times: 50 });
    await s.reconcile();                               // 续跑(resumeAppends),append 全部失败
    expect(s.jobState(key)).not.toBe("done");
    expect(stageTs(s), "append 失败不得清 stage 源段").toBe(6);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts")), "append 失败不得删节点源").toHaveLength(6);
  });

  it("分段续跑:plain 分P append 持续失败 → job 不为 done(不 markDone、不清理)", async () => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: { ...COMMON, sourceAfterDone: false } } });
    record(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.ledger.get(key)?.bv).toBeTruthy();
    s.ledger.setState(key, "failed", { error: "进程重启中断" }, { force: true });
    s.ledger.syncNodeState(key, "merge", "failed", { error: "进程重启中断" });
    // 让已记录的 plain 分P检查点失效,迫使续跑重新 append 这些分P(否则幂等跳过,看不到 append 失败)
    (s.ledger as unknown as { db: { prepare(sql: string): { run(...a: unknown[]): unknown } } }).db
      .prepare("DELETE FROM sync_parts WHERE streamKey = ?").run(key);
    s.fake.inject({ op: "append", mode: "timeout", times: 200 });
    await s.reconcile();
    expect(s.jobState(key)).not.toBe("done");
  });
});

