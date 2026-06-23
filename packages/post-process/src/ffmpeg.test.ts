// ts/test/post/ffmpeg.test.ts
import { describe, it, expect } from "vitest";
import { parseProgressBlock } from "./ffmpeg.js";

describe("ffmpeg progress 解析", () => {
  it("out_time_ms 微秒→毫秒，算 pct", () => {
    const p = parseProgressBlock(
      { out_time_ms: "5000000", total_size: "1048576", speed: "2.5x", bitrate: "1200.0kbits/s" },
      10_000,  // total_ms
    );
    expect(p.outTimeMs).toBe(5000);      // 5_000_000 微秒 / 1000
    expect(p.pct).toBe(50);
    expect(p.speed).toBe(2.5);
    expect(p.bitrateKbps).toBe(1200);
    expect(p.outSize).toBe(1048576);
  });
  it("pct 上限 99，0 输入安全", () => {
    expect(parseProgressBlock({ out_time_ms: "0" }, 10_000).pct).toBe(0);
    expect(parseProgressBlock({ out_time_ms: "999999999" }, 1000).pct).toBe(99);
  });
});
