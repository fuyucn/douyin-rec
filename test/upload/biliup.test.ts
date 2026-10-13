// ts/test/upload/biliup.test.ts
import { describe, it, expect } from "vitest";
import { biliupCookieHeader, buildUploadArgs, parseBV, uploadPlain } from "../../packages/app/src/upload/biliup.js";
import { isUploadRateLimited } from "../../packages/core/src/upload-contract.js";

// 提交接口显式 web(app 默认更易触发 21566 风控,见 biliup.ts 的 uploadSubmit 注释)。
const SUBMIT = ["--submit", "web"];

describe("biliup 包装", () => {
  it("buildUploadArgs：公开稿件参数映射", () => {
    const a = buildUploadArgs({
      video: "/o/x.mp4", cookies: "/c/cookies.json",
      title: "标题", tag: "a,b,c", tid: 21, public: true, desc: "简介",
    });
    const s = a.join(" ");
    expect(s).toContain("-u /c/cookies.json upload /o/x.mp4");
    expect(s).toContain("--submit web");   // 提交接口显式 web
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
  it("buildUploadArgs：videos 多文件 → 一次 upload 多个分 P(分段上传建稿)", () => {
    const a = buildUploadArgs({
      videos: ["/o/seg000.mp4", "/o/seg001.mp4", "/o/seg002.mp4"],
      cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false,
    });
    const s = a.join(" ");
    expect(s).toContain("-u /c/c.json upload /o/seg000.mp4 /o/seg001.mp4 /o/seg002.mp4");
    expect(s).toContain("--submit web");
    // 顺序 = 分 P 顺序,且仍带关水印/仅自己可见
    expect(s).toContain('--extra-fields {"watermark":{"state":0}}');
    expect(s).toContain("--is-only-self 1");
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
  // 回归：上游 504 文案是 "Gateway Time-out"(连字符),旧正则 `timed? out` 匹配不到 →
  // 被当成不可重试,线路不切换、整场 504 转 needs_manual。报错样例取自线上 job log。
  it("uploadPlain：上游 504 Gateway Time-out 视为可换线重试", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      if (argv.includes("alia")) {
        throw new Error(
          "biliup 失败 (rc=1): HTTP status server error (504 Gateway Time-out) for url " +
            "(https://upos-cs-upcdnalia.bilivideo.com/ugcever/x.mp4?chunks=318&chunk=45&partNumber=46&start=471859200&end=482344960)",
        );
      }
      return "投稿成功 BV1Ab4y1C7xY";
    };
    const bv = await uploadPlain({
      plain: { video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false },
      run,
      lines: ["alia", "txa"],
    });
    expect(bv).toBe("BV1Ab4y1C7xY");
    expect(calls.map((c) => c.find((a) => a === "alia" || a === "txa"))).toEqual(["alia", "txa"]);
  });
  it("uploadPlain：502/503 服务端错误也可换线重试", async () => {
    for (const code of ["502 Bad Gateway", "503 Service Temporarily Unavailable"]) {
      const calls: string[][] = [];
      const run = async (argv: string[]): Promise<string> => {
        calls.push(argv);
        if (argv.includes("alia")) {
          throw new Error(`biliup 失败 (rc=1): HTTP status server error (${code}) uploader.rs:557 start=100 end=200`);
        }
        return "投稿成功 BV1Ab4y1C7xY";
      };
      const bv = await uploadPlain({
        plain: { video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false },
        run,
        lines: ["alia", "txa"],
      });
      expect(bv).toBe("BV1Ab4y1C7xY");
      expect(calls).toHaveLength(2);
    }
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

describe("提交接口 --submit(防风控 21566)", () => {
  // 回归:曾经漏带 --submit → biliup CLI 默认走 app 接口 → 21566「投稿过于频繁」→ 整场转人工。
  it("buildUploadArgs 默认带 --submit web", () => {
    const a = buildUploadArgs({ video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false });
    expect(a).toContain("--submit");
    expect(a[a.indexOf("--submit") + 1]).toBe("web");
  });
  it("BILIUP_SUBMIT 可覆盖为 app(回退旧 CLI 默认)", () => {
    const prev = process.env.BILIUP_SUBMIT;
    process.env.BILIUP_SUBMIT = "app";
    try {
      const a = buildUploadArgs({ video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false });
      expect(a[a.indexOf("--submit") + 1]).toBe("app");
    } finally {
      if (prev === undefined) delete process.env.BILIUP_SUBMIT; else process.env.BILIUP_SUBMIT = prev;
    }
  });
  it("BILIUP_SUBMIT 非法值回落 web(不静默传非法串给 biliup)", () => {
    const prev = process.env.BILIUP_SUBMIT;
    process.env.BILIUP_SUBMIT = "bogus";
    try {
      const a = buildUploadArgs({ video: "/o/x.mp4", cookies: "/c/c.json", title: "t", tag: "x", tid: 21, public: false });
      expect(a[a.indexOf("--submit") + 1]).toBe("web");
    } finally {
      if (prev === undefined) delete process.env.BILIUP_SUBMIT; else process.env.BILIUP_SUBMIT = prev;
    }
  });
});

describe("isUploadRateLimited：识别 601 与 21566", () => {
  it("601 上传视频过快", () => {
    expect(isUploadRateLimited(new Error("biliup 失败 (rc=1): code: 601 您上传视频过快，请您稍作休息后再继续"))).toBe(true);
  });
  it("21566 投稿过于频繁(app 接口风控)", () => {
    // 真实报错形态(biliup 1.2.1):ResponseData { code: 21566, ..., message: "投稿过于频繁…" }
    const msg = 'biliup 失败 (rc=1): ResponseData { code: 21566, data: None, message: "投稿过于频繁，建议将APP升级至最新版本后再试", ttl: Some(1) }';
    expect(isUploadRateLimited(new Error(msg))).toBe(true);
  });
  it("普通错误不误判", () => {
    expect(isUploadRateLimited(new Error("登录已失效"))).toBe(false);
    expect(isUploadRateLimited(new Error("biliup 失败 (rc=1): HTTP status server error (500)"))).toBe(false);
  });
});
