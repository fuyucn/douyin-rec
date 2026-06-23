// ts/test/post/burn.test.ts
import { describe, it, expect } from "vitest";
import { buildBurnArgs } from "./burn.js";

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
