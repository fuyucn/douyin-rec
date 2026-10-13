import { afterEach, describe, expect, it } from "vitest";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone } from "./harness/invariants.js";

let s: Scenario;
afterEach(() => s?.dispose());

const twoSessions = (sc: Scenario): void => {
  sc.record({ sessions: [
    { startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 },
    { startMs: pastStartMs(0, 10, 30) + 10_000, segments: 3, segSec: 600 }, // 断流重连:10s 缺口 < 阈值
  ] });
};

describe("e2e: 正常合并", () => {
  it("两会话 × 3 段 → 合并 + 烧录 → 一稿三分P,清理后 stage 无残留、源节点只留 xml/session", async () => {
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP } });
    twoSessions(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.stateTrail(key)).toEqual(["pending", "syncing", "merging", "done"]);
    expectHealthyDone(s, key, {
      parts: ["主播甲_2026-06-27.mp4", "主播甲_2026-06-27_danmu.mp4", "主播甲_2026-06-27_livechat.mp4"],
    });
    // 节点源视频已删,只剩 xml + session.json(不可再生)。
    expect(s.recordingFiles().filter((f) => /\.(ts|flv)$/.test(f))).toEqual([]);
    expect(s.notifications.some((n) => n.kind === "uploadDone")).toBe(true);
  });

  it("不烧录 → 只有 P1 一个分P", async () => {
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP, steps: { burnDanmu: false, burnLivechat: false } } });
    twoSessions(s);
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: ["主播甲_2026-06-27.mp4"] });
  });

  it("收播后重复触发对账(含重启)→ 不再动作,不重复建稿", async () => {
    s = await Scenario.create({ cfg: { cleanup: FULL_CLEANUP } });
    twoSessions(s);
    await s.reconcile();
    const calls = s.fake.calls.length;
    await s.reconcile();
    await s.restart();
    await s.reconcile();
    expect(s.fake.calls, "done 之后不应再有上传调用").toHaveLength(calls);
    expectHealthyDone(s, s.onlyKey(), { parts: 3 });
  });

  it("stage 模式(只合成不上传)→ 不碰 B站,成品留 stage、源保留,转人工待上传", async () => {
    s = await Scenario.create({ cfg: { uploadMode: "stage", cleanup: { sourceAfterDone: false, stageAfterDone: false, stageSourceAfterMerge: false } } });
    twoSessions(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.fake.calls).toEqual([]);
    expect(s.stageResidue().some((f) => f.endsWith(".mp4"))).toBe(true);
    expect(s.recordingFiles().filter((f) => f.endsWith(".ts"))).toHaveLength(6);
    expect(s.ledgerRejections()).toEqual([]);
  });
});
