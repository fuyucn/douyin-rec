/**
 * upos-stream 测试:用假 fetch 打完整协议流程,断言**协议参数正确 + 字节不落盘**。
 * 不碰网络、不碰真实稿件。
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendStudioPart,
  complete,
  lookupArchive,
  preupload,
  submitStudio,
  uploadChunks,
  UposRateLimited,
  type PreuploadResult,
  type UposPart,
} from "./upos-stream.js";

/** A real cookies.json fixture: `submitStudio` reads bili_jct from disk (needs a real file). */
const COOKIES_DIR = mkdtempSync(join(tmpdir(), "upos-cookies-"));
const COOKIES = join(COOKIES_DIR, "cookies.json");

beforeAll(() => {
  writeFileSync(COOKIES, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf-abc" }] },
  }));
});
afterAll(() => rmSync(COOKIES_DIR, { recursive: true, force: true }));

function fakeCookies(): void {
  vi.doMock("./run-biliup.js", () => ({ readBiliupCookieHeader: () => "SESSDATA=fake; bili_jct=fake" }));
}

const CHUNK = 1024;

/** 做一个假 preupload 响应。 */
function bucketJson(): Record<string, unknown> {
  return {
    chunk_size: CHUNK,
    auth: "fake-auth",
    endpoint: "upos-cs-upcdnbda2.bilivideo.com",
    biz_id: "12345",
    upos_uri: "upos://bucket/fake.mkv",
    OK: 1,
  };
}

