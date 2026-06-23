// ts/test/upload/biliup.test.ts
import { describe, it, expect } from "vitest";
import { buildUploadArgs, parseBV } from "../../packages/app/src/upload/biliup.js";

describe("biliup 包装", () => {
  it("buildUploadArgs：公开稿件参数映射", () => {
    const a = buildUploadArgs({
      video: "/o/x.mp4", cookies: "/c/cookies.json",
      title: "标题", tag: "a,b,c", tid: 21, public: true, desc: "简介",
    });
    const s = a.join(" ");
    expect(s).toContain("-u /c/cookies.json upload /o/x.mp4");
    expect(s).toContain("--title 标题");
    expect(s).toContain("--tid 21");
    expect(s).toContain("--tag a,b,c");
    expect(s).toContain("--copyright 1");
    expect(s).toContain("--desc 简介");
    expect(s).not.toContain("--is-only-self");   // 公开 → 不加
    // 硬性:永远关昵称水印(投稿后不可改),公开/私有都必须带。
    expect(s).toContain('--extra-fields {"watermark":{"state":0}}');
  });
  it("buildUploadArgs：水印硬性关闭(私有稿件也带)", () => {
    const a = buildUploadArgs({ video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false });
    expect(a.join(" ")).toContain('--extra-fields {"watermark":{"state":0}}');
  });
  it("buildUploadArgs：仅自己可见加 --is-only-self 1；无 desc 不加", () => {
    const a = buildUploadArgs({ video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false });
    expect(a.join(" ")).toContain("--is-only-self 1");
    expect(a.join(" ")).not.toContain("--desc");
  });
  it("parseBV：从 biliup 输出抓 BV 号", () => {
    expect(parseBV("...投稿成功 BV1Ab4y1C7xY ...")).toBe("BV1Ab4y1C7xY");
    expect(parseBV("无 BV 输出")).toBeNull();
  });
});
