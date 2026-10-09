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

describe("取流:页面优先、API 兜底(2026-10-08 修正)", () => {
  // warmup 的 3~4s 随机延迟在测试里是纯等待,置 0 跳过(fetch 本身已被 stub)。
  beforeAll(() => { (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__ = 0; });
  afterAll(() => { delete (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__; });
  afterEach(() => vi.unstubAllGlobals());

  /** 装一个假 fetch:按 URL 分派;返回 {ok,status,json,text} 形状。 */
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

  /** 造一段「在播」页面 HTML(带完整 h264 representation)。 */
  const liveHtml = (url = "https://cdn/page.flv", bitrate = 2000) =>
    `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":true,"author":{"name":"页面上"},` +
    `"liveStream":{"hlsPlayUrl":"https://cdn/page.m3u8","playUrls":{"h264":{"adaptationSet":` +
    `{"representation":[{"bitrate":${bitrate},"url":"${url}"}]}}}}}]}};`;

  it("页面在播 → 返回流地址(不再先打已下线的 livedetail)", async () => {
    const { getStream } = await import("./index.js");
    const seen = stubFetch((url) => {
      if (url.includes("/u/abc")) return liveHtml("https://cdn/od.flv");
      return ""; // 首页预热
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/od.flv");
    expect(s.owner).toBe("页面上");
    expect(seen.some((u) => u.includes("livedetail"))).toBe(false); // 不白打已下线的 API
  });

  it("页面在播时按档位选流(HD 落 ≤1000 的档)", async () => {
    const { getStream } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc"))
        return `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":true,"author":{"name":"A"},` +
          `"liveStream":{"playUrls":{"h264":{"adaptationSet":{"representation":[` +
          `{"bitrate":3000,"url":"https://cdn/od.flv"},{"bitrate":900,"url":"https://cdn/hd.flv"}]}}}}}]}};`;
      return "";
    });
    const s = await getStream("abc", "HD");
    expect(s.url).toBe("https://cdn/hd.flv");
  });

  it("★回归(旧 bug):livedetail 返回下线的桩(result:2/无流)→ 不再据此判「未开播」,页面在播照样录", async () => {
    const { getStream } = await import("./index.js");
    // 模拟真实:页面请求成功且在播;即使兜底 API 被调用也只会拿到桩。
    stubFetch((url) => {
      if (url.includes("livedetail"))
        return { data: { result: 2, liveStream: { playUrls: { h264: {}, hevc: {} }, url: "https://m.gifshow.com/fw/live/undefined" }, author: { living: false } } };
      if (url.includes("/u/abc")) return liveHtml("https://cdn/real.flv");
      return "";
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/real.flv");
  });

  it("页面请求本身失败(HTTP 抛错)→ 才用 API 兜底;API 有可播流则采用", async () => {
    const { getStream } = await import("./index.js");
    const seen = stubFetch((url) => {
      if (url.includes("/u/abc")) throw new Error("network down");
      if (url.includes("livedetail"))
        return { data: { result: 1, liveStream: { playUrls: { h264: { adaptationSet: { representation: [{ bitrate: 2000, url: "https://cdn/api.flv" }] } } } }, author: { living: true, name: "API" } } };
      return "";
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/api.flv");
    expect(seen.some((u) => u.includes("livedetail"))).toBe(true);
  });

  it("页面失败 + API 只有下线的桩 → **抛错**(未知),不静默返回未开播", async () => {
    const { getStream } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc")) throw new Error("network down");
      if (url.includes("livedetail")) return { data: { result: 2, liveStream: { playUrls: { h264: {}, hevc: {} }, url: "https://m.gifshow.com/fw/live/undefined" }, author: { living: false } } };
      return "";
    });
    await expect(getStream("abc", "OD")).rejects.toThrow(/network down/);
  });

  it("页面明确未开播(playList[0] 无 errorType、liveStream 空)→ living=false(权威)", async () => {
    const { getStream } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc"))
        return `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":false,"author":{"name":"A"},` +
          `"liveStream":{"playUrls":{"h264":{},"hevc":{}},"url":"https://m.gifshow.com/fw/live/undefined"}}]}};`;
      return "";
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(false);
    expect(s.url).toBeUndefined();
  });

  it("有可播流即判在播(不依赖 isLiving 字段;与 biliup/DouyinLiveRecorder 一致,防字段缺失漏录)", async () => {
    const { getStream } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc"))
        return `window.__INITIAL_STATE__={"liveroom":{"playList":[{"author":{"name":"A"},` + // 无 isLiving 字段
          `"liveStream":{"playUrls":{"h264":{"adaptationSet":{"representation":[{"bitrate":2000,"url":"https://cdn/x.flv"}]}}}}}]}};`;
      return "";
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(true);
    expect(s.url).toBe("https://cdn/x.flv");
  });

  it("页面风控(errorType.type=2「请求过快」)→ throttledReason 透出(不是「未开播」)", async () => {
    const { getStream } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc"))
        return `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":false,"author":{"name":"A"},` +
          `"liveStream":{},"errorType":{"type":2,"title":"请求过快，请稍后重试","content":"浏览其他内容"}}]}};`;
      return "";
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(false);
    expect(s.throttledReason).toContain("请求过快");
  });

  it("页面连 __INITIAL_STATE__ 都没有但含限流文案 → 当风控(带 throttledReason)", async () => {
    const { getStream } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc")) return "<html><body>请求过快，请稍后重试</body></html>";
      return "";
    });
    const s = await getStream("abc", "OD");
    expect(s.living).toBe(false);
    expect(s.throttledReason).toBeTruthy();
  });

  it("getLiving:页面在播 → true(不依赖已下线的 API)", async () => {
    const { getLiving } = await import("./index.js");
    const seen = stubFetch((url) => (url.includes("/u/abc") ? liveHtml() : ""));
    await expect(getLiving("abc")).resolves.toBe(true);
    expect(seen.some((u) => u.includes("livedetail"))).toBe(false);
  });

  it("getLiving:页面风控 → 抛错(未知),不误报「已下播」", async () => {
    const { getLiving } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc"))
        return `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":false,"author":{"name":"A"},"liveStream":{},"errorType":{"type":2,"title":"请求过快，请稍后重试"}}]}};`;
      return "";
    });
    await expect(getLiving("abc")).rejects.toThrow(/风控|请求过快/);
  });

  it("getLiving:页面失败 + API 只有桩 → 抛错(未知)", async () => {
    const { getLiving } = await import("./index.js");
    stubFetch((url) => {
      if (url.includes("/u/abc")) throw new Error("network down");
      if (url.includes("livedetail")) return { data: { result: 2, liveStream: { playUrls: { h264: {}, hevc: {} } }, author: { living: false } } };
      return "";
    });
    await expect(getLiving("abc")).rejects.toThrow(/network down/);
  });
});

