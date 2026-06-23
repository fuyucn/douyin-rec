import { describe, it, expect } from "vitest";
import { buildFfmpegArgs } from "./ffmpeg.js";

// 引擎是纯参数拼接(无 sm-crypto / 无真 spawn)→ 可单测 argv。
describe("ffmpeg 引擎 argv", () => {
  it("分段:-c copy -map 0 + segment muxer + {nameBase}_%03d.ts 命名", () => {
    const { args, sessionFirstPath } = buildFfmpegArgs({
      url: "https://cdn/live.flv",
      dir: "/out/anchor",
      nameBase: "anchor_2026-06-20_01-02-03",
      segSec: 1800,
    });
    expect(args).toContain("-c");
    expect(args).toContain("copy");
    expect(args).toEqual(expect.arrayContaining(["-map", "0"]));
    expect(args).toEqual(expect.arrayContaining(["-f", "segment", "-segment_time", "1800"]));
    expect(args.some((a) => a.endsWith("anchor_2026-06-20_01-02-03_%03d.ts"))).toBe(true);
    expect(sessionFirstPath.endsWith("anchor_2026-06-20_01-02-03_000.ts")).toBe(true);
  });

  it("不分段:输出单文件 {nameBase}.ts(无 segment muxer)", () => {
    const { args, sessionFirstPath } = buildFfmpegArgs({
      url: "https://cdn/live.flv",
      dir: "/out/anchor",
      nameBase: "anchor_X",
      segSec: 0,
    });
    expect(args).not.toContain("segment");
    expect(args.some((a) => a.endsWith("anchor_X.ts"))).toBe(true);
    expect(sessionFirstPath.endsWith("anchor_X.ts")).toBe(true);
  });

  it("给 headers(http 流)→ 发 -referer / -user_agent;其余进 -headers", () => {
    const { args } = buildFfmpegArgs({
      url: "https://cdn/live.flv",
      headers: { Referer: "https://live.bilibili.com/", "User-Agent": "UA/1.0", "X-Extra": "v" },
      dir: "/out/a",
      nameBase: "a",
      segSec: 0,
    });
    expect(args).toEqual(expect.arrayContaining(["-referer", "https://live.bilibili.com/"]));
    expect(args).toEqual(expect.arrayContaining(["-user_agent", "UA/1.0"]));
    const hi = args.indexOf("-headers");
    expect(hi).toBeGreaterThan(-1);
    expect(args[hi + 1]).toContain("X-Extra: v");
    // http 流 → 开启 ffmpeg 重连
    expect(args).toContain("-reconnect");
  });

  it("非 http 流(本地/rtmp)→ 不发 header、不开重连", () => {
    const { args } = buildFfmpegArgs({
      url: "rtmp://x/y",
      headers: { Referer: "r" },
      dir: "/out/a",
      nameBase: "a",
      segSec: 0,
    });
    expect(args).not.toContain("-referer");
    expect(args).not.toContain("-reconnect");
  });
});
