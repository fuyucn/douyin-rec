import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { parseInitialState, findPlayItem, pickRep } from "./index.js";
import { extractRoomSlug, roomToUrl } from "../index.js";

describe("parseInitialState / findPlayItem", () => {
  const stateSnippet =
    `window.__INITIAL_STATE__={"liveroom":{"playList":[` +
    `{"liveStream":{"hlsPlayUrl":"https://hls/1.m3u8","playUrls":{"h264":{"adaptationSet":{"representation":[` +
    `{"bitrate":2000,"qualityType":"HIGH","url":"https://x/lo.flv","height":"720"},` +
    `{"bitrate":8000,"qualityType":"BLUE_RAY","url":"https://x/hi.flv"}]}}}}` +
    `,"isLiving":true,"author":{"name":"名字"}}]},` +
    `"authToken":undefined,"s":"含括号 ) 的串};"};`;

  it("抠出并解析 JS 对象字面量(裸 undefined / 字符串内括号)", () => {
    const s = parseInitialState(stateSnippet);
    const item = findPlayItem(s)!;
    expect(item.isLiving).toBe(true);
    expect(item.author?.name).toBe("名字");
    expect(item.liveStream?.playUrls?.h264?.adaptationSet?.representation).toHaveLength(2);
    expect((s as { authToken?: unknown }).authToken).toBeNull();
  });

  it("无 __INITIAL_STATE__ 时抛错", () => {
    expect(() => parseInitialState("<html></html>")).toThrow();
  });

  it("playList 为空数组(离线/风控)→ null", () => {
    expect(findPlayItem({ liveroom: { playList: [] } })).toBeNull();
  });
});

describe("pickRep 档位映射", () => {
  const reps = [
    { bitrate: 8000, url: "bd.flv" },
    { bitrate: 2000, url: "uhd.flv" },
    { bitrate: 950, url: "hd.flv" },
    { bitrate: 500, url: "sd.flv" },
    { bitrate: 0, url: "hidden.flv", hidden: true },
  ];
  it("OD 取最高;档位按阈值落到最高不超阈值的档位;超小档落脚最低可播", () => {
    expect(pickRep(reps, "OD")?.url).toBe("bd.flv");
    expect(pickRep(reps, "UHD")?.url).toBe("uhd.flv");
    expect(pickRep(reps, "HD")?.url).toBe("hd.flv");
    expect(pickRep(reps, "SD")?.url).toBe("sd.flv");
    expect(pickRep(reps, "LD")?.url).toBe("sd.flv"); // 没有 ≤600 的 → 取最低可播
  });
  it("跳过 hidden / 无 url;全不可播 → undefined", () => {
    expect(pickRep([{ bitrate: 100, hidden: true }], "OD")).toBeUndefined();
  });
});

describe("extractRoomSlug / roomToUrl", () => {
  it("URL ↔ 用户 id 互转", () => {
    expect(extractRoomSlug("https://live.kuaishou.com/u/YaoYao096096")).toBe("YaoYao096096");
    expect(extractRoomSlug("https://live.kuaishou.com/u/3xd5m8xkm9m73yk?x=1")).toBe("3xd5m8xkm9m73yk");
    expect(extractRoomSlug("YaoYao096096")).toBe("YaoYao096096");
    expect(roomToUrl("YaoYao096096")).toBe("https://live.kuaishou.com/u/YaoYao096096");
  });

  it("覆盖 /profile/ 与 /fw/live/ 路径(同 biliup)", () => {
    expect(extractRoomSlug("https://live.kuaishou.com/profile/abc123")).toBe("abc123");
    expect(extractRoomSlug("https://live.kuaishou.com/fw/live/xyz789")).toBe("xyz789");
  });

  it("覆盖企业号域名 chenzhongtech", () => {
    expect(extractRoomSlug("https://livev.m.chenzhongtech.com/u/abc123")).toBe("abc123");
  });
});

