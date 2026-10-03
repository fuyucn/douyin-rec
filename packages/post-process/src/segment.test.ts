import { describe, expect, it } from "vitest";
import { buildRemuxArgs, renderXmlWindowToAss } from "./segment.js";

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