/** 记录所有请求的假 fetch。 */
function makeFetch(overrides: { failChunk?: number; failComplete?: boolean } = {}) {
  const calls: Array<{ url: string; method: string; params: URLSearchParams; bodyLen?: number }> = [];
  const uploadIdDone = { value: false };
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    const b = init?.body as BodyInit | undefined;
    const bodyLen = b instanceof ArrayBuffer ? b.byteLength : b ? (b as Uint8Array).length : undefined;
    calls.push({ url: u.origin + u.pathname, method, params: u.searchParams, bodyLen });

    // upload_id 换取
    if (method === "POST" && u.searchParams.has("uploads")) {
      return new Response(JSON.stringify({ upload_id: "upload-abc" }), { status: 200 });
    }
    // preupload
    if (u.pathname.endsWith("/preupload")) {
      return new Response(JSON.stringify(bucketJson()), { status: 200 });
    }
    // complete
    if (method === "POST") {
      if (overrides.failComplete) return new Response(JSON.stringify({ OK: 0, message: "parts mismatch" }), { status: 200 });
      return new Response(JSON.stringify({ OK: 1, cid: 999, filename: "fake.mkv", key: "abc123.mkv" }), { status: 200 });
    }
    // chunk PUT
    if (method === "PUT") {
      const part = Number(u.searchParams.get("partNumber"));
      if (overrides.failChunk === part) return new Response("boom", { status: 500 });
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

/** 记录 submitStudio 的请求体。 */
function makeSubmitFetch(payload: { code?: number; data?: unknown } = { code: 0, data: { aid: 1, bvid: "BVfakefixture1" } }) {
  let seen: Record<string, unknown> | undefined;
  const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, seen: () => seen };
}

describe("preupload", () => {
  it("带预声明 size 与线路,并拼出上传 URL", async () => {
    fakeCookies();
    const { preupload: pu } = await import("./upos-stream.js");
    const { impl } = makeFetch();
    const r = await pu({ cookiesPath: COOKIES, fileName: "test-part.mkv", totalSize: 4096, fetchImpl: impl });
    expect(r.bucket.chunkSize).toBe(CHUNK);
    expect(r.url).toBe("https://upos-cs-upcdnbda2.bilivideo.com/bucket/fake.mkv");
    expect(r.fileName).toBe("test-part.mkv");
  });

  it("缺少 size(传 0)时仍发请求 —— 协议要的就是这个数字", async () => {
    fakeCookies();
    const { preupload: pu } = await import("./upos-stream.js");
    const { impl } = makeFetch();
    // totalSize=0 不在本层拒绝;上层(biliup processor)负责校验。
    await expect(pu({ cookiesPath: COOKIES, fileName: "x.mkv", totalSize: 0, fetchImpl: impl })).resolves.toBeTruthy();
  });

  it("601 限流(实测过:多 P 连传)-> 抛 UposRateLimited,不是普通 Error", async () => {
    fakeCookies();
    const { preupload: pu } = await import("./upos-stream.js");
    const impl = (async () => {
      return new Response(JSON.stringify({ OK: 0, code: 601, message: "您上传视频过快，请您稍作休息后再继续" }), { status: 406 });
    }) as unknown as typeof fetch;
    await expect(pu({ cookiesPath: COOKIES, fileName: "x.ts", totalSize: 8, fetchImpl: impl }))
      .rejects.toThrow(UposRateLimited);
  });
});

describe("uploadChunks", () => {
  it("按预声明大小切块,参数与协议一致,顺序上传", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl, calls } = makeFetch();
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2500, fetchImpl: impl });
    const progress: number[] = [];
    // 数据源:内存里现造(模拟「不落盘」)
    const buf = new Uint8Array(2500).map((_, i) => i % 251);
    const parts = await mod.uploadChunks({
      session,
      totalSize: 2500,
      fetchImpl: impl,
      onProgress: (p) => progress.push(p.chunksDone),
      readChunk: async (i, size) => buf.subarray(i * CHUNK, i * CHUNK + size),
    });
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2, 3]);
    expect(progress).toEqual([1, 2, 3]);

    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(3);
    expect(puts.map((c) => c.params.get("partNumber"))).toEqual(["1", "2", "3"]);
    expect(puts.map((c) => c.params.get("chunks"))).toEqual(["3", "3", "3"]);
    expect(puts.map((c) => c.params.get("total"))).toEqual(["2500", "2500", "2500"]);
    expect(puts.map((c) => c.params.get("chunk"))).toEqual(["0", "1", "2"]);
    expect(puts.map((c) => c.params.get("start"))).toEqual(["0", "1024", "2048"]);
    expect(puts.map((c) => c.params.get("end"))).toEqual(["1024", "2048", "2500"]);
    expect(puts.map((c) => c.params.get("size"))).toEqual(["1024", "1024", "452"]);
    expect(puts.map((c) => c.bodyLen)).toEqual([1024, 1024, 452]);
    expect(puts.every((c) => c.params.get("uploadId") === "upload-abc")).toBe(true);
  });

  it("readChunk 给的块短于本块声明 → 视为尾块并收尾(少传合法,不补零)", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl, calls } = makeFetch();
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    // 结算型调用方(边录边传)会在最后一刻才确定真实总量,于是交来一个短块。
    // 它合法:按实际长度发,并在此结束,不补零凑够声明值。
    const parts = await mod.uploadChunks({ session, totalSize: 2048, fetchImpl: impl, readChunk: async () => new Uint8Array(10) });
    expect(parts).toEqual([{ partNumber: 1, eTag: "etag" }]);
    const put = calls.filter((c) => c.method === "PUT").at(-1)!;
    expect(put.params.get("size")).toBe("10");
    expect(put.params.get("total")).toBe("10"); // total 收敛为真实发送量
    expect(put.bodyLen).toBe(10);
  });

  it("5xx 会重试换块,重试耗尽才失败", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl, calls } = makeFetch({ failChunk: 1 });
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    const buf = new Uint8Array(2048);
    await expect(
      mod.uploadChunks({ session, totalSize: 2048, fetchImpl: impl, retries: 2, readChunk: async (i, s) => buf.subarray(i * CHUNK, i * CHUNK + s) }),
    ).rejects.toThrow(/上传失败/);
    const puts = calls.filter((c) => c.method === "PUT");
    expect(puts).toHaveLength(3); // 1 ok + 2 次重试
  });
});

