// ts/test/post/rolling.test.ts
import { describe, it, expect } from "vitest";
import { RollingAss, rgb2bgr, sec2ass } from "./rolling.js";

describe("rolling ASS", () => {
  it("rgb2bgr: #RRGGBB → &HBBGGRR", () => {
    expect(rgb2bgr("ffffff")).toBe("&HFFFFFF");
    expect(rgb2bgr("#123456")).toBe("&H563412");
  });
  it("sec2ass: 秒 → H:MM:SS.cc", () => {
    expect(sec2ass(0)).toBe("0:00:00.00");
    expect(sec2ass(65.25)).toBe("0:01:05.25");
  });
  it("render 含 ASS 头 + R2L 样式 + Dialogue \\move", () => {
    const w = new RollingAss({ width: 1920, height: 1080 });
    expect(w.add({ timeSec: 1.0, text: "hi", color: "ffffff" })).toBe(true);
    const out = w.render();
    expect(out).toContain("[Script Info]");
    expect(out).toContain("PlayResX: 1920");
    expect(out).toContain("Style: R2L,");
    expect(out).toMatch(/Dialogue: 0,0:00:01\.00,0:00:17\.00,R2L,,0,0,0,,\{\\q2\\move\(/);
    expect(out).toContain("hi");
  });
  it("空文本/负时间被丢弃，返回 false", () => {
    const w = new RollingAss({ width: 1920, height: 1080 });
    expect(w.add({ timeSec: -1, text: "x", color: "ffffff" })).toBe(false);
    expect(w.add({ timeSec: 1, text: "", color: "ffffff" })).toBe(false);
  });
});
