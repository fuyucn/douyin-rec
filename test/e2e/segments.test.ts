import { afterEach, describe, expect, it } from "vitest";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone } from "./harness/invariants.js";

let s: Scenario;
afterEach(() => s?.dispose());

const fiveSegments = (sc: Scenario): void => {
  sc.record({ sessions: [
    { startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 },
    { startMs: pastStartMs(0, 10, 30) + 10_000, segments: 2, segSec: 600 },
  ] });
};
const names = (n: number, suffix = ""): string[] =>
  Array.from({ length: n }, (_, i) => `主播甲_2026-06-27_${String(i).padStart(3, "0")}${suffix}.mp4`);

describe("e2e: 分段(mergeSegments=false)", () => {
  it("不烧录:BV 分P数 = 录制分段数(5),顺序与段序一致", async () => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: FULL_CLEANUP } });
    fiveSegments(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.stateTrail(key)).toEqual(["pending", "syncing", "merging", "uploading", "done"]);
    expectHealthyDone(s, key, { parts: names(5) });
    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(1);
  });

  it("烧录弹幕+聊天框:分P数 = 段数 × 3 轨(5×3),P1 轨先于 danmu 轨先于 livechat 轨", async () => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false }, cleanup: FULL_CLEANUP } });
    fiveSegments(s);
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: [...names(5), ...names(5, "_danmu"), ...names(5, "_livechat")] });
  });

  it("重复对账/重启 → 不重复追加分P", async () => {
    s = await Scenario.create({ cfg: { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: FULL_CLEANUP } });
    fiveSegments(s);
    await s.reconcile();
    const calls = s.fake.calls.length;
    await s.restart();
    await s.reconcile();
    expect(s.fake.calls).toHaveLength(calls);
    expectHealthyDone(s, s.onlyKey(), { parts: 5 });
  });
});
