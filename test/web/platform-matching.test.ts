import { describe, expect, it } from "vitest";
import { bilibiliPlatform } from "../../packages/bilibili-live/src/index.js";
import { pickPlatform } from "../../packages/web/src/lib/labels";
import type { PlatformDTO } from "../../packages/web/src/api/client";

const dto = (id: string, urlPattern: string | null, urlPatternFlags = ""): PlatformDTO => ({
  id,
  urlPattern,
  urlPatternFlags,
  qualities: ["default"],
  engines: ["ffmpeg"],
  defaultQuality: "default",
  defaultEngine: "ffmpeg",
  hasDanmu: false,
});

const platforms = [
  dto("douyin", "(?:live|v)\\.douyin\\.com\\/"),
  dto(
    bilibiliPlatform.id,
    bilibiliPlatform.urlPattern ?? null,
    bilibiliPlatform.urlPatternFlags,
  ),
];

describe("pickPlatform URL matching", () => {
  it("uses serialized flags for uppercase Bilibili short links and preserves default fallback", () => {
    expect(pickPlatform("https://B23.TV/b2nQfPy", platforms)?.id).toBe("bilibili");
    expect(pickPlatform("https://unknown.example/room", platforms)?.id).toBe("douyin");
    expect(pickPlatform("12345", platforms)?.id).toBe("douyin");
    expect(pickPlatform("12345", [])).toBeUndefined();
  });

  it("reports overlapping client patterns rather than choosing by list order", () => {
    const overlapping = [dto("first", "shared\\.example"), dto("second", "shared\\.example")];
    expect(() => pickPlatform("https://shared.example/room", overlapping)).toThrow(
      "URL 同时匹配多个平台: first, second",
    );
  });
});
