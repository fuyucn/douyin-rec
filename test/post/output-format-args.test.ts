/** issue #137:后处理 ffmpeg 参数按输出容器取注册表(mkv 不得带 mov/mp4 专属参数),以及会话分组识别 mkv。 */
import { describe, it, expect } from "vitest";
import { buildRemuxArgs } from "../../packages/post-process/src/segment.js";
import { buildBurnArgs } from "../../packages/post-process/src/burn.js";
import { groupSessions } from "../../packages/post-process/src/concat.js";
import { buildSplitArgs, splitToSizeLimit } from "../../packages/post-process/src/split.js";

describe("buildRemuxArgs", () => {
  it("mp4:与改动前逐字一致(时基 90000 + faststart)", () => {
    expect(buildRemuxArgs("/in/a.ts", "/out/a.mp4")).toEqual([
      "-y", "-i", "/in/a.ts", "-map", "0:v:0", "-map", "0:a:0?", "-c", "copy",
      "-video_track_timescale", "90000", "-movflags", "+faststart", "/out/a.mp4",
    ]);
  });
  it("mkv:无 -video_track_timescale / -movflags(matroska muxer 不认,会 Unrecognized option)", () => {
    const a = buildRemuxArgs("/in/a.flv", "/out/a.mkv");
    expect(a).not.toContain("-video_track_timescale");
    expect(a).not.toContain("-movflags");
    expect(a).not.toContain("+faststart");
    expect(a.slice(-3)).toEqual(["-c", "copy", "/out/a.mkv"]);
  });
});

describe("buildBurnArgs", () => {
  const base = { inputMp4: "/s/p.mkv", assName: "p_danmu.ass", fontsDir: "/f", fps: 30, hwaccel: "none" as const };
  it("mp4 输出带 faststart(现状)", () => {
    const a = buildBurnArgs({ ...base, outMp4: "/s/p_danmu.mp4" });
    expect(a).toContain("-movflags");
    expect(a[a.length - 1]).toBe("/s/p_danmu.mp4");
  });
  it("mkv 输出不带 -movflags,其余编码参数不变", () => {
    const a = buildBurnArgs({ ...base, outMp4: "/s/p_danmu.mkv" });
    expect(a).not.toContain("-movflags");
    expect(a).toContain("libx264");
    expect(a).toContain("aac");
    expect(a[a.length - 1]).toBe("/s/p_danmu.mkv");
  });
});

describe("split 沿用输入容器", () => {
  it("mkv 超限切分:输出 _part%d.mkv,返回 .mkv 路径", async () => {
    let argv: string[] = [];
    const out = await splitToSizeLimit("/s/x.mkv", 100, {
      statSize: () => 250, probeDuration: async () => 300, run: async (a) => { argv = a; },
    });
    expect(argv[argv.length - 1]).toBe("/s/x_part%d.mkv");
    expect(out).toEqual(["/s/x_part0.mkv", "/s/x_part1.mkv", "/s/x_part2.mkv"]);
    expect(buildSplitArgs("/s/x.mkv", 100, "/s/x_part%d.mkv")).toContain("-reset_timestamps");
  });
  it("mp4 切分保持原命名", async () => {
    const out = await splitToSizeLimit("/s/x.mp4", 100, { statSize: () => 250, probeDuration: async () => 300, run: async () => {} });
    expect(out[0]).toBe("/s/x_part0.mp4");
  });
});

describe("groupSessions 识别 mkv/mp4 分段,且不吃自己的产物", () => {
  const B = "主播_2026-06-11_15-01-27";
  it("ts/flv 行为不变(回归)", () => {
    const g = groupSessions([`${B}_000.ts`, `${B}_001.ts`, `${B}.xml`]);
    expect(g[B].ts).toEqual([`${B}_000.ts`, `${B}_001.ts`]);
    expect(groupSessions([`${B}_000.flv`])[B].ts).toEqual([`${B}_000.flv`]);
  });
  it("带段号的 mkv/mp4 分段被识别并按段号排序", () => {
    const g = groupSessions([`${B}_002.mkv`, `${B}_000.mkv`, `${B}_001.mp4`]);
    expect(g[B].ts).toEqual([`${B}_000.mkv`, `${B}_001.mp4`, `${B}_002.mkv`]);
  });
  it("合并/烧录产物不当分段:_danmu/_livechat、无时间戳的 {主播}_{日期}.mkv、同会话已有 ts 的 {base}.mkv", () => {
    const g = groupSessions([
      `${B}_000.ts`,
      "主播_2026-06-11.mkv", "主播_2026-06-11_danmu.mkv", "主播_2026-06-11_livechat.mp4",
      `${B}.mkv`,
      `${B}_danmu.mkv`,
    ]);
    expect(Object.keys(g)).toEqual([B]);
    expect(g[B].ts).toEqual([`${B}_000.ts`]);
  });
  it("仅有无段号的单文件 mkv(节点原地替换后的单段会话)可被识别", () => {
    expect(groupSessions([`${B}.mkv`])[B].ts).toEqual([`${B}.mkv`]);
  });
});
