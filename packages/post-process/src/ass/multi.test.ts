// ts/test/post/multi.test.ts
import { describe, it, expect } from "vitest";
import { combineWithOffsets, type SegmentWithDuration } from "./multi.js";
import { sec2ass } from "./rolling.js";

// 段0：起点 video_start_time=1000_000ms。弹幕 p[0]=2s；礼物绝对 ts=1003000ms → rel 3s。
const SEG0 = `<?xml version="1.0"?>
<i><metadata><video_start_time>1000000</video_start_time></metadata>
<d p="2,1" user="A0">seg0-danmu</d>
<gift ts="1003000" user="G0" giftname="Castle" giftcount="1" price="5.0"/>
<gift ts="1002000" user="Glow" giftname="Rose" giftcount="2" price="0.5"/>
<member ts="1004000" user="M0"/></i>`;

// 段1：起点 video_start_time=2000_000ms。弹幕 p[0]=4s；礼物绝对 ts=2006000ms → rel 6s。
const SEG1 = `<?xml version="1.0"?>
<i><metadata><video_start_time>2000000</video_start_time></metadata>
<d p="4,1" user="A1">seg1-danmu</d>
<gift ts="2006000" user="G1" giftname="Castle" giftcount="3" price="5.0"/>
<member ts="2005000" user="M1"/></i>`;

const SEG0_DUR = 120; // 段0视频时长 120s → 段1 偏移 = 120

/** 从 ASS 里抓某段文本对应的首个 Dialogue 起始时间（秒）。 */
function startSecOf(ass: string, needle: string): number {
  const line = ass.split("\n").find((l) => l.startsWith("Dialogue:") && l.includes(needle));
  if (!line) throw new Error(`no Dialogue for ${needle}`);
  // Dialogue: layer,start,end,...
  const parts = line.split(",");
  const t = parts[1]; // H:MM:SS.cc
  const [h, m, s] = t.split(":");
  return Number(h) * 3600 + Number(m) * 60 + parseFloat(s);
}

describe("combineWithOffsets — 多段累计偏移", () => {
  const segments: SegmentWithDuration[] = [
    { xml: SEG0, durationSec: SEG0_DUR },
    { xml: SEG1, durationSec: 999 }, // 末段时长不影响偏移（无后续段）
  ];

  it("danmu：段1弹幕被段0时长偏移（offset 应用，不堆在开头）", () => {
    const { ass, count } = combineWithOffsets(segments, "danmu", { giftValueFilter: 0.9 });
    // 段0弹幕 2s，段1弹幕 4 + 120 = 124s
    expect(startSecOf(ass, "seg0-danmu")).toBeCloseTo(2, 1);
    expect(startSecOf(ass, "seg1-danmu")).toBeCloseTo(124, 1);
    // 段0 gift rel 3s；段1 gift rel 6 + 120 = 126s
    expect(startSecOf(ass, "1个Castle")).toBeCloseTo(3, 1);
    expect(startSecOf(ass, "3个Castle")).toBeCloseTo(126, 1);
    // danmu count = 2 条弹幕（礼物不计入 danmaku 计数）
    expect(count).toBe(2);
    // 礼物价值过滤：Rose price 0.5 <= 0.9 丢弃
    expect(ass).not.toContain("Rose");
    // member 不入滚动轨
    expect(ass).not.toContain("进入直播间");
  });

  it("livechat：排除 member，段1项被偏移", () => {
    const { ass, count } = combineWithOffsets(segments, "livechat", { giftValueFilter: 0.9 });
    expect(ass).toContain("Style: LiveChat,");
    // member 排除（对齐 VPS/Python，避免进场刷屏）
    expect(ass).not.toContain("进入直播间");
    // 段1 弹幕被偏移到 ~124s（不在开头），证明 livechat 路径也应用累计偏移
    expect(startSecOf(ass, "seg1-danmu")).toBeGreaterThanOrEqual(123.5);
    expect(ass).not.toContain("Rose");      // gift 过滤
    expect(count).toBeGreaterThan(0);
  });

  it("durationSec=0 容错：偏移退化为 0，段1仍按相对时间堆在开头", () => {
    const segs: SegmentWithDuration[] = [
      { xml: SEG0, durationSec: 0 },
      { xml: SEG1, durationSec: 0 },
    ];
    const { ass } = combineWithOffsets(segs, "danmu", { giftValueFilter: 0.9 });
    // 偏移 0 时段1弹幕仍是 4s（相对）
    expect(startSecOf(ass, "seg1-danmu")).toBeCloseTo(4, 1);
  });

  it("单段也走通（退化为单 xml）", () => {
    const { count } = combineWithOffsets([{ xml: SEG0, durationSec: 60 }], "danmu");
    expect(count).toBe(1);
  });
});

describe("sec2ass 反解一致性（自洽）", () => {
  it("124s → 0:02:04.00", () => {
    expect(sec2ass(124)).toBe("0:02:04.00");
  });
});
