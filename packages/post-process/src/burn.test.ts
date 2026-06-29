// ts/test/post/burn.test.ts
import { describe, it, expect } from "vitest";
import { buildBurnArgs, videoEncodeArgs } from "./burn.js";

describe("buildBurnArgs", () => {
  it("含 hwaccel + fps 滤镜 + ass(basename) + libx264 crf18", () => {
    const a = buildBurnArgs({
      inputMp4: "/o/野原.mp4", assName: "野原_danmu.ass", outMp4: "/o/野原_danmu.mp4",
      fontsDir: "/repo/assets/fonts", fps: 22, hwaccel: "videotoolbox",
    });
    const s = a.join(" ");
    expect(s).toContain("-hwaccel videotoolbox");
    expect(s).toContain("-progress pipe:1");
    expect(s).toContain("fps=22,ass=野原_danmu.ass:fontsdir=/repo/assets/fonts,format=yuv420p");
    expect(s).toContain("-c:v libx264 -crf 18 -preset veryfast");
    expect(s).toContain("-c:a aac -b:a 192k");
  });
  it("hwaccel=none 时不含 -hwaccel；fps=0 时无 fps 滤镜", () => {
    const a = buildBurnArgs({ inputMp4: "/o/x.mp4", assName: "x.ass", outMp4: "/o/x_d.mp4",
      fontsDir: "/f", fps: 0, hwaccel: "none" });
    expect(a.join(" ")).not.toContain("-hwaccel");
    expect(a.join(" ")).toContain("-vf ass=x.ass:fontsdir=/f,format=yuv420p");
  });
});

describe("videoEncodeArgs（编码可配 / 码率上限 / 硬件编码）", () => {
  it("默认 = libx264 crf18 veryfast，无码率约束（向后兼容）", () => {
    expect(videoEncodeArgs({}).join(" ")).toBe("-c:v libx264 -crf 18 -preset veryfast");
  });
  it("软编 + videoBitrate → 加 VBV 约束 -maxrate/-bufsize（长录控大小）", () => {
    const s = videoEncodeArgs({ crf: 20, preset: "fast", videoBitrate: "8M" }).join(" ");
    expect(s).toBe("-c:v libx264 -crf 20 -preset fast -maxrate 8M -bufsize 8M");
  });
  it("硬编 videotoolbox → 忽略 crf/preset，无码率用 -q:v，有码率用 -b:v", () => {
    expect(videoEncodeArgs({ videoCodec: "h264_videotoolbox", crf: 18 }).join(" "))
      .toBe("-c:v h264_videotoolbox -q:v 60");
    expect(videoEncodeArgs({ videoCodec: "h264_videotoolbox", videoBitrate: "10M" }).join(" "))
      .toBe("-c:v h264_videotoolbox -b:v 10M");
  });
  it("buildBurnArgs 接入 EncodeOpts", () => {
    const s = buildBurnArgs({ inputMp4: "/i.mp4", assName: "a.ass", outMp4: "/o.mp4",
      fontsDir: "/f", fps: 0, hwaccel: "none", videoCodec: "libx265", crf: 24 }).join(" ");
    expect(s).toContain("-c:v libx265 -crf 24 -preset veryfast");
  });
});
