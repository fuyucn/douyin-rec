import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FULL_CLEANUP, ROOM, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone } from "./harness/invariants.js";
import { segWorkPath } from "../../packages/orchestrator/src/session-plan.js";

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

/**
 * issue #140:产物「**存在** ≠ **完整**」—— 被强杀留下的半成品不得被当成品复用,更不得被静默投稿。
 *
 * 复刻 2026-10-15 incident:上次运行被看门狗杀在收尾阶段,残留的中间产物**大小正常**却读不出时长;
 * 旧逻辑只看 `existsSync` → 硬链接成上传物 → B站建稿返回 code 0,到转码阶段才报 `state=-16`。
 */
describe("e2e: 半成品产物(issue #140)", () => {
  const KEY = `douyin:${ROOM}:2026-06-27`;
  const probeJson = (f: string): number => {
    try { return (JSON.parse(readFileSync(f, "utf-8")) as { durationSec: number }).durationSec; } catch { return 0; }
  };

  it("残留半成品读不出时长 → 重做而不是复用;最终正常建稿", async () => {
    // 只对残留文件的**首次**探测返回 0(模拟半成品);重做后同路径就能正常读出来。
    const residue = new Set<string>();
    const remuxed: string[] = [];
    s = await Scenario.create({
      cfg: { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: FULL_CLEANUP },
      deps: {
        segmentDuration: async (f) => (residue.delete(f) ? 0 : probeJson(f)),
        remuxSegment: async (src, out) => { remuxed.push(out); writeFileSync(out, readFileSync(src, "utf-8")); },
      },
    });
    s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 1, segSec: 600 }] });
    const work = segWorkPath(s.stageSubOf(KEY), 0);
    mkdirSync(dirname(work), { recursive: true });
    writeFileSync(work, "HALF-WRITTEN"); // 大小正常、内容不可解析
    residue.add(work);

    await s.reconcile();

    expect(remuxed).toEqual([work]);              // 没有被当成成品跳过
    expect(s.stateTrail(KEY)).toContain("done");
    expectHealthyDone(s, KEY, { parts: names(1) });
  });

  it("产物读不出时长 → 提交前拒投:无 upload 调用、job 记失败", async () => {
    s = await Scenario.create({
      cfg: { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: FULL_CLEANUP },
      deps: {
        // 源段正常;分 P 产物(规范名)读不出时长 —— 模拟「已合成但产物损坏」。
        segmentDuration: async (f) => (/_\d{3}\.mp4$/.test(f) && !f.includes(".work/") ? 0 : probeJson(f)),
      },
    });
    s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });

    await s.reconcile();

    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(0);
    expect(s.jobState(KEY)).toBe("failed");
    // 拒投 + 不删源:源段必须还在(坏产物待人工,不能连源一起丢)。
    expect(existsSync(join(s.recordingsDir, "主播甲"))).toBe(true);
  });

  it("续跑补 append 前自检:产物读不出时长 → 不追加分 P、转人工(不重复投稿)", async () => {
    const broken = { on: false };
    s = await Scenario.create({
      // 续跑要靠「节点源还在」被下一轮重新发现(与 stage-clean 的续跑用例同口径)。
      cfg: { steps: { mergeSegments: false, burnDanmu: false, burnLivechat: false }, cleanup: { ...FULL_CLEANUP, sourceAfterDone: false } },
      deps: {
        segmentDuration: async (f) => (broken.on && /_\d{3}\.mp4$/.test(f) && !f.includes(".work/") ? 0 : probeJson(f)),
      },
    });
    s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("done");

    // 模拟「进程重启中断」后磁盘上是坏产物(旧版本留下的半成品)→ 下一轮走 resumeSegmentAppends。
    s.ledger.setState(key, "failed", { error: "进程重启中断" }, { force: true });
    s.ledger.syncNodeState(key, "merge", "failed", { error: "进程重启中断" });
    broken.on = true;
    const calls = s.fake.calls.length;

    await s.reconcile();

    expect(s.fake.calls, "坏产物不得再追加分 P").toHaveLength(calls);
    expect(s.jobState(key)).toBe("needs_manual");
  });

  it("烧录产物读不出时长 → 首跑也拒投(烧录轨同样不许静默投稿)", async () => {
    s = await Scenario.create({
      cfg: { steps: { mergeSegments: false, burnDanmu: true, burnLivechat: false }, cleanup: FULL_CLEANUP },
      deps: {
        // 只有烧录产物坏:plain 正常 —— 证明自检覆盖了烧录轨(不是只盯 plain)。
        segmentDuration: async (f) => (/_danmu\.mp4$/.test(f) ? 0 : probeJson(f)),
      },
    });
    s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 1, segSec: 600 }] });

    await s.reconcile();

    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(0);
    expect(s.jobState(KEY)).toBe("failed");
  });

  it("残留 _danmu 读不出时长 → 重烧而不是复用", async () => {
    const residue = new Set<string>();
    // 在「决定要不要烧」的那一刻取证:后续 stageAfterDone 会把产物清掉。
    const burnAttempts: Array<{ out: string; before: string }> = [];
    s = await Scenario.create({
      cfg: { steps: { mergeSegments: false, burnDanmu: true, burnLivechat: false }, cleanup: FULL_CLEANUP },
      deps: {
        burnSegment: async (o) => {
          burnAttempts.push({ out: o.out, before: existsSync(o.out) ? readFileSync(o.out, "utf-8") : "(missing)" });
          writeFileSync(o.out, readFileSync(o.plain, "utf-8"));
        },
        segmentDuration: async (f) => (residue.delete(f) ? 0 : probeJson(f)),
      },
    });
    s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 1, segSec: 600 }] });
    const half = join(s.stageSubOf(KEY), "主播甲_2026-06-27_000_danmu.mp4");
    mkdirSync(dirname(half), { recursive: true });
    writeFileSync(half, "HALF-BURNED");
    residue.add(half);

    await s.reconcile();

    // 重烧了(复用判定若还是 existsSync,这里会是空数组)。
    expect(burnAttempts.map((b) => b.out)).toEqual([half]);
    expect(burnAttempts[0]?.before).toBe("HALF-BURNED"); // 烧之前看到的就是那个半成品
    expect(s.jobState(KEY)).toBe("done");
  });

});
