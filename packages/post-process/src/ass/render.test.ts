// ts/test/post/render.test.ts
import { describe, it, expect } from "vitest";
import { renderXmlToAss, renderXmlToLivechat } from "./render.js";

const XML = `<?xml version="1.0"?>
<i>
<metadata><video_start_time>1781073759000</video_start_time></metadata>
<d p="1.5,1,25,16777215,1781073760500,0,uid1,0" user="A">hello</d>
<d p="-1,1,25" user="B">早到的</d>
<gift ts="1781073769000" user="C" giftname="Rose" giftcount="2" price="0.5"/>
<gift ts="1781073779000" user="D" giftname="Castle" giftcount="1" price="5.0"/>
</i>`;

it("renderXmlToLivechat：含 danmaku+gift，排除 member，礼物过滤", () => {
  const XML = `<?xml version="1.0"?>
<i><metadata><video_start_time>1781073759000</video_start_time></metadata>
<d p="1.5,1" user="A">hi</d>
<gift ts="1781073769000" user="B" giftname="Rose" giftcount="2" price="0.5"/>
<gift ts="1781073779000" user="C" giftname="Castle" giftcount="1" price="5.0"/>
<member ts="1781073789000" user="D"/></i>`;
  const { ass, count } = renderXmlToLivechat(XML, { width: 1280, height: 720, giftValueFilter: 0.9 });
  expect(ass).toContain("Style: LiveChat,");
  expect(ass).toContain("A: hi");
  expect(ass).not.toContain("进入直播间");         // member 排除（对齐 VPS/Python，避免进场刷屏）
  expect(ass).toContain("1个Castle");             // 5.0 保留
  expect(ass).not.toContain("Rose");              // 0.5<=0.9 过滤
  expect(count).toBeGreaterThan(0);
});

describe("renderXmlToAss", () => {
  it("解析 d/gift，礼物价值过滤丢弃低价礼物", () => {
    const { ass, danmaku } = renderXmlToAss(XML, { width: 1280, height: 720, giftValueFilter: 0.9 });
    expect(danmaku).toBe(1);                       // 只有 A（B 时间为负被丢）
    expect(ass).toContain("A: hello");
    expect(ass).not.toContain("早到的");           // 负时间丢弃
    // emoji 🎁 会被 tagEmoji 用 {\fn} 包裹，故断言非 emoji 部分
    expect(ass).toContain("D: 1个Castle");          // 5.0 > 0.9 保留
    expect(ass).not.toContain("Rose");             // 0.5 < 0.9 过滤
  });

  it("礼物过滤不含阈值:正好等于 --gift-value 的丢弃(只留 >0.9),低价也丢", () => {
    const XML2 = `<?xml version="1.0"?>
<i><metadata><video_start_time>1781073759000</video_start_time></metadata>
<gift ts="1781073769000" user="E" giftname="为你闪耀" giftcount="1" price="0.9"/>
<gift ts="1781073779000" user="G" giftname="嘉年华" giftcount="1" price="1.0"/></i>`;
    const { ass } = renderXmlToAss(XML2, { width: 1280, height: 720, giftValueFilter: 0.9 });
    expect(ass).not.toContain("为你闪耀");   // 正好 0.9 ≤ 0.9 → 丢弃
    expect(ass).toContain("嘉年华");          // 1.0 > 0.9 → 保留
  });
});
