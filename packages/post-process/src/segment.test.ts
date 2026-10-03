import { describe, expect, it } from "vitest";
import { buildRemuxArgs, planSegmentGroups, renderXmlWindowToAss } from "./segment.js";

/** 最小 biliLive XML:video_start_time=0,弹幕 p[0]=相对秒。 */
function xmlWith(danmaku: Array<{ sec: number; text: string }>): string {
  const ds = danmaku
    .map((d) => `<d p="${d.sec},1,25,16777215,0,0,abc,1,0" user="u">${d.text}</d>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>\n<i>\n<metadata>\n  <video_start_time>0</video_start_time>\n</metadata>\n${ds}\n</i>\n`;
}

describe("buildRemuxArgs", () => {
  it("单段 remux:-c copy + 单视频/可选音频 + faststart,不做拼接", () => {
    const args = buildRemuxArgs("/in/a.ts", "/out/a.mp4");
    expect(args).toContain("-c");
    expect(args[args.indexOf("-c") + 1]).toBe("copy");
    expect(args).toContain("-map");
    expect(args).toContain("0:v:0");
    expect(args).toContain("0:a:0?");
    expect(args).toContain("+faststart");
    // 不含 segment/concat 等拼接标志
    expect(args.join(" ")).not.toMatch(/-f\s+segment|concat/);
  });

  it("显式钉视频时基 90000(FLV 源否则得 1/16000 → B站转码失败)", () => {
    const args = buildRemuxArgs("/in/a.flv", "/out/a.mp4");
    expect(args[args.indexOf("-video_track_timescale") + 1]).toBe("90000");
  });
});

describe("planSegmentGroups（按目标时长聚组成分 P）", () => {
  it("mesio 实测:11 个长短不一的段 + 目标 3600 → 合并成 1 组(整场 4111s)", () => {
    const durations = [438, 86, 469, 24, 521, 1494, 313, 114, 60, 85, 507];
    expect(planSegmentGroups(durations, 3600)).toEqual([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]);
  });

  it("目标 1800 → 超额(>1.2x)才切组", () => {
    const durations = [438, 86, 469, 24, 521, 1494, 313, 114, 60, 85, 507];
    const g = planSegmentGroups(durations, 1800);
    expect(g.length).toBeGreaterThan(1);
    // 每个非末组的累计时长 ≤ 1800*1.2
    for (const grp of g.slice(0, -1)) {
      const sum = grp.reduce((n, i) => n + durations[i], 0);
      expect(sum).toBeLessThanOrEqual(1800 * 1.2);
    }
    // 覆盖全部段、不重不漏
    expect(g.flat().sort((a, b) => a - b)).toEqual(durations.map((_, i) => i));
  });

  it("单个超长段独占一组(不切它)", () => {
    expect(planSegmentGroups([5000, 10], 1800)).toEqual([[0], [1]]);
  });

  it("target<=0 → 逐段各成一组(不合并)", () => {
    expect(planSegmentGroups([10, 20, 30], 0)).toEqual([[0], [1], [2]]);
  });

  it("空输入 → 空", () => {
    expect(planSegmentGroups([], 1800)).toEqual([]);
  });
});

describe("renderXmlWindowToAss（按段窗口切弹幕）", () => {
  const xml = xmlWith([
    { sec: 5, text: "seg0-a" },
    { sec: 100, text: "seg0-b" },
    { sec: 305, text: "seg1-a" }, // 落在第二段(300~600)
    { sec: 700, text: "seg2-a" }, // 落在第三段(600~900)
  ]);

  it("窗口 [0,300) 只保留该段条目,时间重定基到 0", () => {
    const r = renderXmlWindowToAss(xml, "danmu", { startSec: 0, endSec: 300 });
    expect(r.count).toBe(2);
    // 第 2 条相对时间 = 100 - 0 = 100s → ASS Dialogue 起始 0:01:40.00
    expect(r.ass).toContain("0:01:40.00");
    expect(r.ass).not.toContain("seg1-a");
  });

  it("窗口 [300,600) 时间重定基:305s → 5s", () => {
    const r = renderXmlWindowToAss(xml, "danmu", { startSec: 300, endSec: 600 });
    expect(r.count).toBe(1);
    expect(r.ass).toContain("seg1-a");
    expect(r.ass).toContain("0:00:05.00");
  });

  it("窗口内无条目 → 空 ass(调用方跳过烧录)", () => {
    const r = renderXmlWindowToAss(xml, "danmu", { startSec: 900, endSec: 1200 });
    expect(r.count).toBe(0);
    expect(r.ass).toBe("");
  });

  it("livechat 样式同窗口生效", () => {
    const r = renderXmlWindowToAss(xml, "livechat", { startSec: 0, endSec: 300 });
    expect(r.count).toBeGreaterThan(0);
    expect(r.ass).toMatch(/^Dialogue:/m);
  });
});
