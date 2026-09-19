import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bilibiliPlatform,
  extractRoomSlug,
  resolveBilibiliShortUrl,
  roomToUrl,
} from "./index.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bilibili URL helpers", () => {
  it("识别 live.bilibili.com 和 b23.tv 分享链接", () => {
    expect(bilibiliPlatform.matchUrl("https://live.bilibili.com/31372993")).toBe(true);
    expect(bilibiliPlatform.matchUrl("https://b23.tv/b2nQfPy")).toBe(true);
    expect(bilibiliPlatform.matchUrl("https://example.com/room/1")).toBe(false);
  });

  it("房间号与直播 URL 互转", () => {
    expect(extractRoomSlug("https://live.bilibili.com/31372993?x=1")).toBe("31372993");
    expect(roomToUrl("31372993")).toBe("https://live.bilibili.com/31372993");
  });

  it("b23.tv 302 重定向解析为 room id", async () => {
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: {
        location: "https://live.bilibili.com/31372993?broadcast_type=0&share_source=COPY",
      },
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveBilibiliShortUrl("https://b23.tv/b2nQfPy")).toBe("31372993");
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
