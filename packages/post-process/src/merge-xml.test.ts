import { describe, it, expect } from "vitest";
import { mergeXmlContents, renderXmlWindowToXml } from "./merge-xml.js";
import { extractItems } from "./ass/render.js";

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

describe("renderXmlWindowToXml — 窗口切分派生 xml(与烧录 extractItems 同口径)", () => {
  const VST = 1_000_000;
  const vst = (relSec: number) => VST + Math.round(relSec * 1000);
  const lines = [
    `<d p="2.000,1,25,16777215,${vst(2)},0,9,9,0" user="a" uid="9">开头</d>`,
    `<d p="5.000,1,25,16777215,${vst(5)},0,8,8,0" user="b" uid="8">窗内</d>`,
    `<d p="8.000,1,25,16777215,${vst(8)},0,7,7,0" user="c" uid="7">右边界不取</d>`,
    `<d p="4.000,1,25,16777215,${vst(4)},0,6,6,0"></d>`,
    `<gift user="d" uid="6" giftname="小花" giftcount="1" price="0.5" ts="${vst(3)}"/>`,
    `<gift user="e" uid="5" giftname="大花" giftcount="1" price="1.2" ts="${vst(6)}"/>`,
    `<gift user="f" uid="4" giftname="阈值" giftcount="1" price="0.9" ts="${vst(6.5)}"/>`,
    `<member user="g" uid="3" ts="${vst(3.5)}"/>`,
  ];
  /** 条目可比表示:时间折到毫秒(派生 xml 的 ts 是整数 ms,浮点末位差无意义)。 */
  const view = (items: ReturnType<typeof extractItems>) =>
    items.map((x) => ({ ...x, timeSec: Math.round(x.timeSec * 1000) }));

  it("无损:派生 xml 按缺省口径抽 = 源 xml 同一窗口抽(extractItems 权威)", () => {
    const xml = sess(VST, lines, []);
    const win = { startSec: 2, endSec: 8 };
    const res = renderXmlWindowToXml(xml, win);
    // 差分断言:派生 xml 再抽一次 = 源 xml 按同一窗口抽(含 member、含 <0.9 礼物 → 无损)
    expect(view(extractItems(res.xml))).toEqual(view(extractItems(xml, { window: win })));
    expect(res.count).toBe(extractItems(xml, { window: win }).length);
  });

  it("绝对时间回代一致:派生 xml 相对时间 + 窗口起点 = 源 xml 的绝对时间(与合并 offset 同源)", () => {
    const xml = sess(VST, lines, []);
    const win = { startSec: 2, endSec: 8 };
    // 独立路径:不用 extractItems 自己的 window 逻辑 —— 取源 xml **无窗口**(=绝对时间)再手动筛窗,
    // 与「派生 xml 抽 + startSec 回代」逐条对齐。这正是「派生 xml 与合并模式算出的绝对时间一致」。
    const derived = renderXmlWindowToXml(xml, win);
    const rebased = extractItems(derived.xml).map((x) => ({ ...x, timeSec: x.timeSec + win.startSec }));
    const srcInWin = extractItems(xml).filter((x) => x.timeSec >= win.startSec && x.timeSec < win.endSec);
    expect(view(rebased)).toEqual(view(srcInWin));
    expect(rebased.length).toBeGreaterThan(0); // 非平凡:确有窗内条目
  });

  it("烧录口径(排除 member + gift>0.9)从派生 xml 抽 = 从会话 xml 按窗口抽", () => {
    const xml = sess(VST, lines, []);
    const win = { startSec: 2, endSec: 8 };
    const res = renderXmlWindowToXml(xml, win);
    // 与 renderXmlWindowToAss/extractItems 的烧录口径一致:types=danmaku+gift、giftValueFilter=0.9
    const burn = { types: new Set(["danmaku", "gift"] as const), giftValueFilter: 0.9 };
    const expected = extractItems(xml, { ...burn, window: win });
    expect(extractItems(res.xml, burn)).toEqual(expected);
    // 具体条目:2s→0、5s→3、gift6s→4;窗口外/空文本/阈值礼物(0.9)/member 都不收
    expect(expected.map((x) => x.timeSec)).toEqual([0, 3, 4]);
    expect(expected.map((x) => x.kind)).toEqual(["danmaku", "danmaku", "gift"]);
    expect(expected[0].content).toBe("开头");
    expect(expected[1].content).toBe("窗内");
    expect(expected[2].giftName).toBe("大花");
  });

  it("分数秒窗口:重定基结果与烧录口径一致(毫秒级)", () => {
    const xml = sess(VST, lines, []);
    const win = { startSec: 2.04, endSec: 8.5 }; // 真实场景里 startSec 来自时长累计,通常是分数秒
    const res = renderXmlWindowToXml(xml, win);
    const expected = extractItems(xml, { window: win });
    expect(view(extractItems(res.xml))).toEqual(view(expected));
  });

  it("窗口切片后的结构合法:保留 head/video_start_time,只一个 </i>", () => {
    const xml = sess(VST, lines, []);
    const res = renderXmlWindowToXml(xml, { startSec: 0, endSec: 9 });
    expect(res.xml).toContain(`<video_start_time>${VST}</video_start_time>`);
    expect(res.xml).toContain("<RecorderXmlStyle>STYLE</RecorderXmlStyle>");
    expect(res.xml.trimEnd().endsWith("</i>")).toBe(true);
    expect((res.xml.match(/<\/i>/g) ?? []).length).toBe(1);
  });

  it("空窗口 → count=0 且结构完整(不多一个 </i>、不残留条目)", () => {
    const xml = sess(VST, lines, []);
    const res = renderXmlWindowToXml(xml, { startSec: 99, endSec: 100 });
    expect(res.count).toBe(0);
    expect(res.xml).toContain(`<video_start_time>${VST}</video_start_time>`);
    expect(res.xml.trimEnd().endsWith("</i>")).toBe(true);
    expect((res.xml.match(/<\/i>/g) ?? []).length).toBe(1);
    expect(res.xml).not.toContain("<d p=");
    expect(res.xml).not.toContain("<gift");
  });

  it("缺失 p 按 0 判定;非数字 p 丢弃", () => {
    const xml = sess(VST, [
      `<d user="x">缺p</d>`,
      `<d p="abc,1,25" user="y">乱p</d>`,
      `<d p="1.000,1,25,16777215,${vst(1)},0,9,9,0" user="z">正常</d>`,
    ], []);
    const res = renderXmlWindowToXml(xml, { startSec: 0, endSec: 2 });
    expect(res.count).toBe(2);
    expect(res.xml).toContain("缺p"); // 缺 p 按 0 保留(时间轴 0,无需显式加 p)
    expect(res.xml).toContain(`p="1.000,`);
    expect(res.xml).not.toContain("乱p");
  });

  it("member 也收(与 extractItems 缺省口径一致,无损投影)", () => {
    const xml = sess(VST, [], [`<member user="g" uid="3" ts="${vst(3.5)}"/>`]);
    const res = renderXmlWindowToXml(xml, { startSec: 0, endSec: 9 });
    expect(res.count).toBe(1);
    expect(res.xml).toContain("<member");
    expect(res.xml).toContain(`ts="${Math.round(VST + 3500)}"`);
  });
});