describe("请求头:补全真实 Chrome 头(降低被判定为爬虫的概率)", () => {
  beforeAll(() => { (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__ = 0; });
  afterAll(() => { delete (globalThis as { __KS_WARMUP_DELAY_MS__?: number }).__KS_WARMUP_DELAY_MS__; });
  afterEach(() => vi.unstubAllGlobals());

  /** 记录每次请求的 (url, headers),用于断言头部内容。 */
  const captureFetch = (html: string): Array<{ url: string; headers: Record<string, string> }> => {
    const seen: Array<{ url: string; headers: Record<string, string> }> = [];
    vi.stubGlobal("fetch", async (input: string, init?: { headers?: Record<string, string> }) => {
      const url = String(input);
      seen.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      const body = url.includes("/u/abc") ? html : "";
      return { ok: true, status: 200, json: async () => ({}), text: async () => body } as unknown as Response;
    });
    return seen;
  };

  it("页面请求带全套浏览器头(sec-ch-ua / sec-fetch-* / Upgrade-Insecure-Requests / Accept-Language)", async () => {
    const { getStream } = await import("./index.js");
    const seen = captureFetch(
      `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":true,"author":{"name":"A"},` +
        `"liveStream":{"playUrls":{"h264":{"adaptationSet":{"representation":[{"bitrate":2000,"url":"https://cdn/x.flv"}]}}}}}]}};`,
    );
    await getStream("abc", "OD");
    const page = seen.find((s) => s.url.includes("/u/abc"))!;
    expect(page).toBeDefined();
    expect(page.headers["User-Agent"]).toMatch(/Chrome\/124/);
    expect(page.headers["Accept-Language"]).toContain("zh-CN");
    expect(page.headers["sec-ch-ua"]).toContain("Chromium");
    expect(page.headers["sec-ch-ua-platform"]).toBe('"Windows"');
    expect(page.headers["Upgrade-Insecure-Requests"]).toBe("1");
    // 页面是导航 → navigate/document 语义
    expect(page.headers["sec-fetch-mode"]).toBe("navigate");
    expect(page.headers["sec-fetch-dest"]).toBe("document");
    expect(page.headers["Referer"]).toBe("https://live.kuaishou.com/");
    // 不手写 Accept-Encoding(交给 fetch 协商)
    expect(page.headers["Accept-Encoding"]).toBeUndefined();
  });

  it("首页预热用 document/none 语义;cookie 透传到 Cookie 头", async () => {
    const { getStream } = await import("./index.js");
    const seen = captureFetch(
      `window.__INITIAL_STATE__={"liveroom":{"playList":[{"isLiving":false,"liveStream":{}}]}};`,
    );
    await getStream("abc", "OD", "did=web_abc; kwssectoken=xyz");
    const home = seen.find((s) => s.url === "https://live.kuaishou.com/")!;
    expect(home).toBeDefined();
    expect(home.headers["sec-fetch-site"]).toBe("none");
    expect(home.headers["sec-fetch-mode"]).toBe("navigate");
    expect(home.headers.Cookie).toBe("did=web_abc; kwssectoken=xyz");
  });
});
