import { describe, it, expect } from "vitest";
import { buildFfmpegArgs, createStderrParser } from "./ffmpeg.js";

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

// stderr 行缓冲解析器:Opening 分段 + time= 进度 + pushStderr 逐行回传。
describe("ffmpeg stderr 行缓冲解析", () => {
  function makeParser() {
    const segments: string[] = [];
    const stderr: string[] = [];
    let progress = 0;
    const p = createStderrParser({
      onSegment: (s) => segments.push(s),
      markProgress: () => {
        progress += 1;
      },
      pushStderr: (l) => stderr.push(l),
    });
    return { p, segments, stderr, progressCount: () => progress };
  }

  it("Opening 路径含振号(主播名 O'Brien)→ 整段路径上报,不以振号截断", () => {
    const { p, segments, stderr } = makeParser();
    p.onChunk("Opening '/out/O'Brien_2026-06-20_01-02-03_000.ts' for writing\n");
    expect(segments).toEqual(["/out/O'Brien_2026-06-20_01-02-03_000.ts"]);
    // pushStderr 仍收到这行(诊断用)。
    expect(stderr).toEqual([`Opening '/out/O'Brien_2026-06-20_01-02-03_000.ts' for writing`]);
  });

  it("Opening 行被拆在两个 chunk → 缓冲拼接后仍识别", () => {
    const { p, segments } = makeParser();
    p.onChunk("Output #0, mpegts\nOpening '/out/anchor_na");
    expect(segments).toEqual([]); // 未终结 → 不误报
    p.onChunk("me_000.ts' for writing\n");
    expect(segments).toEqual(["/out/anchor_name_000.ts"]);
  });

  it("进度行按 \\r 分隔 → 每个新的 time= 喂一次看门狗,回退不喂", () => {
    const { p, progressCount, segments } = makeParser();
    p.onChunk("\rframe=1 time=00:00:10.00 speed=1x\rframe=2 time=00:00:20.00 speed=1x\r");
    expect(progressCount()).toBe(2);
    // 时间戳回退/重复 → 不再喙看门狗。
    p.onChunk("\rframe=3 time=00:00:15.00 speed=1x\r");
    expect(progressCount()).toBe(2);
    // 进度条行里不存在 Opening → 不误报分段。
    expect(segments).toEqual([]);
  });

  it("flush:进程结束时没等到换行符的尾行也会被处理", () => {
    const { p, segments, stderr, progressCount } = makeParser();
    p.onChunk("Output #0\nOpening '/out/x.ts' for writing");
    expect(segments).toEqual([]);
    p.flush();
    expect(segments).toEqual(["/out/x.ts"]);
    expect(stderr[stderr.length - 1]).toContain("Opening '/out/x.ts'");
    // 冲刷后不再重复处理。
    p.flush();
    expect(segments).toHaveLength(1);
    expect(progressCount()).toBe(0);
  });

  it("\\r\\n 作为一个分隔符处理;空行不回调", () => {
    const { p, stderr, segments } = makeParser();
    p.onChunk("Opening '/out/a.ts' for writing\r\n\r\n");
    expect(segments).toEqual(["/out/a.ts"]);
    expect(stderr).toEqual(["Opening '/out/a.ts' for writing"]);
  });
});
