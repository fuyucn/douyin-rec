import { describe, it, expect } from "vitest";
import { mergeXmlContents } from "./merge-xml.js";

const HEAD = (vst: number) =>
  `<?xml version="1.0" encoding="utf-8"?>\n<?xml-stylesheet type="text/xsl" href="#s"?>\n<i>\n  <metadata><video_start_time>${vst}</video_start_time></metadata>\n  <RecorderXmlStyle>STYLE</RecorderXmlStyle>\n`;

const sess = (vst: number, dLines: string[], extra: string[]) =>
  HEAD(vst) + [...dLines, ...extra].join("\n") + "\n</i>\n";

describe("mergeXmlContents — 多会话累计视频偏移", () => {
  it("首会话不动,后会话 <d> 相对时间 += 累计时长,gift/member ts 平移到无间隙时间轴", () => {
    const s0 = sess(1000000, [`<d p="2.000,1,25,16777215,1002000,0,9,9,0" user="a" uid="9">hi</d>`], [`<gift user="a" uid="9" giftname="心" giftcount="1" price="0.1" ts="1005000"/>`]);
    const s1 = sess(2000000, [`<d p="3.000,1,25,16777215,2003000,0,8,8,0" user="b" uid="8">yo</d>`], [`<member user="c" uid="7" ts="2004000"/>`]);
    const merged = mergeXmlContents([{ xml: s0, durationSec: 10 }, { xml: s1, durationSec: 5 }]);
    // 首会话保留(metadata base + 原样元素)
    expect(merged).toContain("<video_start_time>1000000</video_start_time>");
    expect(merged).toContain(`<d p="2.000,`);              // s0 <d> 不动
    expect(merged).toContain(`ts="1005000"`);               // s0 gift 不动
    // 后会话:<d> 3.000 + 10 = 13.000;member ts = base + (2004000-2000000) + 10000 = 1014000
    expect(merged).toContain(`<d p="13.000,`);
    expect(merged).toContain(`ts="1014000"`);
    // 结构完整
    expect(merged.trimEnd().endsWith("</i>")).toBe(true);
    expect(merged).toContain("<RecorderXmlStyle>STYLE</RecorderXmlStyle>");
  });

  it("单会话:原样(偏移 0)", () => {
    const s0 = sess(1000000, [`<d p="5.000,1,25,16777215,1005000,0,9,9,0" user="a" uid="9">x</d>`], []);
    const merged = mergeXmlContents([{ xml: s0, durationSec: 10 }]);
    expect(merged).toContain(`<d p="5.000,`);
  });
});
