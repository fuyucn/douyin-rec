import { describe, expect, it } from "vitest";
import { zeroDiskRoom } from "../../packages/cli/src/zero-disk-room.js";

describe("zeroDiskRoom", () => {
  it("normalizes a full Douyin live URL to the room id used by getStream", () => {
    const platform = {
      roomToUrl: (room: string) => (/^https?:\/\//.test(room) ? room : `https://live.douyin.com/${room}`),
      extractRoomSlug: (url: string) => url.match(/^https?:\/\/live\.douyin\.com\/([^/?#]+)/)?.[1] ?? url,
    };
    expect(zeroDiskRoom(platform as never, "https://live.douyin.com/123456789012")).toBe("123456789012");
    expect(zeroDiskRoom(platform as never, "123456789012")).toBe("123456789012");
  });

  it("keeps platform-specific URL formats intact after normalization", () => {
    const platform = {
      roomToUrl: (room: string) => (/^https?:\/\//.test(room) ? room : `https://live.kuaishou.com/u/${room}`),
      extractRoomSlug: (url: string) => url.match(/^https?:\/\/live\.kuaishou\.com\/u\/([^/?#]+)/)?.[1] ?? url,
    };
    expect(zeroDiskRoom(platform as never, "https://live.kuaishou.com/u/YaoYao096096?x=1")).toBe("YaoYao096096");
  });
});