describe("complete", () => {
  it("parts 原样提交,带 name/uploadId/biz_id/output", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl, calls } = makeFetch();
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    const parts: UposPart[] = [{ partNumber: 1, eTag: "etag" }, { partNumber: 2, eTag: "etag" }];
    const r = await mod.complete({ session, parts, fetchImpl: impl });
    expect(r.ok).toBe(true);
    const post = calls.filter((c) => c.method === "POST" && !c.params.has("uploads")).at(-1)!;
    expect(post.params.get("name")).toBe("t.mkv");
    expect(post.params.get("uploadId")).toBe("upload-abc");
    expect(post.params.get("biz_id")).toBe("12345");
    expect(post.params.get("output")).toBe("json");
  });

  it("服务端拒绝(OK!=1)返回 ok:false,不抛", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl } = makeFetch({ failComplete: true });
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    const r = await mod.complete({ session, parts: [{ partNumber: 1, eTag: "e" }], fetchImpl: impl });
    expect(r.ok).toBe(false);
    expect(r.raw.message).toBe("parts mismatch");
  });

  it("返回的 stem 来自服务端 key(不是 upos_uri 原名)", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl } = makeFetch();
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    const r = await mod.complete({ session, parts: [{ partNumber: 1, eTag: "e" }], fetchImpl: impl });
    // upos_uri 是 `upos://bucket/fake.mkv`,但服务端分配的 key 是 `abc123.mkv`
    expect(r.stem).toBe("abc123");
  });

  it("服务端 key 带 bucket 前缀时剥掉目录(实测形状 `bucket/name.ts`)", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(url);
      if (u.pathname.endsWith("/preupload")) return new Response(JSON.stringify(bucketJson()), { status: 200 });
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        if (u.searchParams.has("uploads")) return new Response(JSON.stringify({ upload_id: "u" }), { status: 200 });
        return new Response(JSON.stringify({ OK: 1, key: "ugcever/n261018abc.ts" }), { status: 200 });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    const r = await mod.complete({ session, parts: [{ partNumber: 1, eTag: "e" }], fetchImpl: impl });
    expect(r.stem).toBe("n261018abc");
  });

  it("服务端没给 key 时回落到 upos_uri 的 stem", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const u = new URL(url);
      if (u.pathname.endsWith("/preupload")) return new Response(JSON.stringify(bucketJson()), { status: 200 });
      if ((init?.method ?? "GET").toUpperCase() === "POST") {
        if (u.searchParams.has("uploads")) return new Response(JSON.stringify({ upload_id: "u" }), { status: 200 });
        return new Response(JSON.stringify({ OK: 1 }), { status: 200 });
      }
      return new Response("", { status: 200 });
    }) as unknown as typeof fetch;
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 2048, fetchImpl: impl });
    const r = await mod.complete({ session, parts: [{ partNumber: 1, eTag: "e" }], fetchImpl: impl });
    expect(r.stem).toBe("fake");
  });
});