describe("livedetail API 路径", () => {
  // warmup 的 3~4s 随机延迟在测试里是纯等待,置 0 跳过(fetch 本身已被 stub)。
  beforeAll(() => { (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__ = 0; });
  afterAll(() => { delete (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__; });
  afterEach(() => vi.unstubAllGlobals());

  /** 装一个假 fetch:首页预热 → livedetail → (不该发生的)页面 HTML。 */
  const stubFetch = (handler: (url: string) => unknown): string[] => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (input: string) => {
      const url = String(input);
      seen.push(url);
      const body = handler(url);
      return {
        ok: true,
        status: 200,
        json: async () => body,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      } as unknown as Response;
    });
    return seen;
  };

  it("API 在播 → 返回流地址,且不请求页面(省一次 59KB HTML)", async () => {
    const { getStream } = await import("./index.js");
    const seen = stubFetch((url) => {
      if (url.includes("livedetail")) {
        return {
          data: {
            result: 1,
            liveStream: {
              caption: "今晚直播标题",
              playUrls: {
                h264: {
                  adaptationSet: {
                    representation: [
                      { bitrate: 3000, url: "https://cdn/od.flv" },
                      { bitrate: 900, url: "https://cdn/hd.flv" },
                    ],
                  },
                },
              },
            },
            author: { living: true, name: "主播A" },
          },
        };
      }
      return ""; // 首页预热
    });

    const s = await getStream("abc", "HD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/hd.flv");   // 按档位选,不是无脑取最高
    expect(s.owner).toBe("主播A");
    expect(s.title).toBe("今晚直播标题");         // biliup 有、我们原本没有
    expect(seen.some((u) => u.includes("livedetail"))).toBe(true);
    expect(seen.some((u) => u.includes("/u/abc"))).toBe(false); // 没走页面刮取
  });

  it("API 明确未开播(result=2)→ living=false,不回退页面(权威结论)", async () => {
    const { getStream } = await import("./index.js");
    const seen = stubFetch(() => ({ data: { result: 2, author: { living: false, name: "A" } } }));
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(false);
    expect(seen.some((u) => u.includes("/u/abc"))).toBe(false);
  });

  it("API 网络失败 → 回退页面刮取(已验证的老路径继续兜底)", async () => {
    const { getStream } = await import("./index.js");
    const html =
      `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":true,` +
      `"author":{"name":"页面上"},"liveStream":{"playUrls":{"h264":{"adaptationSet":` +
      `{"representation":[{"bitrate":5000,"url":"https://cdn/page.flv"}]}}}}}]}};`;
    const seen = stubFetch((url) => {
      if (url.includes("livedetail")) throw new Error("network down");
      if (url.includes("/u/abc")) return html;
      return ""; // 首页预热
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/page.flv");
    expect(s.owner).toBe("页面上");
    expect(seen.some((u) => u.includes("/u/abc"))).toBe(true);
  });

  it("getLiving 也走 API(判活不拉整页 HTML)", async () => {
    const { getLiving } = await import("./index.js");
    const seen = stubFetch(() => ({ data: { result: 1, author: { living: true, name: "A" },
      liveStream: { playUrls: { h264: { adaptationSet: { representation: [{ bitrate: 1, url: "u" }] } } } } } }));
    await expect(getLiving("abc")).resolves.toBe(true);
    expect(seen.some((u) => u.includes("/u/abc"))).toBe(false);
  });

  it("未开播:playUrls 为空对象 + url 是 undefined 占位 → 判未开播(以流为准,不依赖 result 码)", async () => {
    const { getStream } = await import("./index.js");
    // 实测离线样本:result=2,playUrls={h264:{},hevc:{}},url=".../live/undefined"。
    stubFetch(() => ({
      data: {
        result: 2,
        liveStream: { playUrls: { h264: {}, hevc: {} }, url: "https://m.gifshow.com/fw/live/undefined" },
        author: { living: false, name: "A" },
      },
    }));
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(false);
    expect(s.url).toBeUndefined();
  });

  it("author.living 缺失但有可播流 → 仍判在播(以流为准)", async () => {
    const { getStream } = await import("./index.js");
    stubFetch(() => ({
      data: {
        result: 1,
        liveStream: { playUrls: { h264: { adaptationSet: { representation: [{ bitrate: 9, url: "https://cdn/x.flv" }] } } } },
        author: { name: "A" }, // 缺 living 字段
      },
    }));
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/x.flv");
  });
});
