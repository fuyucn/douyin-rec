import { describe, it, expect } from "vitest";
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
});