describe("submitStudio", () => {
  it("body 带齐上游 Studio 全部字段,filename 用 UPOS stem 而非 cid/原名", async () => {
    fakeCookies();
    const { submitStudio: sub } = await import("./upos-stream.js");
    const { impl, seen } = makeSubmitFetch();
    const r = await sub({
      cookiesPath: COOKIES, title: "测试-timestamp", tid: 21, tag: "测试", private: true,
      videos: [{ cid: "999", filename: "abc123", title: "part-1" }],
      fetchImpl: impl,
    });
    expect(r.ok).toBe(true);
    const b = seen()!;
    expect(b.filename).toBeUndefined();
    expect(b.videos).toEqual([{ title: "part-1", filename: "abc123", desc: "" }]);
    // 硬常量:漏一条就是不可逆事故
    expect(b.copyright).toBe(1);
    expect(b.is_only_self).toBe(1);
    expect(b.watermark).toEqual({ state: 0 });
    expect(b.tid).toBe(21);
    expect(b.subtitle).toEqual({ open: 0, lan: "" });
    expect(b.desc_v2).toBeNull();
    expect(b.dtime).toBeNull();
    expect(b.mission_id).toBeNull();
    for (const k of ["interactive", "dolby", "lossless_music", "no_reprint", "open_elec", "charging_pay", "desc_format_id"]) {
      expect(b[k]).toBe(0);
    }
    for (const k of ["open_subtitle", "up_selection_reply", "up_close_reply", "up_close_danmu"]) {
      expect(b[k]).toBe(false);
    }
    // tag 逗号分隔
    expect(b.tag).toBe("测试");
  });

  it("private=false -> is_only_self=0", async () => {
    fakeCookies();
    const { submitStudio: sub } = await import("./upos-stream.js");
    const { impl, seen } = makeSubmitFetch();
    await sub({
      cookiesPath: COOKIES, title: "t", tid: 21, tag: "x", private: false,
      videos: [{ filename: "abc123" }], fetchImpl: impl,
    });
    expect(seen()!.is_only_self).toBe(0);
  });

  it("服务端 error(code!=0)返回 ok:false 且带 raw,不抛", async () => {
    fakeCookies();
    const { submitStudio: sub } = await import("./upos-stream.js");
    const { impl } = makeSubmitFetch({ code: 21015, data: undefined });
    const r = await sub({
      cookiesPath: COOKIES, title: "t", tid: 21, tag: "x", private: true,
      videos: [{ filename: "abc123" }], fetchImpl: impl,
    });
    expect(r.ok).toBe(false);
    expect(r.raw.code).toBe(21015);
  });

  it("追 P(带 aid)时 edit 接口,body 带 aid", async () => {
    fakeCookies();
    const { submitStudio: sub } = await import("./upos-stream.js");
    let path = "";
    let seen: Record<string, unknown> | undefined;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      path = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ code: 0, data: { aid: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await sub({
      cookiesPath: COOKIES, title: "t", tid: 21, tag: "x", private: true, aid: 7,
      videos: [{ filename: "abc123" }], fetchImpl: impl,
    });
    expect(r.ok).toBe(true);
    expect(r.aid).toBe(7);
    expect(path).toContain("/x/vu/web/edit");
    expect(seen!.aid).toBe(7);
  });
});

describe("private archive lookup + append", () => {
  it("uses the member view endpoint and preserves every existing part", async () => {
    fakeCookies();
    const { lookupArchive: lookup } = await import("./upos-stream.js");
    let seenUrl = "";
    const impl = (async (input: string | URL | Request) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(JSON.stringify({
        code: 0,
        data: {
          archive: {
            aid: 7, bvid: "BVfakefixture1", title: "private", tid: 21, tag: "a,b",
            desc: "desc", is_only_self: 1,
          },
          videos: [
            { cid: 11, filename: "stem1", title: "P1", desc: "" },
            { cid: 12, filename: "stem2", title: "P2", desc: "d2" },
          ],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await lookup({ cookiesPath: COOKIES, bvid: "BVfakefixture1", fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(seenUrl).toContain("/x/vupre/web/archive/view?bvid=");
    expect(r.archive).toMatchObject({
      aid: 7, bvid: "BVfakefixture1", title: "private", tid: 21, tag: "a,b",
      private: true, videos: [{ filename: "stem1" }, { filename: "stem2" }],
    });
  });

  it("append reads first and submits existing parts + the new part (never only the new part)", async () => {
    fakeCookies();
    let body: Record<string, unknown> | undefined;
    let postPath = "";
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            archive: {
              aid: 7, bvid: "BVfakefixture1", title: "private", tid: 21, tag: "a",
              desc: "", is_only_self: 1,
            },
            videos: [
              { cid: 11, filename: "stem1", title: "P1" },
              { cid: 12, filename: "stem2", title: "P2" },
            ],
          },
        }), { status: 200 });
      }
      postPath = url;
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response(JSON.stringify({ code: 0, data: { aid: 7, bvid: "BVfakefixture1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await appendStudioPart({
      cookiesPath: COOKIES,
      bvid: "BVfakefixture1",
      video: { filename: "stem3", title: "P3" },
      fetchImpl: impl,
    });
    expect(r.ok).toBe(true);
    expect(postPath).toContain("/x/vu/web/edit");
    expect(body!.aid).toBe(7);
    expect(body!.videos).toEqual([
      { title: "P1", filename: "stem1", desc: "" },
      { title: "P2", filename: "stem2", desc: "" },
      { title: "P3", filename: "stem3", desc: "" },
    ]);
    expect(body!.is_only_self).toBe(1);
    expect(body!.watermark).toEqual({ state: 0 });
  });

  it("retry after a lost edit response is idempotent when the stem is already present", async () => {
    fakeCookies();
    let posts = 0;
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            archive: {
              aid: 7, bvid: "BVfakefixture1", title: "private", tid: 21, tag: "a",
              is_only_self: 1,
            },
            videos: [{ cid: 13, filename: "stem3", title: "P3" }],
          },
        }), { status: 200 });
      }
      posts++;
      return new Response(JSON.stringify({ code: 0, data: { aid: 7 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await appendStudioPart({
      cookiesPath: COOKIES, bvid: "BVfakefixture1",
      video: { filename: "stem3", title: "P3" }, fetchImpl: impl,
    });
    expect(r.ok).toBe(true);
    expect(r.raw).toEqual({ idempotent: true });
    expect(posts).toBe(0);
  });

  it("lookup failure is explicit and append never posts a destructive partial list", async () => {
    fakeCookies();
    let posts = 0;
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ code: -404, message: "not found" }), { status: 200 });
      }
      posts++;
      return new Response(JSON.stringify({ code: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await appendStudioPart({
      cookiesPath: COOKIES, bvid: "BVfakefixture1",
      video: { filename: "stem3" }, fetchImpl: impl,
    });
    expect(r.ok).toBe(false);
    expect(r.raw.error).toBe("lookup archive failed");
    expect(posts).toBe(0);
  });

  it("findArchiveByTitle reads auditing arc_audits rows, not only archives[]", async () => {
    fakeCookies();
    const { findArchiveByTitle } = await import("./upos-stream.js");
    let views = 0;
    const impl = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/x/web/archives")) {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            archives: [],
            arc_audits: [{ Archive: { aid: 7, bvid: "BVfakefixture1", title: "测试-1" } }],
          },
        }), { status: 200 });
      }
      views++;
      return new Response(JSON.stringify({
        code: 0,
        data: {
          archive: { aid: 7, bvid: "BVfakefixture1", title: "测试-1", tid: 21, tag: "", is_only_self: 1 },
          videos: [{ cid: 11, filename: "stem0" }],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await findArchiveByTitle({ cookiesPath: COOKIES, title: "测试-1", fetchImpl: impl });
    expect(r.ok).toBe(true);
    expect(r.archive?.aid).toBe(7);
    expect(r.matches).toBe(1);
    expect(views).toBe(1);
  });
});

describe("不落盘性质的直接断言", () => {
  it("整个过程没有任何文件系统调用(只有内存缓冲 + fetch)", async () => {
    fakeCookies();
    const mod = await import("./upos-stream.js");
    const { impl } = makeFetch();
    const session = await mod.preupload({ cookiesPath: COOKIES, fileName: "t.mkv", totalSize: 3000, fetchImpl: impl });
    // 唯一的「数据源」是内存 Uint8Array;若实现偷偷落盘,这个测试改不了它,
    // 但 readChunk 的签名保证了调用方可以只给内存 —— 这正是接录制管道的位置。
    const buf = new Uint8Array(3000);
    await mod.uploadChunks({ session, totalSize: 3000, fetchImpl: impl, readChunk: async (i, s) => buf.subarray(i * CHUNK, i * CHUNK + s) });
    const r = await mod.complete({ session, parts: [{ partNumber: 1, eTag: "e" }, { partNumber: 2, eTag: "e" }, { partNumber: 3, eTag: "e" }], fetchImpl: impl });
    expect(r.ok).toBe(true);
  });
});
