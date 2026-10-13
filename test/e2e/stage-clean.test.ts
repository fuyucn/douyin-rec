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
});
