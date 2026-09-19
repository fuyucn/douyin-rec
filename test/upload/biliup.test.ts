// ts/test/upload/biliup.test.ts
import { describe, it, expect } from "vitest";
import { biliupCookieHeader, buildUploadArgs, parseBV, uploadPlain } from "../../packages/app/src/upload/biliup.js";

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
  it("buildUploadArgs：显式线路加 --line", () => {
    const a = buildUploadArgs({
      video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false, line: "alia",
    });
    expect(a.join(" ")).toContain("--line alia");
  });
  it("uploadPlain：分块连接错误时自动换线，成功后返回 BV", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      if (argv.includes("alia")) {
        throw new Error("biliup 失败 (rc=1): connection error uploader.rs:557 start=52428800 end=62914560");
      }
      return "投稿成功 BV1Ab4y1C7xY";
    };
    const bv = await uploadPlain({
      plain: { video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false },
      run,
      lines: ["alia", "txa"],
    });
    expect(bv).toBe("BV1Ab4y1C7xY");
    expect(calls[0]).toContain("alia");
    expect(calls[1]).toContain("txa");
  });
  it("uploadPlain：鉴权/参数错误不换线，避免重复上传", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      throw new Error("biliup 失败 (rc=1): 登录已失效");
    };
    await expect(uploadPlain({
      plain: { video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false },
      run,
      lines: ["alia", "txa"],
    })).rejects.toThrow("登录已失效");
    expect(calls).toHaveLength(1);
  });
  it("parseBV：从 biliup 输出抓 BV 号", () => {
    expect(parseBV("...投稿成功 BV1Ab4y1C7xY ...")).toBe("BV1Ab4y1C7xY");
    expect(parseBV("无 BV 输出")).toBeNull();
  });
  it("biliupCookieHeader：解析 cookie_info.cookies", () => {
    expect(biliupCookieHeader({
      cookie_info: {
        cookies: [
          { name: "SESSDATA", value: "sess" },
          { name: "bili_jct", value: "csrf" },
        ],
      },
    })).toBe("SESSDATA=sess; bili_jct=csrf");
  });
});
