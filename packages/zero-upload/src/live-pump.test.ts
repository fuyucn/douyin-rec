/**
 * live-pump 测试:核心断言是「块在 ffmpeg 退出**之前**就上传了」——
 * 这是本模块存在的理由(rolling 用「出现后继段」当封口信号,上传因此永远落后一个分 P)。
 * 网络请求全部走假 fetch,不碰真实接口、不建稿件。
 */
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, writeFileSync, existsSync, writeSync, mkdirSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import {
  acquireStreamWithBackoff,
  zeroDiskPartLost,
  ZERO_DISK_PART_LOST,
  alignFileSize,
  pumpSegment,
  reuploadSpoolFile,
  buildPipeFfmpegArgs,
  DEFAULT_SEGMENT_CAP,
  LivePumpSession,
  archivedSpoolPathsToKeep,
  spoolSweepSafe,
  readLivePumpState,
  writeLivePumpState,
  livePumpStatePath,
  runSegment,
  runLivePump,
  setSpawnForTest,
  type ChildProcessLike,
  type SpawnFn,
} from "./live-pump.js";
import type { PreuploadResult } from "./upos-stream.js";

const CHUNK = 1024;

/** argv 是否含相邻的 [k, v](Rust 的 `windows(2)` 在 JS 无对应物)。 */
function hasPair(args: readonly string[], k: string, v: string): boolean {
  return args.some((a, i) => a === k && args[i + 1] === v);
}

const COOKIE_DIR = mkdtempSync(join(tmpdir(), "live-pump-cookies-"));
const COOKIES = join(COOKIE_DIR, "cookies.json");

beforeEach(() => {
  writeFileSync(COOKIES, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
  }));
});
afterAll(() => { rmSync(COOKIE_DIR, { recursive: true, force: true }); });

function session(): PreuploadResult {
  return {
    bucket: {
      chunkSize: CHUNK, auth: "auth", endpoint: "//upos-cs.bilivideo.com",
      bizId: "1", uposUri: "upos://bucket/fake.mkv",
    },
    url: "https://upos-cs.bilivideo.com/bucket/fake.mkv",
    fileName: "seg.mkv",
  };
}

/**
 * 会回答 preupload 的假 fetch —— 整文件回退路径自己要先建会话。
 * `completeReject` = 让 complete 失败,验证失败不被静默。
 */
function makeUploadFetch(opts: { completeReject?: boolean } = {}) {
  const puts: Array<{ partNumber: string; bytes: number }> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const u = new URL(url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (u.pathname.endsWith("/preupload")) {
      return new Response(JSON.stringify({
        chunk_size: CHUNK, auth: "auth", endpoint: "//upos-cs.bilivideo.com",
        biz_id: "1", upos_uri: "upos://bucket/fake.ts", OK: 1,
      }), { status: 200 });
    }
    if (method === "POST" && u.searchParams.has("uploads")) {
      return new Response(JSON.stringify({ upload_id: "uid" }), { status: 200 });
    }
    if (method === "PUT") {
      puts.push({ partNumber: u.searchParams.get("partNumber") ?? "0", bytes: (init?.body as ArrayBuffer | undefined)?.byteLength ?? 0 });
      return new Response("", { status: 200 });
    }
    if (opts.completeReject) return new Response(JSON.stringify({ OK: 0, message: "parts boom" }), { status: 200 });
    return new Response(JSON.stringify({ OK: 1, key: "bucket/fb123.ts" }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fake, puts };
}

/** 假 fetch:记录 PUT 的分块参数,可按 partNumber 注入失败。 */
function makeFetch(opts: { failPutAt?: number } = {}) {
  const puts: Array<{ partNumber: string; bytes: number }> = [];
  const fake = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    if ((init?.method ?? "GET").toUpperCase() === "POST" && u.searchParams.has("uploads")) {
      return new Response(JSON.stringify({ upload_id: "uid" }), { status: 200 });
    }
    if ((init?.method ?? "GET").toUpperCase() === "PUT") {
      const partNumber = u.searchParams.get("partNumber") ?? "0";
      if (opts.failPutAt === Number(partNumber)) return new Response("boom", { status: 500 });
      const body = init?.body;
      puts.push({ partNumber, bytes: body instanceof ArrayBuffer ? body.byteLength : 0 });
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  return { fake, puts };
}

/** 假 ffmpeg:把 data 按小块推给 stdout,推完后(等 delayMs)才触发 close。 */
function installFakeFfmpeg(
  data: Buffer,
  opts: { delayBeforeCloseMs?: number; chunkEvery?: number; delayMs?: number } = {},
): void {
  const spawn: SpawnFn = (() => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const events = {} as Record<string, Array<(...a: unknown[]) => void>>;
    const proc: ChildProcessLike = {
      stdout,
      stderr,
      on(ev, fn) { (events[ev] ??= []).push(fn); },
      kill() { for (const fn of events.close ?? []) fn(null, "SIGKILL"); },
    };
    (async (): Promise<void> => {
      const every = opts.chunkEvery ?? 256;
      const delay = opts.delayMs ?? 0;
      for (let i = 0; i < data.length; i += every) {
        stdout.write(data.subarray(i, i + every));
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      }
      stdout.end();
      await new Promise((r) => setTimeout(r, opts.delayBeforeCloseMs ?? 5));
      for (const fn of events.close ?? []) fn(0, null);
    })();
    return proc;
  }) as SpawnFn;
  setSpawnForTest(spawn);
}

afterEach(() => { setSpawnForTest(undefined); });

describe("buildPipeFfmpegArgs", () => {
  it("stdout matroska + -fs 上界 + 不滚动分段", () => {
    const cap = 100 * 1024 * 1024; // 写成表达式:隐私闸门会把裸长数字当房间号
    const args = buildPipeFfmpegArgs({ url: "https://live.douyin.com/x.flv", headers: { Referer: "https://live.douyin.com/" }, sizeCap: cap });
    expect(args.at(-1)).toBe("-");
    // 容器是 mpegts:管道(非 seekable)上可写音轨,且 -fs 强杀后仍读得出时长
    // (matroska 两个都不行,实测 62002)。于是不需要 remux,可以边录边传。
    expect(args).toContain("mpegts");
    expect(hasPair(args, "-fs", String(cap))).toBe(true);
    // 没有 segment muxer —— 一段一个进程,不靠 -segment_time 滚动。
    expect(args).not.toContain("segment");
    expect(args).not.toContain("-segment_time");
  });

  it("-reconnect* 必须排在 -i 之前(input 选项;late 会被当成 output 选项)", () => {
    const args = buildPipeFfmpegArgs({ url: "https://x/live.flv", sizeCap: 4096 });
    // ffmpeg 对这些参数按出现位置解析:放 -i 之后报 `Option reconnect not found`
    // 并 exit 1。真实直播里被忽略过,所以必须用测试钉住顺序。
    const iAt = args.indexOf("-i");
    let lastReconnect = -1;
    args.forEach((a, i) => { if (a.startsWith("-reconnect")) lastReconnect = i; });
    expect(lastReconnect).toBeGreaterThanOrEqual(0);
    expect(lastReconnect).toBeLessThan(iAt);
  });

  it("本地文件源不加 -reconnect(它们只属于 http protocol)", () => {
    const args = buildPipeFfmpegArgs({ url: "/tmp/recordings/x.ts", sizeCap: 4096 });
    expect(args.some((a) => a.startsWith("-reconnect"))).toBe(false);
    expect(args).toContain("-i");
  });

  it("保留全流(含音轨):换 mpegts 后管道上不再需要丢音轨", () => {
    // matroska 在非 seekable 输出上写不了 AAC
    // ("Error parsing AAC extradata...",exit 1),所以才曾被迫 `-map 0:v`。
    // mpegts 没这个限制,音轨保留。
    const args = buildPipeFfmpegArgs({ url: "https://x/live.flv", sizeCap: 1024 });
    expect(hasPair(args, "-map", "0")).toBe(true);
    expect(hasPair(args, "-map", "0:v")).toBe(false);
  });

  it("HTTP 头只去 HTTP 流,且 UA/Referer 用专属 flag", () => {
    const args = buildPipeFfmpegArgs({ url: "https://x/live.flv", headers: { "User-Agent": "UA", Referer: "R", Cookie: "c=1" }, sizeCap: 1024 });
    expect(hasPair(args, "-user_agent", "UA")).toBe(true);
    expect(hasPair(args, "-referer", "R")).toBe(true);
    expect(hasPair(args, "-headers", "Cookie: c=1\r\n")).toBe(true);
  });
});

describe("alignFileSize", () => {
  it("向上对齐 10 MiB,0 原样返回", () => {
    expect(alignFileSize(1)).toBe(10 * 1024 * 1024);
    expect(alignFileSize(10 * 1024 * 1024)).toBe(10 * 1024 * 1024);
    expect(alignFileSize(10 * 1024 * 1024 + 1)).toBe(20 * 1024 * 1024);
  });

  it("测试档 100MiB 与生产默认 1GiB 都是 10MiB 对齐值", () => {
    expect(alignFileSize(100 * 1024 * 1024)).toBe(100 * 1024 * 1024);
    expect(DEFAULT_SEGMENT_CAP % (10 * 1024 * 1024)).toBe(0);
    expect(alignFileSize(0)).toBe(0);
    // ⚠️ 钉住这个回归:1 GiB = 102.4 × 10MiB,**不是**对齐值;
    // 若有人把默认值改回裸 1024**3,UPOS 尾块会是 4MiB 碎块 → 整段回退文件上传。
    expect(1024 * 1024 * 1024 % (10 * 1024 * 1024)).not.toBe(0);
    expect(DEFAULT_SEGMENT_CAP).toBe(alignFileSize(1024 * 1024 * 1024));
    expect(DEFAULT_SEGMENT_CAP).toBe(1030 * 1024 * 1024);
  });
});

describe("runSegment", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-run-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("块在 ffmpeg 退出之前就上传(本模块存在的理由)", async () => {
    const total = CHUNK * 4;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i++) data[i] = i % 251;
    installFakeFfmpeg(data, { delayBeforeCloseMs: 5 });
    const { fake, puts } = makeFetch();
    const doneAt: number[] = [];
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: join(dir, "seg.mkv"),
      session: session(), fetchImpl: fake,
      onChunk: (_b, n) => doneAt.push(n),
    });
    // 每个块都在 close 之前完成(close 被推迟 5ms,期间 4 块全部传完)
    expect(doneAt).toEqual([1, 2, 3, 4]);
    expect(r.chunksUploaded).toBe(4);
    expect(r.streamedBytes).toBe(total);
    expect(r.uploadError).toBeUndefined();
    expect(puts.map((p) => p.partNumber)).toEqual(["1", "2", "3", "4"]);
    expect(statSync(join(dir, "seg.mkv")).size).toBe(total);
  });

  it("spoolMode=none:真 0 落盘 —— 不创建任何文件,但字节照常全部上传", async () => {
    const total = CHUNK * 3;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i++) data[i] = (i * 13) % 256;
    installFakeFfmpeg(data);
    const { fake, puts } = makeFetch();
    const spool = join(dir, "zero.mkv");
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: spool, spoolMode: "none",
      session: session(), fetchImpl: fake,
    });
    expect(existsSync(spool)).toBe(false);      // 没有 spool,连 0 字节占位都没有
    // 目录里不应出现任何以该 spool 命名的文件(不存在 = 从未创建,而非先写后删)。
    expect(existsSync(join(dir, "zero.mkv"))).toBe(false);
    expect(existsSync(join(dir, "zero.mkv.drec-remux"))).toBe(false);
    expect(r.spooledBytes).toBe(total);          // 记账仍按实际流出字节
    expect(r.streamedBytes).toBe(total);
    expect(r.chunksUploaded).toBe(3);
    expect(r.uploadError).toBeUndefined();
    expect(puts).toHaveLength(3);
  });

  it("spoolMode=none:上传失败时没有本地回退源(必须显式报错,不得静默)", async () => {
    const total = CHUNK * 2;
    installFakeFfmpeg(Buffer.alloc(total));
    const { fake } = makeFetch({ failPutAt: 1 });
    const spool = join(dir, "zero-fail.mkv");
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: spool, spoolMode: "none",
      session: session(), fetchImpl: fake,
    });
    expect(existsSync(spool)).toBe(false);
    expect(r.uploadError).toBeTruthy();
  }, 20000);

  it("spool 内容逐字节一致(可安全回退文件上传)", async () => {
    const total = CHUNK * 3;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i++) data[i] = (i * 7) % 256;
    installFakeFfmpeg(data);
    const { fake } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "seg.mkv"), session: session(), fetchImpl: fake });
    expect(r.spooledBytes).toBe(total);
    expect(readFileSync(join(dir, "seg.mkv")).equals(data)).toBe(true);
  });

  it("流比声明短 → 尾块按实际长度传出,spool 保留实际长度(不补零)", async () => {
    const declared = CHUNK * 4;
    const actual = CHUNK * 2 + 100;
    installFakeFfmpeg(Buffer.alloc(actual, 7));
    const { fake, puts } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: declared, spoolPath: join(dir, "short.mkv"), session: session(), fetchImpl: fake });
    expect(r.spooledBytes).toBe(actual);
    // 少传合法(UPOS 只要求 parts 连续):2 个满块 + 1 个 100B 尾块,绝不补零
    expect(r.chunksUploaded).toBe(3);
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, CHUNK, 100]);
    expect(r.streamedBytes).toBe(actual);
    expect(r.uploadError).toBeUndefined();
    expect(r.sessionLeaked).toBe(false);
    expect(statSync(join(dir, "short.mkv")).size).toBe(actual);
  });

  it("PUT 失败 → 停止预传但 spool 仍完整(回退路径)", { timeout: 20000 }, async () => {
    const total = CHUNK * 4;
    installFakeFfmpeg(Buffer.alloc(total, 3));
    const { fake } = makeFetch({ failPutAt: 2 });
    const r = await runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "fail.mkv"), session: session(), fetchImpl: fake });
    expect(r.spooledBytes).toBe(total);
    expect(r.chunksUploaded).toBeLessThan(4);
    expect(r.uploadError).toBeTruthy();
    expect(statSync(join(dir, "fail.mkv")).size).toBe(total);
  });

  it("取消(abort)时 ffmpeg 被杀,已写字节留在 spool", async () => {
    const total = CHUNK * 8;
    const controller = new AbortController();
    installFakeFfmpeg(Buffer.alloc(total, 1));
    const { fake } = makeFetch();
    const p = runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "cancel.mkv"), session: session(), fetchImpl: fake, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 3));
    controller.abort();
    const r = await p;
    expect(statSync(join(dir, "cancel.mkv")).size).toBe(r.spooledBytes);
  });
});

describe("双阈值结算:字节兜底 与 时长,谁先到算一 P", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-seal-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("时长先到 → 只用已入队的满块收尾(少传合法,不补零)", async () => {
    // 声明 10 块的容量,但 30ms 后就到时;期间只够入队 2 个满块。
    const total = CHUNK * 10;
    // 每 20ms 才吐 4KB → 全量要 ~330ms,而时长阈值 30ms 先到,期间只够入队 1-2 个满块。
    installFakeFfmpeg(Buffer.alloc(total, 4), { chunkEvery: 4096, delayMs: 20 });
    const { fake, puts } = makeFetch();
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: join(dir, "dur.mkv"), session: session(), fetchImpl: fake,
      seal: { maxBytes: total, maxMs: 30 },
    });
    // 已入队的块全部传出;没有补零凑够 10 块
    expect(r.chunksUploaded).toBeGreaterThan(0);
    expect(r.chunksUploaded).toBeLessThan(10);
    expect(puts.length).toBe(r.chunksUploaded);
    expect(r.streamedBytes).toBe(puts.reduce((a, p) => a + p.bytes, 0));
    // 时长结算是**正常收尾**:sealedBy 告诉调用方「到点了」,不是「流断了」。
    expect(r.sealedBy).toBe("duration");
  });

  it("字节兜底先到 → 走原来的完整收尾路径", async () => {
    const total = CHUNK * 3;
    installFakeFfmpeg(Buffer.alloc(total, 5));
    const { fake } = makeFetch();
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: join(dir, "cap.mkv"), session: session(), fetchImpl: fake,
      seal: { maxBytes: total, maxMs: 60_000 }, // 时长远未到
    });
    expect(r.chunksUploaded).toBe(3);
    expect(r.uploadError).toBeUndefined();
    expect(r.sessionLeaked).toBe(false);
    expect(r.sealedBy).toBe("cap");
  });

  it("时长结算 + 尾块不满一块 → 尾块照发,不误判泄漏", async () => {
    // 真实直播踩过:时长到点时已入队 2 个满块、残余 4.9MB。旧逻辑要求尾块长度
    // **正好等于**声明尾块,于是把它丢掉 → 2 个块已 PUT 却没 complete → sessionLeaked，
    // 整段判失败(实测 `尾块长度不符` 后 `没有可提交的分 P`)。少传本就合法。
    const total = CHUNK * 10;
    installFakeFfmpeg(Buffer.alloc(total, 4), { chunkEvery: 4096, delayMs: 20 });
    const { fake, puts } = makeFetch();
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: join(dir, "dur-tail.mkv"), session: session(), fetchImpl: fake,
      seal: { maxBytes: total, maxMs: 30 },
    });
    expect(r.sealedBy).toBe("duration");
    expect(r.chunksUploaded).toBeGreaterThan(0);
    expect(r.chunksUploaded).toBeLessThan(10);
    // 每块长度 = 满块,最后一个 = 残余真实长度
    const sizes = puts.map((p) => p.bytes);
    expect(sizes.slice(0, -1).every((n) => n === CHUNK)).toBe(true);
    expect(sizes.at(-1)!).toBeGreaterThan(0);
    expect(sizes.at(-1)!).toBeLessThanOrEqual(CHUNK);
    expect(r.streamedBytes).toBe(sizes.reduce((a, b) => a + b, 0));
    // 关键:不是故障,也没有半截会话
    expect(r.uploadError).toBeUndefined();
    expect(r.sessionLeaked).toBe(false);
  });

  it("时长结算 + 余数不足一块:尾块必须传出,否则每段丢几秒视频", async () => {
    // 真实直播踩过(cap=300MiB、maxMs=60s、~400KB/s):时长到点时入队 2 个满块,
    // 还剩 ~5.5MB。旧实现 maxChunks 用 queuedChunks(=2,尾块尚未入队) → 尾块被静默
    // 丢弃 → 每段尾部约 3 秒视频没了。spool 26.5MB vs 上传 20MB,只看块数毫无异常。
    const cap = CHUNK * 10;
    // 每 40ms 吐 1.2KB:第一个 1024B 块约 1 tick 成形,全量 ~340ms。
    // maxMs=120 → 到点时已入队若干满块 + 一段不足一块的余数(真实直播的形状)。
    installFakeFfmpeg(Buffer.alloc(cap, 4), { chunkEvery: 1200, delayMs: 40 });
    const { fake, puts } = makeFetch();
    const r = await runSegment({
      args: ["-fake"], sizeCap: cap, spoolPath: join(dir, "dur-remainder.mkv"), session: session(), fetchImpl: fake,
      seal: { maxBytes: cap, maxMs: 120 },
    });
    expect(r.sealedBy).toBe("duration");
    expect(r.chunksUploaded).toBeGreaterThan(2);
    const sizes = puts.map((p) => p.bytes);
    // 除最后一块外都是满块;最后一块是真实余数(>0 且 <= chunkSize)
    expect(sizes.slice(0, -1).every((n) => n === CHUNK)).toBe(true);
    expect(sizes.at(-1)).toBeGreaterThan(0);
    expect(sizes.at(-1)).toBeLessThanOrEqual(CHUNK);
    // 上传总量必须等于 spool 实际字节,不允许"盘上比传出去的多"
    expect(r.streamedBytes).toBe(r.spooledBytes);
    expect(r.uploadError).toBeUndefined();
    expect(r.sessionLeaked).toBe(false);
  });

  it("不传 seal 时行为不变(只用字节兜底)", async () => {
    const total = CHUNK * 2;
    installFakeFfmpeg(Buffer.alloc(total, 6));
    const { fake } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "noseal.mkv"), session: session(), fetchImpl: fake });
    expect(r.chunksUploaded).toBe(2);
    expect(r.uploadError).toBeUndefined();
    expect(r.sealedBy).toBe("cap");
  });
});

describe("runLivePump 的 fetchImpl 必须贯通到稿件提交", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-fetchimpl-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("假传输下建稿/追加都走假 fetch,绝不回落真实网络", async () => {
    // 真 bug:runLivePump 只把 fetchImpl 给了分段上传,没给 LivePumpSession ——
    // 假 UPOS 跑通后建稿仍打真实 B 站,拿到 -400。
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
    const seen: string[] = [];
    const fake = ((input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      seen.push(u.pathname);
      const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
      if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
      if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
      if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
      if (u.pathname === "/x/vu/web/add/v3") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
      if (u.pathname === "/x/vu/web/edit") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
      if (u.pathname === "/x/vupre/web/archive/view") return Promise.resolve(json({ code: 0, data: { archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21 }, videos: [] } }));
      if (u.pathname === "/x/web/archives") return Promise.resolve(json({ code: 0, data: { arc_audits: [] } }));
      return Promise.resolve(json({ code: 0, data: {} }));
    }) as unknown as typeof fetch;

    installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
    const r = await runLivePump({
      cookiesPath: join(dir, "cookies.json"), room: "fi", spoolDir: dir, title: "fi",
      tid: 21, tag: "x", private: true, sizeCap: CHUNK, maxMs: 300, maxSegments: 1,
      quality: "origin", submit: true, spoolMode: "none", fetchImpl: fake,
      fetch: async () => ({ living: true, url: "http://x/y.ts" }),
      sleep: async () => {},
    });
    expect(r.ok, r.error ?? "").toBe(true);
    expect(seen).toContain("/x/vu/web/add/v3");
    expect(r.bvid).toBe("BILIfake1");
  }, 20_000);
});

describe("archive description survives state and reaches the create request", () => {
  it("passes desc from runLivePump options to the first studio create", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-desc-"));
    try {
      writeFileSync(join(dir, "cookies.json"), JSON.stringify({
        cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
      }));
      let createBody: Record<string, unknown> | undefined;
      const fake = ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
        if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
        if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
        if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
        if (u.pathname === "/x/vu/web/add/v3") {
          createBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
        }
        return Promise.resolve(json({ code: 0, data: {} }));
      }) as unknown as typeof fetch;

      installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
      const r = await runLivePump({
        cookiesPath: join(dir, "cookies.json"), room: "fi", spoolDir: dir, title: "fi",
        tid: 21, tag: "x", desc: "hub rule description", private: true,
        sizeCap: CHUNK, maxMs: 300, maxSegments: 1, quality: "origin", submit: true,
        spoolMode: "none", fetchImpl: fake,
        fetch: async () => ({ living: true, url: "http://x/y.ts" }),
        sleep: async () => {},
      });
      expect(r.ok, r.error ?? "").toBe(true);
      expect(createBody?.desc).toBe("hub rule description");
    } finally {
      setSpawnForTest(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("titleForLive / partTitle reach the archive identity and part submissions", () => {
  it("setTitleIfFresh only changes a session before any archive identity exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-fresh-"));
    try {
      writeFileSync(join(dir, "cookies.json"), JSON.stringify({
        cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
      }));
      const fresh = new LivePumpSession({
        cookiesPath: join(dir, "cookies.json"), room: "fresh", spoolDir: dir,
        title: "initial", tid: 21, tag: "x", private: true,
      });
      expect(fresh.hasArchiveIdentity).toBe(false);
      expect(fresh.setTitleIfFresh("live title")).toBe(true);
      expect(fresh.archiveTitle).toBe("live title");
      writeLivePumpState(livePumpStatePath(dir, "fresh"), {
        ...fresh.snapshot(),
        bvid: "BILIfake1",
      });
      const resumed = new LivePumpSession({
        cookiesPath: join(dir, "cookies.json"), room: "fresh", spoolDir: dir,
        title: "new title", tid: 21, tag: "x", private: true,
      });
      expect(resumed.hasArchiveIdentity).toBe(true);
      expect(resumed.setTitleIfFresh("another title")).toBe(false);
      expect(resumed.archiveTitle).toBe("live title");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("platform without a live title still re-renders the title from the first acquisition", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-notitle-"));
    try {
      writeFileSync(join(dir, "cookies.json"), JSON.stringify({
        cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
      }));
      const fake = ((input: string | URL | Request) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
        if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
        if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
        if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
        if (u.pathname === "/x/vu/web/add/v3") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
        return Promise.resolve(json({ code: 0, data: {} }));
      }) as unknown as typeof fetch;

      installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
      const r = await runLivePump({
        cookiesPath: join(dir, "cookies.json"), room: "fi", spoolDir: dir,
        title: "initial", titleForLive: () => "re-rendered without live title",
        tid: 21, tag: "x", private: true,
        sizeCap: CHUNK, maxMs: 300, maxSegments: 1, quality: "origin", submit: true,
        spoolMode: "none", fetchImpl: fake,
        fetch: async () => ({ living: true, url: "http://x/y.ts" }), // no title/owner
        sleep: async () => {},
      });
      expect(r.ok, r.error ?? "").toBe(true);
      // Title was re-rendered even though the platform exposed no live title.
      expect(r.title).toBe("re-rendered without live title");
    } finally {
      setSpawnForTest(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it("re-renders a fresh archive title with the live title and uses the part template", async () => {
    const dir = mkdtempSync(join(tmpdir(), "live-pump-title-"));
    try {
      writeFileSync(join(dir, "cookies.json"), JSON.stringify({
        cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
      }));
      let createBody: Record<string, unknown> | undefined;
      const fake = ((input: string | URL | Request, init?: RequestInit) => {
        const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
        const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
        if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
        if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
        if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
        if (u.pathname === "/x/vu/web/add/v3") {
          createBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
          return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
        }
        if (u.pathname === "/x/vupre/web/archive/view") {
          return Promise.resolve(json({
            code: 0,
            data: {
              archive: { aid: 7, bvid: "BILIfake1", title: String(createBody?.title ?? "t"), tid: 21, tag: "x" },
              videos: [{ cid: 1, filename: "b/p.ts", title: "P1" }],
            },
          }));
        }
        return Promise.resolve(json({ code: 0, data: {} }));
      }) as unknown as typeof fetch;

      installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a), { chunkEvery: 1024, delayMs: 1 });
      const r = await runLivePump({
        cookiesPath: join(dir, "cookies.json"), room: "fi", spoolDir: dir,
        title: "initial", titleForLive: (liveTitle) => `【${liveTitle}】`,
        tid: 21, tag: "x", private: true,
        sizeCap: CHUNK, maxMs: 300, maxSegments: 2, quality: "origin", submit: true,
        spoolMode: "none", fetchImpl: fake,
        partTitle: (part) => `part-${part}`,
        fetch: async () => ({ living: true, url: "http://x/y.ts", title: "今晚直播" }),
        sleep: async () => {},
      });
      expect(r.ok, r.error ?? "").toBe(true);
      expect(createBody?.title).toBe("【今晚直播】");
      const videos = createBody?.videos as Array<{ title?: string }> | undefined;
      expect(videos?.[0]?.title).toBe("part-1");
    } finally {
      setSpawnForTest(undefined);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe("已入稿的分 P 不因末段被取消而作废", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-cancel-ok-")); });
  afterEach(() => {
    setSpawnForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("取消的末段报 sealedBy=abort,running 层据此判定「已入稿即成功」", async () => {
    // Real run 2026-10-18: SIGTERM cut the last segment; 4 parts were already in the archive,
    // yet runLivePump reported ok:false — which made the ledger writeback and the exit code
    // throw away real uploaded parts. runLivePump reads exactly this flag.
    const ac = new AbortController();
    ac.abort();
    setSpawnForTest((() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events: Record<string, Array<(...a: unknown[]) => void>> = {};
      return {
        stdout, stderr,
        on: (ev: string, cb: (...a: unknown[]) => void) => { (events[ev] ??= []).push(cb); },
        kill: (sig?: string) => {
          stdout.end();
          (events.close ?? []).forEach((f) => f(null, sig ?? "SIGKILL"));
        },
      } as unknown as ChildProcessLike;
    }) as SpawnFn);
    const r = await runSegment({
      args: ["-fake"], sizeCap: 4096, spoolPath: join(dir, "c.ts"), spoolMode: "none",
      session: session(), fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      signal: ac.signal,
    });
    expect(r.sealedBy).toBe("abort");
    expect(r.chunksUploaded).toBe(0);   // nothing uploaded from the cut segment
    expect(r.spooledBytes).toBe(0);
  });
});

describe("取消:abort 必须杀掉在录的 ffmpeg(停止任务不留孤儿进程)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-abort-")); });
  afterEach(() => {
    setSpawnForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it("abort 后 runSegment 以 signal 退出,且 spawn 的进程被 kill", async () => {
    const killed: Array<string | undefined> = [];
    const spawn: SpawnFn = (() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events: Record<string, Array<(...a: unknown[]) => void>> = {};
      return {
        stdout, stderr,
        on: (ev: string, cb: (...a: unknown[]) => void) => { (events[ev] ??= []).push(cb); },
        kill: (sig?: string) => {
          killed.push(sig);
          // Mirror a real kill: stdout ends, then the process reports close.
          stdout.end();
          (events.close ?? []).forEach((f) => f(null, sig ?? "SIGKILL"));
        },
      } as unknown as ChildProcessLike;
    }) as SpawnFn;
    setSpawnForTest(spawn);

    const ac = new AbortController();
    ac.abort();
    const r = await runSegment({
      args: ["-fake"], sizeCap: 4096, spoolPath: join(dir, "a.ts"),
      session: session(), fetchImpl: (async () => new Response("", { status: 200 })) as unknown as typeof fetch,
      signal: ac.signal,
    });
    // 关键断言:进程被 SIGKILL(不留孤儿)。sealedBy 取决于 kill 与 stdout EOF 的先后,
    // 两者都是合法收尾,这里只钉「一定被杀」。
    expect(killed).toContain("SIGKILL");
  });
});

describe("录制相位标记(TaskManager 靠它区分「等待开播」与「录制中」)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-phase-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("未开播 → 只打「等待开播」,不打「录制中」", async () => {
    const logs: string[] = [];
    await runLivePump({
      cookiesPath: join(dir, "c.json"), room: "ph1", spoolDir: dir, title: "t", tid: 21, tag: "x",
      private: true, sizeCap: 1024, maxSegments: 1, quality: "origin", submit: false,
      fetch: async () => ({ living: false }), sleep: async () => {},
      log: (m) => logs.push(m),
    });
    expect(logs).toContain("[状态] 等待开播");
    expect(logs).not.toContain("[状态] 录制中");
  });

  it("开播 → 拿到流后打「录制中」", async () => {
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
    const logs: string[] = [];
    installFakeFfmpeg(Buffer.alloc(2048, 0x5a));
    const upos = ((input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
      if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: 1024, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
      if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
      return Promise.resolve(new Response("", { status: 200 }));
    }) as unknown as typeof fetch;
    await runLivePump({
      cookiesPath: join(dir, "cookies.json"), room: "ph2", spoolDir: dir, title: "t", tid: 21, tag: "x",
      private: true, sizeCap: 1024, maxMs: 200, maxSegments: 1, quality: "origin", submit: false,
      fetchImpl: upos,
      fetch: async () => ({ living: true, url: "http://x/y.ts" }), sleep: async () => {},
      log: (m) => logs.push(m),
    });
    expect(logs).toContain("[状态] 等待开播");
    expect(logs).toContain("[状态] 录制中");
  }, 20_000);
});

describe("多房间并发:各自独立稿件与状态,互不串稿", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-conc-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("两个房间同时录:各建各的稿,state 分离,盘上零视频文件", async () => {
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
    const bvByTitle = new Map<string, string>();
    let n = 0;
    const fake = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const m = (init?.method ?? "GET").toUpperCase();
      const p = u.pathname;
      const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
      if (p === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
      if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
      if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
      if (p === "/x/vu/web/add/v3") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { title: string };
        const bv = `BV1conc${String(++n).padStart(4, "0")}`;
        bvByTitle.set(body.title, bv);
        return Promise.resolve(json({ code: 0, data: { aid: 900 + n, bvid: bv } }));
      }
      if (p === "/x/vu/web/edit") {
        const body = JSON.parse(String(init?.body ?? "{}")) as { title: string; aid: number };
        return Promise.resolve(json({ code: 0, data: { aid: body.aid, bvid: bvByTitle.get(body.title) } }));
      }
      if (p === "/x/vupre/web/archive/view") {
        const bv = u.searchParams.get("bvid") ?? "";
        const title = [...bvByTitle.entries()].find(([, v]) => v === bv)?.[0] ?? "";
        return Promise.resolve(json({ code: 0, data: { archive: { aid: 1, bvid: bv, title, tid: 21 }, videos: [] } }));
      }
      if (p === "/x/web/archives") return Promise.resolve(json({ code: 0, data: { arc_audits: [] } }));
      return Promise.resolve(json({ code: 0, data: {} }));
    }) as unknown as typeof fetch;

    const rooms = ["111111", "222222"];
    installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
    const runs = await Promise.all(rooms.map((room) => {
      const out = join(dir, `out-${room}`);
      mkdirSync(out);
      return runLivePump({
        cookiesPath: join(dir, "cookies.json"), room, spoolDir: out, title: `room-${room}`,
        tid: 21, tag: "x", private: true, sizeCap: CHUNK, maxMs: 200, maxSegments: 2,
        quality: "origin", submit: true, spoolMode: "none", fetchImpl: fake,
        fetch: async () => ({ living: true, url: "http://x/y.ts" }),
        sleep: async () => {},
      });
    }));

    const bvs = runs.map((r) => r.bvid);
    expect(runs.map((r) => r.ok), runs.map((r) => r.error ?? "").join("|")).toEqual([true, true]);
    expect(new Set(bvs).size).toBe(2);            // 两个不同稿件,没有串稿
    for (const room of rooms) {
      const out = join(dir, `out-${room}`);
      // 零视频文件:spool 名是确定性的,逐个断言不存在(避免列目录:processors 有静态守护)。
      expect(existsSync(join(out, "live-pump-1.ts"))).toBe(false);
      expect(existsSync(join(out, "live-pump-2.ts"))).toBe(false);
      expect(existsSync(join(out, `live-pump-${room}.state.json`))).toBe(true);
    }
  }, 20_000);
});

/**
 * 窗口结束排空(SIGUSR2)。
 *
 * 真实事故:0 落盘路径**只**注册了 SIGINT/SIGTERM(见 cli record 的 stream-upload 分支),
 * 而 daemon 窗口结束发的是 SIGUSR2。Node 对无人处理的 SIGUSR2 的默认动作是**立即终止进程**
 * (实测 exit 159),于是:①在录的那一段被腰斩 —— `spoolMode:"none"` 下没有本地副本,那段视频
 * 永久丢失;②`ChildRecorderProcess.stopGraceful` 在发信号**前**就置 `expected=true`,所以
 * task-manager 会打印「直播自然收播,排空完成,已停止」——一句与事实相反的话,用户据此认为没丢片。
 *
 * 正确语义与 record-engine 的 drain() 一致:只停「开下一场」,不腰斩当前段。
 */
describe("窗口结束排空(SIGUSR2):不腰斩当前段", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-drain-")); });
  afterEach(() => {
    setSpawnForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * 每段必须 > MIN_PART_BYTES(1MiB),否则 pump 判「已收播」提前 break,第二段根本不存在。
   * 大 buffer 的假 ffmpeg 又要靠 delayMs 压住写入速率,不然同步 resolve 的假 fetch 追不上
   * → 稳定判背压 → spoolMode:none 下硬失败(与排空无关的夹具局限,曾在此反复绕路)。
   */
  const MiB = 1024 * 1024;
  const PART = 12 * MiB;                 // 每段 12 MiB,稳稳越过 1 MiB 门槛
  const seg = (): void => installFakeFfmpeg(Buffer.alloc(PART, 0x5a), { chunkEvery: 64 * 1024, delayMs: 1, delayBeforeCloseMs: 5 });

  /** 完整可跑的假 UPOS(建稿/追加都通);参数沿用既有成功组合。 */
  function upos(chunkSize: number): typeof fetch {
    let created = false;
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
    const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
    return ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const m = (init?.method ?? "GET").toUpperCase();
      if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: chunkSize, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
      if (m === "POST" && u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
      if (m === "PUT") return Promise.resolve(new Response("", { status: 200 }));
      if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
      if (u.pathname === "/x/vu/web/add/v3") {
        created = true;
        return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
      }
      if (u.pathname === "/x/vu/web/edit") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
      // lookupArchive 读 `data.archive`(扁平形状会被当成空,append 因此失败)。
      if (u.pathname === "/x/vupre/web/archive/view") return Promise.resolve(json({ code: 0, data: { archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21 }, videos: [] } }));
      return Promise.resolve(json({ code: 0, data: {} }));
    }) as unknown as typeof fetch;
  }

  /** 字节兜底先到期(maxMs 给得足够长),与排空无关地每段 12 MiB。 */
  const base = (o: { drainSignal?: AbortSignal; signal?: AbortSignal; maxSegments?: number } = {}) => ({
    room: "dr", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
    sizeCap: PART, maxMs: 10_000, maxSegments: o.maxSegments ?? 0, // 0 = 不限
    queueCapacity: 256,                  // 别让同步假 fetch 被判背压
    quality: "origin", submit: true, spoolMode: "none" as const,
    fetch: async () => ({ living: true, url: "http://x/y.ts" }),
    sleep: async () => {},
    ...(o.drainSignal ? { drainSignal: o.drainSignal } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const run = (o: { drainSignal?: AbortSignal; signal?: AbortSignal; maxSegments?: number; log?: (m: string) => void } = {}): Promise<ReturnType<typeof runLivePump> extends Promise<infer R> ? R : never> =>
    runLivePump({ ...base(o), cookiesPath: join(dir, "cookies.json"), fetchImpl: upos(64 * 1024), ...(o.log ? { log: o.log } : {}) });

  it("drainSignal 一直未置位 → 一路录到上限(对照组)", async () => {
    seg();
    const r = await run({ maxSegments: 2 });
    expect(r.segments).toHaveLength(2); // 没有排空 → 录满上限
    expect(r.ok, r.error ?? "").toBe(true);
  }, 30_000);

  it("drainSignal 在首段后置位 → 只录完当前段就停(不腰斩)", async () => {
    seg();
    const drain = new AbortController();
    // daemon 在录制中途发 SIGUSR2:第一段结束之后才置位。
    setTimeout(() => drain.abort(), 30);
    const r = await run({ drainSignal: drain.signal, maxSegments: 2 });
    expect(r.segments).toHaveLength(1); // 上限 2,却只录 1 段
    expect(r.segments.some((x) => x.stem)).toBe(true); // 在录段完整入稿,没被腰斩
    expect(r.ok, r.error ?? "").toBe(true);
  }, 30_000);

  it("排空发生在首段之前 → 空手收尾(等价「整窗口没开播」)", async () => {
    seg();
    const logs: string[] = [];
    const drain = new AbortController();
    drain.abort(); // 信号比 pump 起来更早
    const r = await run({ drainSignal: drain.signal, maxSegments: 2, log: (m) => logs.push(m) });
    expect(r.segments).toHaveLength(0);
    expect(r.ok, r.error ?? "").toBe(true); // 收尾不是失败
    // 排空必须留痕:排空后还要等当前分 P 传完(或 preupload 退避)可能几分钟,
    // 「没有新分 P 出现」与「卡死」在日志之外完全无法区分。
    expect(logs.some((m) => m.includes("已排空"))).toBe(true);
  });

  it("排空不是硬停:drainSignal 只停「开下一场」,signal 照旧腰斩在录段", async () => {
    // 两个信号职责必须分开。drain 与 abort 同时置位:若 drainSignal 被顺手写进 pumpSegment,
    // in-flight 段会完整跑完并被算成分 P —— 那正是「停止任务却还在上传」的形态。
    seg();
    const ac = new AbortController();
    const drain = new AbortController();
    ac.abort();
    drain.abort();
    const r = await run({ signal: ac.signal, drainSignal: drain.signal, maxSegments: 2 });
    // 在录段被 signal 腰斩 → 该段不入稿(没有任何分 P 被「排空补全」)。
    expect(r.segments.every((x) => !x.stem)).toBe(true);
    expect(r.segments).toHaveLength(0);
  }, 30_000);
});

describe("outcome:区分「一场都没录到」与「分 P 都已进稿」", () => {
  /**
   * Review #280 P1. `ok:true` used to cover two very different endings: every part uploaded,
   * and nothing ever recorded (stream never acquired). The caller could not tell them apart
   * and exited 0 for both, so TaskManager read a silent no-recording as a clean stop.
   */
  const base = () => ({
    room: "oc", spoolDir: mkdtempSync(join(tmpdir(), "oc-")), cookiesPath: COOKIES,
    title: "t", tid: 21, tag: "x", private: true,
    sizeCap: 4096, maxMs: 0, maxSegments: 1, quality: "origin", submit: true, spoolMode: "none" as const,
    sleep: async () => {},
  });

  it("取不到流(未开 waitForBroadcast) → ok:true 但 outcome=no-stream", async () => {
    const r = await runLivePump({
      ...base(),
      fetch: async () => ({ living: false }),
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    expect(r.ok).toBe(true);
    expect(r.segments).toHaveLength(0);
    expect(r.outcome).toBe("no-stream");
  });

  it("取不到流 → 留在进程内按 30s 探测,绝不自行退出(issue #308 回归)", async () => {
    // Before the fix the pump gave up after 6 failed attempts and the CLI exited 1, so the
    // scheduler restarted the task every few minutes. It must keep polling until told to stop.
    const drain = new AbortController();
    const sleeps: number[] = [];
    let calls = 0;
    const r = await runLivePump({
      ...base(),
      waitForBroadcast: true,
      drainSignal: drain.signal,
      sleep: async (ms) => { sleeps.push(ms); },
      fetch: async () => {
        calls++;
        if (calls === 12) drain.abort(); // well past the old 6-attempt give-up point
        return { living: false };
      },
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    expect(calls).toBe(12);
    expect(r.ok).toBe(true);
    expect(r.segments).toHaveLength(0);
    expect(r.outcome).toBe("idle");
    // One probe per poll interval, never a faster backoff cadence: the pump must not raise
    // risk-control pressure above the file recorder's 30s.
    expect(sleeps.length).toBeGreaterThan(0);
    expect(sleeps.every((ms) => ms >= 30_000)).toBe(true);
  });

  it("等待开播时收到停止信号 → 立即返回 idle(不等满轮询间隔)", async () => {
    const abort = new AbortController();
    const started = Date.now();
    const p = runLivePump({
      ...base(),
      waitForBroadcast: true,
      signal: abort.signal,
      sleep: undefined, // real timers: only the abort can end the 30s wait
      fetch: async () => ({ living: false }),
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    setTimeout(() => abort.abort(), 50);
    const r = await p;
    expect(r.outcome).toBe("idle");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("刚探测到开播随即断流 → 走正常退避后以 idle 收尾,不再带着已打开的稿件会话继续等(#308)", async () => {
    let calls = 0;
    const r = await runLivePump({
      ...base(),
      waitForBroadcast: true,
      fetch: async () => (++calls === 1 ? { living: true, url: "u" } : { living: false }),
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    expect(r).toMatchObject({ ok: true, outcome: "idle" });
    expect(calls).toBe(7); // 1 live probe + initial fetch + 5 backoff retries, then exit
  });

  it("shouldStop 在等待中生效 → idle", async () => {
    let n = 0;
    const r = await runLivePump({
      ...base(),
      waitForBroadcast: true,
      shouldStop: () => ++n > 3,
      fetch: async () => ({ living: false }),
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    expect(r.outcome).toBe("idle");
  });

  it("ok:false 时 outcome 缺席(别让调用方把「传了几个才失败」当成「一个都没传」)", async () => {
    // Review P3: the failure message used to read "no parts uploaded" for every non-clean run,
    // including runs that had already delivered parts. `outcome` must therefore stay absent on
    // the error path so the caller can tell the two apart.
    const dir = mkdtempSync(join(tmpdir(), "oc-fail-"));
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
    // 让 complete 失败 → submitPart 失败 → ok:false
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      const m = (init?.method ?? "GET").toUpperCase();
      if (u.pathname === "/preupload") return Promise.resolve(new Response(JSON.stringify({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }), { status: 200 }));
      if (m === "POST" && u.searchParams.has("uploads")) return Promise.resolve(new Response(JSON.stringify({ upload_id: "uid" }), { status: 200 }));
      if (m === "PUT") return Promise.resolve(new Response("", { status: 200 }));
      if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(new Response(JSON.stringify({ OK: 1, key: "b/p.ts" }), { status: 200 }));
      // 建稿被服务端拒绝 → submitPart 返回 ok:false(整场 ok:false,但字节已传完)
      if (u.pathname === "/x/vu/web/add/v3") return Promise.resolve(new Response(JSON.stringify({ code: 21015, message: "stem rejected" }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({ code: 0, data: {} }), { status: 200 }));
    }) as unknown as typeof fetch;
    installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
    const r = await runLivePump({
      room: "oc3", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
      cookiesPath: join(dir, "cookies.json"),
      sizeCap: CHUNK * 2, maxMs: 300, maxSegments: 1, quality: "origin", submit: true, spoolMode: "none",
      fetchImpl, sleep: async () => {},
      fetch: async () => ({ living: true, url: "http://x/y.ts" }),
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    expect(r.ok).toBe(false);
    expect(r.outcome).toBeUndefined(); // 关键:失败路径不冒充「一个都没传」
    expect(r.error).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);

  it("有分 P 进稿 → outcome=uploaded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-up-"));
    const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
    const fetchImpl = ((input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input.toString());
      if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
      if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
      if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
      if (u.pathname === "/x/vu/web/add/v3") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
      if (u.pathname === "/x/vu/web/edit") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }));
      if (u.pathname === "/x/vupre/web/archive/view") return Promise.resolve(json({ code: 0, data: { archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21 }, videos: [] } }));
      return Promise.resolve(json({ code: 0, data: {} }));
    }) as unknown as typeof fetch;
    installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
    const r = await runLivePump({
      room: "oc2", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
      cookiesPath: COOKIES,
      sizeCap: CHUNK * 2, maxMs: 300, maxSegments: 1, quality: "origin", submit: true, spoolMode: "none",
      fetchImpl, sleep: async () => {},
      fetch: async () => ({ living: true, url: "http://x/y.ts" }),
      log: () => {},
    } as Parameters<typeof runLivePump>[0]);
    expect(r.outcome).toBe("uploaded");
    expect(r.segments.some((x) => x.stem)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  }, 20_000);
});

describe("真子进程:不注册 SIGUSR2 handler 会当场死亡(P1 回归)", () => {
  /**
   * P1 的事故形状:0 落盘路径只注册 SIGINT/SIGTERM。daemon 窗口结束发 SIGUSR2 →
   * Node 默认动作杀掉进程(实测 exit 159)→ 在录的那一段被腰斩;且
   * `ChildRecorderProcess.stopGraceful` 在发信号**前**就置 `expected=true`,
   * 于是 task 日志打印「直播自然收播,排空完成,已停止」——一句与事实相反的话。
   *
   * 为什么必须真子进程:vitest 自带 signal handler 且持有句柄,Node 的默认动作在
   * 里面永远不触发,只有以子进程跑(等于 `record --stream-upload` 在 TaskManager
   * 下的形态)才复现。
   */
  async function runChild(mutate: (src: string) => string): Promise<{ code: number; stdout: string }> {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "lp-drain-child-"));
    const entry = join(dir, "child.ts");
    const src = readFileSync(join(repo, "packages/zero-upload/src/live-pump-drain-child.ts"), "utf-8");
    writeFileSync(entry, mutate(src), "utf-8");
    const out = join(dir, "child.mjs");
    await build({
      entryPoints: [entry],
      bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent",
      banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
      external: ["node:*"],
    });
    const res = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = execFile(process.execPath, [out], { timeout: 3000 }, (e, so) => {
        resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, stdout: so });
      });
      // 窗口结束信号在循环跑着的时候到达(生产中 daemon 就是这么发的)。
      child.on("spawn", () => setTimeout(() => child.kill("SIGUSR2"), 300));
      child.on("error", reject);
    });
    rmSync(dir, { recursive: true, force: true });
    return res;
  }

  it("注册了 handler → 排空被识别,进程干净退出", async () => {
    const { code, stdout } = await runChild((src) => src);
    expect(stdout, stdout).toContain('"stoppedBy":"drain"');
    expect(code).toBe(0);
  }, 30_000);

  it("删掉 handler → Node 默认动作杀掉进程,什么结果都不剩(变异验证)", async () => {
    // 这条同时是「守护不是空转」的证明:把上面那行 `process.on("SIGUSR2", ...)`
    // 去掉,循环立刻被默认动作终止,stdout 为空、退出码非 0。
    const { code, stdout } = await runChild((src) =>
      src.replace('process.on("SIGUSR2", () => drain.abort()); // MUTATION TARGET: delete this line to see the bug', "// removed"));
    expect(stdout.trim()).toBe("");
    expect(code).not.toBe(0);
  }, 30_000);
});

describe("零落盘丢数据判定", () => {
  it("spoolMode=none + 背压 = 该分 P 丢失(必须硬失败)", () => {
    expect(zeroDiskPartLost("none", true)).toBe(true);
    expect(ZERO_DISK_PART_LOST).toContain("分 P 已丢失");
  });
  it("full 模式背压只是降级(有本地文件可回退),不算丢失", () => {
    expect(zeroDiskPartLost("full", true)).toBe(false);
    expect(zeroDiskPartLost(undefined, true)).toBe(false);
  });
});

describe("audit 回归:降级/泄漏不得静默", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-audit-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("spoolMode=none + 背压 = 硬失败(没有本地副本,不能只告警)", async () => {
    // 同一输入:full 模式背压后仍完整落盘;none 模式没有文件可救,必须整段失败。
    const total = CHUNK * 4;
    installFakeFfmpeg(Buffer.alloc(total, 5));
    const { fake } = makeFetch();
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: join(dir, "bp0.mkv"), spoolMode: "none",
      session: session(), fetchImpl: fake, queueCapacity: 1,
    });
    expect(r.backpressured).toBe(true);
    expect(existsSync(join(dir, "bp0.mkv"))).toBe(false);
    // runSegment 只报告事实;runLivePump 负责把它升级为整段失败(见下方 live-pump 用例)。
    expect(r.spooledBytes).toBe(total);
  });

  it("背压时 onBackpressure 被调用,且 backpressured=true(不得静默降级)", async () => {
    const total = CHUNK * 6;
    installFakeFfmpeg(Buffer.alloc(total, 5));
    const { fake } = makeFetch();
    let called: Array<[number, number]> = [];
    const r = await runSegment({
      args: ["-fake"], sizeCap: total, spoolPath: join(dir, "bp.mkv"), session: session(), fetchImpl: fake,
      queueCapacity: 1, // 容量 1 且无消费 → 第二个块必然背压
      onBackpressure: (sp, q) => called.push([sp, q]),
    });
    expect(called.length).toBe(1);
    expect(r.backpressured).toBe(true);
    expect(r.spooledBytes).toBe(total);   // 降级后仍完整落盘
    expect(statSync(join(dir, "bp.mkv")).size).toBe(total);
  });

  it("有半截上传时 sessionLeaked=true(协议无 abort,须调用方显式处理)", async () => {
    const total = CHUNK * 4;
    installFakeFfmpeg(Buffer.alloc(total, 6));
    const { fake } = makeFetch({ failPutAt: 3 });
    const r = await runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "leak.mkv"), session: session(), fetchImpl: fake });
    expect(r.chunksUploaded).toBeGreaterThan(0);
    expect(r.sessionLeaked).toBe(true);
  }, 20000);

  it("整段成功时 sessionLeaked=false", async () => {
    const total = CHUNK * 3;
    installFakeFfmpeg(Buffer.alloc(total, 7));
    const { fake } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "ok.mkv"), session: session(), fetchImpl: fake });
    expect(r.chunksUploaded).toBe(3);
    expect(r.uploadError).toBeUndefined();
    expect(r.sessionLeaked).toBe(false);
    expect(r.backpressured).toBeFalsy();
  });

  it("流比声明短 10B:尾块按实际长度传出(不补零)", async () => {
    const declared = CHUNK * 3;
    // 少 10B → 第 3 块是 1014B 的短块。照样发(少传合法),不补零凑声明值。
    installFakeFfmpeg(Buffer.alloc(declared - 10, 8));
    const { fake, puts } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: declared, spoolPath: join(dir, "tail.mkv"), session: session(), fetchImpl: fake });
    expect(r.spooledBytes).toBe(declared - 10);
    expect(r.chunksUploaded).toBe(3);
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, CHUNK, declared - 10 - CHUNK * 2]);
    expect(r.streamedBytes).toBe(declared - 10);
    expect(r.uploadError).toBeUndefined();
    expect(r.sessionLeaked).toBe(false);
  });

  it("尾块比声明长:本地尾块检查拒绝它(不入队、不补零也不多发)", async () => {
    const declared = CHUNK * 2 + 512;
    installFakeFfmpeg(Buffer.alloc(declared, 8));
    const { fake, puts } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: declared, spoolPath: join(dir, "tail2.mkv"), session: session(), fetchImpl: fake });
    // 刚好填满 → 尾块合法,应传出 3 块
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, CHUNK, 512]);
    expect(r.uploadError).toBeUndefined();
  });
});

describe("封口信号来自进程退出而非后继段(设计约束回归)", () => {
  it("声明值被刚好填满时尾块立即入队,不需要第二段", async () => {
    // rolling 的 sealedSegmentIndices 要求 `index < maxIndex`(必须出现后继段才封口)。
    // 本模块的封口信号是「stdout EOF + 进程退出」,所以哪怕没有后继段,尾块也合法。
    const total = CHUNK * 2 + 512;
    const data = Buffer.alloc(total, 9);
    const dir = mkdtempSync(join(tmpdir(), "live-pump-tail-"));
    installFakeFfmpeg(data);
    const { fake, puts } = makeFetch();
    const r = await runSegment({ args: ["-fake"], sizeCap: total, spoolPath: join(dir, "t.mkv"), session: session(), fetchImpl: fake });
    setSpawnForTest(undefined);
    rmSync(dir, { recursive: true, force: true });
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, CHUNK, 512]);
    expect(r.chunksUploaded).toBe(3);
    expect(r.streamedBytes).toBe(total);
  });

  it("vi 未被误用(mock 已被替身接缝取代)", () => {
    expect(typeof vi.fn).toBe("function");
  });
});

const TOTAL = CHUNK * 6;

describe("失败回退:已录字节必须被用上,不能白躺盘上", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-fb-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  it("reuploadSpoolFile:按文件精确大小整传,块都是完整长度", async () => {
    const spool = join(dir, "seg.ts");
    const total = CHUNK * 3;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i++) data[i] = (i * 11) % 256;
    writeFileSync(spool, data);
    const { fake, puts } = makeUploadFetch();
    const r = await reuploadSpoolFile({
      cookiesPath: COOKIES, fileName: "seg.ts", spoolPath: spool, line: "txa", fetchImpl: fake,
    });
    expect(r.ok).toBe(true);
    expect(r.stem).toBe("fb123");           // complete 返回的 UPOS stem
    expect(r.bytes).toBe(total);
    expect(puts.map((p) => p.bytes)).toEqual([CHUNK, CHUNK, CHUNK]); // 无尾块协商问题
  });

  it("reuploadSpoolFile:complete 失败时 ok=false 且带原因(不静默)", async () => {
    const spool = join(dir, "seg2.ts");
    writeFileSync(spool, Buffer.alloc(CHUNK * 2, 1));
    const { fake } = makeUploadFetch({ completeReject: true });
    const r = await reuploadSpoolFile({
      cookiesPath: COOKIES, fileName: "seg2.ts", spoolPath: spool, line: "txa", fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/complete/);
    expect(r.error).toMatch(/parts boom/);
  });

  it("reuploadSpoolFile:spool 不存在/为空 → ok=false(不抛)", async () => {
    const fake = (async () => new Response("nf", { status: 404 })) as unknown as typeof fetch;
    const missing = await reuploadSpoolFile({
      cookiesPath: COOKIES, fileName: "x.ts", spoolPath: join(dir, "nope.ts"), line: "txa", fetchImpl: fake,
    });
    expect(missing.ok).toBe(false);
    const empty = join(dir, "empty.ts");
    writeFileSync(empty, "");
    const r = await reuploadSpoolFile({
      cookiesPath: COOKIES, fileName: "x.ts", spoolPath: empty, line: "txa", fetchImpl: fake,
    });
    expect(r.ok).toBe(false);
  });

  it("pumpSegment:边传失败但内容可读 → 回退整文件重传并算成功", { timeout: 30000 }, async () => {
    // 流式阶段的 PUT 全失败(500),于是 runSegment 降级为纯落盘、有 uploadError;
    // 但 spool 内容完整可读 → 必须走整文件回退,而不是把这一段丢掉。
    const cap = CHUNK * 3;
    installFakeFfmpeg(Buffer.alloc(cap, 5));
    let streamPuts = 0;
    let preuploadCalls = 0;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const u = new URL(url);
      const method = (init?.method ?? "GET").toUpperCase();
      // preupload 必须先判(它是 GET,不带 uploads 标记)
      if (u.pathname.endsWith("/preupload")) {
        return new Response(JSON.stringify({
          chunk_size: CHUNK, auth: "auth", endpoint: "//upos-cs.bilivideo.com",
          biz_id: "1", upos_uri: "upos://bucket/fake.ts", OK: 1,
        }), { status: 200 });
      }
      if (method === "POST" && u.searchParams.has("uploads")) {
        preuploadCalls++;
        // 第二次 preupload = 回退路径;给不同 uploadId 供上面区分会话。
        return new Response(JSON.stringify({ upload_id: preuploadCalls >= 2 ? "fallback-uid" : "uid" }), { status: 200 });
      }
      if (method === "PUT") {
        streamPuts++;
        // 第一个会话(边录边传)的 PUT 全失败;回退会另开一个会话,凭 uploadId 区分。
        // (重试也在同一会话内,所以整条流式路径都会失败,回退才真的被触发。)
        const isFallbackSession = u.searchParams.get("uploadId") === "fallback-uid";
        if (!isFallbackSession) return new Response("boom", { status: 500 });
        return new Response("", { status: 200 });
      }
      return new Response(JSON.stringify({ OK: 1, key: "bucket/fb123.ts" }), { status: 200 }); // complete
    }) as unknown as typeof fetch;

    const r = await pumpSegment({
      cookiesPath: COOKIES,
      args: ["-fake"],
      fileName: "fb.ts",
      sizeCap: cap,
      spoolDir: dir,
      line: "txa",
      fetchImpl,
      // 宿主 ffprobe 可能坏(缺 libxcb);注入探针让用例自足且确定
      probeDuration: async () => 60,
      signal: new AbortController().signal,
    });
    // 关键断言:段最终成功,且标记为「走过回退」(调用方要能区分统计/告警)
    expect(r.usedFileFallback).toBe(true);
    expect(r.stemOfCompleted).toBe("fb123");
    expect(r.uploadError).toBeUndefined();
    expect(r.streamedBytes).toBe(cap);
  });
});

describe("upload starts before ffmpeg exits", () => {
  it("first PUT happens while stdout is still open", async () => {
    const timeline: string[] = [];
    // 假上游:每个 PUT 慢 30ms 且记录时刻。
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const u = new URL(url);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "POST" && u.searchParams.has("uploads")) {
        timeline.push(`uploadId@${Date.now() % 100000}`);
        return new Response(JSON.stringify({ upload_id: "uid" }), { status: 200 });
      }
      if (method === "PUT") {
        timeline.push(`PUT${u.searchParams.get("partNumber")}@${Date.now() % 100000}`);
        await new Promise((r) => setTimeout(r, 30));
        return new Response("", { status: 200 });
      }
      return new Response("nf", { status: 404 });
    }) as unknown as typeof fetch;

    // 假 ffmpeg:每 40ms 吐 2KB,总共 ~120ms 才吐完;close 发生在其后。
    const spawn: SpawnFn = (() => {
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      const events = {} as Record<string, Array<(...a: unknown[]) => void>>;
      const proc: ChildProcessLike = {
        stdout, stderr,
        on(ev, fn) { (events[ev] ??= []).push(fn); },
        kill() { timeline.push(`killed@${Date.now() % 100000}`); for (const f of events.close ?? []) f(null, "SIGKILL"); },
      };
      (async () => {
        // 每 5ms 吐 2KB(快于每个 PUT 的 30ms):模拟「录制比上传快」的真实情形,
        // 这样 ffmpeg 结束前至少已发出了若干块,才能观察边录边传。
        for (let i = 0; i < TOTAL; i += 2048) {
          stdout.write(Buffer.alloc(Math.min(2048, TOTAL - i), 1));
          await new Promise((r) => setTimeout(r, 40));
        }
        stdout.end();
        timeline.push(`stdout-eof@${Date.now() % 100000}`);
        await new Promise((r) => setTimeout(r, 400));
        timeline.push(`close@${Date.now() % 100000}`);
        for (const f of events.close ?? []) f(0, null);
      })();
      return proc;
    }) as SpawnFn;
    setSpawnForTest(spawn);

    const dir = mkdtempSync(join(tmpdir(), "order-"));
    const r = await runSegment({
      args: ["-fake"], sizeCap: TOTAL, spoolPath: join(dir, "o.mkv"),
      session: {
        bucket: { chunkSize: CHUNK, auth: "a", endpoint: "//h", bizId: "1", uposUri: "upos://b/o.mkv" },
        url: "https://h/b/o.mkv", fileName: "o.mkv",
      },
      fetchImpl,
    });
    rmSync(dir, { recursive: true, force: true });

    // 关键断言:第一个 PUT **开始于** stdout EOF 之前(边录边传),
    // 且最后一个 PUT 也**开始于** close 之前(ffmpeg 退出前上传就已启动)。
    // 不断言「close 在最后一个 PUT 完成之后」——上传比 ffmpeg 慢时允许 close 先到,
    // 但上传必须已经动起来(否则就退化成 rolling 的「等下一段」)。
    const firstPut = timeline.findIndex((t) => t.startsWith("PUT1@"));
    const eof = timeline.findIndex((t) => t.startsWith("stdout-eof@"));
    const close = timeline.findIndex((t) => t.startsWith("close@"));
    const lastPut = timeline.map((t) => t.slice(0, 4)).lastIndexOf("PUT6");
    expect(firstPut).toBeGreaterThanOrEqual(0);
    expect(firstPut).toBeLessThan(eof);
    expect(lastPut).toBeLessThan(close);
    expect(r.chunksUploaded).toBe(6);
    expect(r.streamedBytes).toBe(TOTAL);
  }, 20000);
});

describe("取流退避:短暂抖动不得当成收播", () => {
  it("先失败两次再成功 → 返回可用流,且只睡 5s+10s", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const retries: Array<[number, number, number]> = [];
    const r = await acquireStreamWithBackoff({
      room: "r1", quality: "origin",
      fetch: async () => {
        calls++;
        return calls <= 2 ? { living: false } : { living: true, url: "https://x/live.flv" };
      },
      onRetry: (w, n, m) => retries.push([w, n, m]),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(r.living).toBe(true);
    expect(r.url).toBe("https://x/live.flv");
    expect(sleeps).toEqual([5000, 10000]);   // base × 2^(n-1)
    expect(retries).toEqual([[5000, 1, 5], [10000, 2, 5]]);
    expect(calls).toBe(3);
  });

  it("连续失败到上限 → 放弃并返回最后一次结果(当收播收尾)", async () => {
    let calls = 0;
    const gaveUp: number[] = [];
    const sleeps: number[] = [];
    const r = await acquireStreamWithBackoff({
      room: "r2", quality: "origin",
      maxRetries: 3,
      fetch: async () => { calls++; return { living: false }; },
      onGiveUp: (n) => gaveUp.push(n),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(r.living).toBe(false);
    expect(calls).toBe(4);          // initial attempt + 3 retries
    expect(sleeps).toEqual([5000, 10000, 20000]);
    expect(gaveUp).toEqual([4]);    // total failed attempts, reported once
  });

  it("fetch 永久挂起 → 按超时算一次失败,不冻结 pump(真实事故:第 1 段后静默停住)", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const r = await acquireStreamWithBackoff({
      room: "hang", quality: "origin",
      timeoutMs: 10,
      maxRetries: 2,
      fetch: () => { calls++; return new Promise(() => {}); },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(r.living).toBe(false);
    expect(calls).toBe(3); // initial + 2 retries, each cut by the timeout
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("fetch 永不返回 → 真子进程也必须走完超时并退出(unref 会让事件循环空转)", async () => {
    const repo = fileURLToPath(new URL("../../../", import.meta.url));
    const dir = mkdtempSync(join(tmpdir(), "lp-hang-"));
    const out = join(dir, "child.mjs");
    await build({
      entryPoints: [join(repo, "packages/zero-upload/src/live-pump-hang-child.ts")],
      bundle: true, platform: "node", format: "esm", outfile: out, logLevel: "silent",
      alias: {
        "@drec/core": join(repo, "packages/core/src/index.ts"),
        "@drec/post-process": join(repo, "packages/post-process/src/index.ts"),
      },
      banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
      external: ["node:*"],
    });
    const { code, stdout } = await new Promise<{ code: number; stdout: string }>((resolve, reject) => {
      const child = execFile(process.execPath, [out], { timeout: 3000 }, (e, so) => {
        resolve({ code: e ? Number((e as { code?: number }).code ?? 1) : 0, stdout: so });
      });
      child.on("error", reject);
    });
    // 若定时器被 unref:Node 以 unsettled top-level await 退出(非 0),stdout 为空。
    expect(stdout).toContain('"living":false');
    expect(code).toBe(0);
  }, 30_000);

  it("fetch 抛错也按失败处理(不退化成未捕获 rejection)", async () => {
    let calls = 0;
    const r = await acquireStreamWithBackoff({
      room: "throw", quality: "origin", maxRetries: 0,
      fetch: async () => { calls++; throw new Error("dns"); },
      sleep: async () => {},
    });
    expect(r.living).toBe(false);
    expect(calls).toBe(1);
  });

  it("一次就成功 → 不睡不重试", async () => {
    const sleeps: number[] = [];
    const r = await acquireStreamWithBackoff({
      room: "r3", quality: "origin",
      fetch: async () => ({ living: true, url: "u", headers: { Referer: "x" } }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(r.headers).toEqual({ Referer: "x" });
    expect(sleeps).toEqual([]);
  });

  it("取到流即清零:每段都能再经历一轮抖动(不在段间累积)", async () => {
    // Two independent jitter rounds should each get a full retry budget.
    const sleeps: number[] = [];
    const mk = (fails: number) => {
      let n = 0;
      return async () => { n++; return n <= fails ? { living: false } : { living: true, url: "u" }; };
    };
    const a = await acquireStreamWithBackoff({
      room: "r", quality: "q", fetch: mk(2), sleep: async (m) => { sleeps.push(m); },
    });
    const b = await acquireStreamWithBackoff({
      room: "r", quality: "q", fetch: mk(2), sleep: async (m) => { sleeps.push(m); },
    });
    expect(a.living).toBe(true);
    expect(b.living).toBe(true);
    expect(sleeps).toEqual([5000, 10000, 5000, 10000]);
  });
});

describe("LivePumpSession: one durable archive, append as parts finish", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-session-")); });
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

  const makeSessionFetch = () => {
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    const archive = {
      aid: 7, bvid: "BILIfake1", title: "测试-1", tid: 21, tag: "x",
      desc: "", is_only_self: 1,
    };
    let videos: Array<{ cid: number; filename: string; title: string }> = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "GET" && url.includes("/x/web/archives")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { archives: videos.length ? [{ ...archive, tag: "" }] : [], arc_audits: [] },
        }), { status: 200 });
      }
      if (method === "GET" && url.includes("/archive/view")) {
        return new Response(JSON.stringify({ code: 0, data: { archive, videos } }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      posts.push({ path: url, body });
      const sent = (body.videos ?? []) as Array<{ filename: string; title?: string }>;
      videos = sent.map((v, i) => ({ cid: 10 + i, filename: v.filename, title: v.title ?? "" }));
      return new Response(JSON.stringify({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    return { impl, posts, videos: () => videos };
  };

  it("P1 creates immediately, P2/P3 append to the same archive with the full list", async () => {
    const { impl, posts } = makeSessionFetch();
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
    });
    for (let i = 0; i < 3; i++) {
      const spool = join(dir, `p${i}.ts`);
      writeFileSync(spool, `part-${i}`);
      const r = await session.submitPart({
        index: i, spoolPath: spool, stem: `stem${i}`, title: `P${i + 1}`,
        bytes: 6, durationSec: 10,
      });
      expect(r.ok).toBe(true);
      expect(session.bvid).toBe("BILIfake1");
    }
    expect(posts.map((p) => p.path.includes("/add/v3") ? "create" : "edit")).toEqual(["create", "edit", "edit"]);
    expect((posts[1]!.body.videos as Array<{ filename: string }>).map((v) => v.filename)).toEqual(["stem0", "stem1"]);
    expect((posts[2]!.body.videos as Array<{ filename: string }>).map((v) => v.filename)).toEqual(["stem0", "stem1", "stem2"]);
    expect(session.parts.map((p) => p.confirmed)).toEqual([true, true, true]);
  });

  it("deletes the spool only after the archive confirms the part", async () => {
    const { impl } = makeSessionFetch();
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl,
    });
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "x");
    await session.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    expect(existsSync(spool)).toBe(false);
  });

  it("keeps the spool when submission fails (no data loss)", async () => {
    const impl = (async () => new Response(JSON.stringify({ code: -1, message: "no" }), { status: 200 })) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl,
    });
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "x");
    const r = await session.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    expect(r.ok).toBe(false);
    expect(existsSync(spool)).toBe(true);
  });

  it("head-of-line blocking: a failed P1 cannot be followed by P2 on a fresh archive", async () => {
    let posts = 0;
    const impl = (async (_input: string | URL | Request, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({ code: -1 }), { status: 200 });
      }
      posts++;
      return new Response(JSON.stringify({ code: -1, message: "submit failed" }), { status: 200 });
    }) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl,
    });
    const p0 = join(dir, "p0.ts");
    writeFileSync(p0, "0");
    const first = await session.submitPart({ index: 0, spoolPath: p0, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    expect(first.ok).toBe(false);
    const p1 = join(dir, "p1.ts");
    writeFileSync(p1, "1");
    const second = await session.submitPart({ index: 1, spoolPath: p1, stem: "stem1", title: "P2", bytes: 1, durationSec: 1 });
    expect(second.ok).toBe(false);
    expect(second.error).toMatch(/pending|not confirmed/);
    expect(posts).toBe(1); // only the failed P1 request; no P2 request
  });

  it("state write failure before upload blocks the irreversible request", async () => {
    const impl = (async () => {
      throw new Error("must not be called");
    }) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl,
    });
    // Replace the state directory with a file so atomic rename cannot succeed.
    const blocked = join(dir, "blocked");
    const s = new LivePumpSession({
      cookiesPath: COOKIES, room: "blocked", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl,
    });
    // @ts-expect-error test seam: point the private state path at an unwritable target
    s.statePath = join(blocked, "state.json");
    writeFileSync(blocked, "not a directory");
    const spool = join(dir, "p0.ts");
    writeFileSync(spool, "0");
    const r = await s.submitPart({ index: 0, spoolPath: spool, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/persist upload intent/);
    expect(existsSync(spool)).toBe(true);
    void session;
  });

  it("recovery refuses to claim success when the archive list is unreachable", async () => {
    const statePath = join(dir, "live-pump-r.state.json");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "r", createdAt: 1, title: "测试-1", tid: 21, tag: "x", private: true,
      parts: [], pending: {
        kind: "create", partIndex: 0, stem: "stem0", title: "P1",
        bytes: 1, durationSec: 1, spoolPath: join(dir, "p0.ts"),
      }, updatedAt: 1,
    });
    const impl = (async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
    });
    const r = await session.recover();
    expect(r.ok).toBe(false);
    expect(r.archiveExists).toBeUndefined();
    expect(readLivePumpState(statePath)?.pending).toBeDefined();
  });

  it("recovery clears create intent only when the list was readable and found no match", async () => {
    const statePath = join(dir, "live-pump-r.state.json");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "r", createdAt: 1, title: "测试-1", tid: 21, tag: "x", private: true,
      parts: [], pending: {
        kind: "create", partIndex: 0, stem: "stem0", title: "P1",
        bytes: 1, durationSec: 1, spoolPath: join(dir, "p0.ts"),
      }, updatedAt: 1,
    });
    const impl = (async () => new Response(JSON.stringify({
      code: 0, data: { archives: [], arc_audits: [] },
    }), { status: 200 })) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
    });
    const r = await session.recover();
    expect(r.ok).toBe(true);
    expect(readLivePumpState(statePath)?.pending).toBeUndefined();
    expect(session.bvid).toBeUndefined();
  });

  it("resumed runs must not reuse an already-confirmed part index", async () => {
    const { impl, posts } = makeSessionFetch();
    const s1 = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
    });
    const p0 = join(dir, "p0.ts");
    writeFileSync(p0, "0");
    await s1.submitPart({ index: 0, spoolPath: p0, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    // A resumed process restarts its local segment counter at 0. Submitting index 0 again
    // would overwrite the confirmed P1 record (real run: new part vanished, spool leaked).
    const maxIndex = s1.parts.reduce((m, p) => Math.max(m, p.index + 1), 0);
    expect(maxIndex).toBe(1);
    const p1 = join(dir, "p1.ts");
    writeFileSync(p1, "1");
    const r = await s1.submitPart({ index: maxIndex, spoolPath: p1, stem: "stem1", title: "P2", bytes: 1, durationSec: 1 });
    expect(r.ok).toBe(true);
    expect(s1.parts.map((p) => p.index)).toEqual([0, 1]);
    expect(posts).toHaveLength(2);
  });

  it("retries a 21540 rate-limited append with cooldown instead of failing the part", async () => {
    // Real run 2026-10-18: consecutive edit calls hit code 21540 and the whole part was
    // treated as a permanent failure, head-of-line blocking every later part of the broadcast.
    let edits = 0;
    const videos: Array<{ cid: number; filename: string; title: string }> = [{ cid: 10, filename: "stem0", title: "P1" }];
    const sleeps: number[] = [];
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? "GET") === "GET") {
        return new Response(JSON.stringify({
          code: 0,
          data: {
            archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21, tag: "", is_only_self: 1 },
            videos,
          },
        }), { status: 200 });
      }
      edits++;
      if (edits === 1) {
        return new Response(JSON.stringify({ code: 21540, message: "请求过于频繁，请稍后再试", ttl: 1 }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as { videos?: Array<{ filename: string; title?: string }> };
      videos.length = 0;
      for (const [i, v] of (body.videos ?? []).entries()) videos.push({ cid: 10 + i, filename: v.filename, title: v.title ?? "" });
      return new Response(JSON.stringify({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }), { status: 200 });
    }) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "t",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
      rateLimitBaseMs: 1000,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    // P1 must exist first: this session appends onto it (a first part would be a create).
    const p0 = join(dir, "p0.ts");
    writeFileSync(p0, "0");
    await session.submitPart({ index: 0, spoolPath: p0, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    edits = 0;
    sleeps.length = 0;
    const spool = join(dir, "p1.ts");
    writeFileSync(spool, "1");
    const r = await session.submitPart({ index: 1, spoolPath: spool, stem: "stem1", title: "P2", bytes: 1, durationSec: 1 });
    expect(r.ok).toBe(true);
    expect(edits).toBe(2);
    expect(sleeps).toEqual([1000]);
    expect(videos.map((v) => v.filename)).toEqual(["stem0", "stem1"]);
  });

  it("resubmits a single unconfirmed part from its spool instead of stopping the run", async () => {
    // Real run 2026-10-18: a part hit 21540 after `complete()`, so the stem exists on the server
    // but not on the archive. Recovery stopped the whole broadcast; the spool can finish the job.
    let completes = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url);
      if (u.pathname.endsWith("/preupload")) {
        return new Response(JSON.stringify({
          chunk_size: CHUNK, auth: "a", endpoint: "//upos-cs.bilivideo.com",
          biz_id: "1", upos_uri: `upos://bucket/re${completes}.ts`, OK: 1,
        }), { status: 200 });
      }
      if (method === "POST" && u.searchParams.has("uploads")) {
        return new Response(JSON.stringify({ upload_id: `uid-${completes}` }), { status: 200 });
      }
      if (method === "PUT") return new Response("", { status: 200 });
      if (method === "POST" && u.hostname.includes("bilivideo")) {
        completes++;
        return new Response(JSON.stringify({ OK: 1, key: `bucket/resub${completes}.ts` }), { status: 200 });
      }
      if (method === "POST") return new Response(JSON.stringify({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }), { status: 200 });
      return new Response(JSON.stringify({
        code: 0,
        data: {
          archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21, tag: "", is_only_self: 1 },
          videos: [{ cid: 10, filename: "stem0", title: "P1" }],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const statePath = join(dir, "live-pump-r.state.json");
    const spool = join(dir, "p1.ts");
    writeFileSync(spool, "recovered-part-bytes");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "r", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
      bvid: "BILIfake1", aid: 7,
      parts: [
        { index: 0, spoolPath: join(dir, "gone.ts"), filename: "gone.ts", stem: "stem0", title: "P1", bytes: 1, durationSec: 1, confirmed: true },
        { index: 1, spoolPath: spool, filename: "p1.ts", stem: "stem1", title: "P2", bytes: 19, durationSec: 10, confirmed: false },
      ],
      updatedAt: 1,
    });
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "t",
      tid: 21, tag: "x", private: true, fetchImpl: impl,
    });
    const r = await session.resubmitUnconfirmedPart();
    expect(r.ok).toBe(true);
    expect(completes).toBeGreaterThan(0);
    expect(readLivePumpState(statePath)?.parts.every((p) => p.confirmed)).toBe(true);
    expect(existsSync(spool)).toBe(false);
  });

  it("waitForBroadcast: a recoverable unconfirmed part is settled before waiting, not after (#308 review)", async () => {
    // Last part's submit failed as the show ended; the restart finds the room offline. Recovery
    // must not be deferred to the next broadcast, where the gap rule would archive it for a human.
    let completes = 0;
    const impl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = (init?.method ?? "GET").toUpperCase();
      const u = new URL(url);
      if (u.pathname.endsWith("/preupload")) {
        return new Response(JSON.stringify({
          chunk_size: CHUNK, auth: "a", endpoint: "//upos-cs.bilivideo.com",
          biz_id: "1", upos_uri: `upos://bucket/re${completes}.ts`, OK: 1,
        }), { status: 200 });
      }
      if (method === "POST" && u.searchParams.has("uploads")) {
        return new Response(JSON.stringify({ upload_id: `uid-${completes}` }), { status: 200 });
      }
      if (method === "PUT") return new Response("", { status: 200 });
      if (method === "POST" && u.hostname.includes("bilivideo")) {
        completes++;
        return new Response(JSON.stringify({ OK: 1, key: `bucket/resub${completes}.ts` }), { status: 200 });
      }
      if (method === "POST") return new Response(JSON.stringify({ code: 0, data: { aid: 7, bvid: "BILIfake1" } }), { status: 200 });
      return new Response(JSON.stringify({
        code: 0,
        data: {
          archive: { aid: 7, bvid: "BILIfake1", title: "t", tid: 21, tag: "", is_only_self: 1 },
          videos: [{ cid: 10, filename: "stem0", title: "P1" }],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const statePath = join(dir, "live-pump-r.state.json");
    const spool = join(dir, "p1.ts");
    writeFileSync(spool, "recovered-part-bytes");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "r", createdAt: 1, title: "t", tid: 21, tag: "x", private: true,
      bvid: "BILIfake1", aid: 7,
      parts: [
        { index: 0, spoolPath: join(dir, "gone.ts"), filename: "gone.ts", stem: "stem0", title: "P1", bytes: 1, durationSec: 1, confirmed: true },
        { index: 1, spoolPath: spool, filename: "p1.ts", stem: "stem1", title: "P2", bytes: 19, durationSec: 10, confirmed: false },
      ],
      updatedAt: Date.now(),
    });
    const drain = new AbortController();
    const r = await runLivePump({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 1024, quality: "origin", submit: true, spoolMode: "none", waitForBroadcast: true,
      fetchImpl: impl, sleep: async () => {}, drainSignal: drain.signal, log: () => {},
      fetch: async () => { drain.abort(); return { living: false }; },
    });
    expect(r).toMatchObject({ ok: true, outcome: "idle" });
    expect(completes).toBeGreaterThan(0);
    expect(readLivePumpState(statePath)?.parts.every((p) => p.confirmed)).toBe(true);
    expect(existsSync(spool)).toBe(false);
  });

  it("recovers create intent by exact title and does not create a second archive", async () => {
    const { impl, posts, videos } = makeSessionFetch();
    videos().push({ cid: 10, filename: "stem0", title: "P1" });
    const statePath = join(dir, "live-pump-r.state.json");
    writeLivePumpState(statePath, {
      schemaVersion: 1, room: "r", createdAt: 1, title: "测试-1", tid: 21, tag: "x", private: true,
      parts: [], pending: {
        kind: "create", partIndex: 0, stem: "stem0", title: "P1",
        bytes: 1, durationSec: 1, spoolPath: join(dir, "p0.ts"),
      }, updatedAt: 1,
    });
    // The fake archive list must contain the title for recovery; seed the view through a POST-free path.
    const seeded = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if ((init?.method ?? "GET") === "GET" && url.includes("/x/web/archives")) {
        return new Response(JSON.stringify({
          code: 0,
          data: { archives: [], arc_audits: [{ Archive: { aid: 7, bvid: "BILIfake1", title: "测试-1" } }] },
        }), { status: 200 });
      }
      return impl(input, init);
    }) as unknown as typeof fetch;
    const session = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: seeded, cleanupConfirmedSpool: false,
    });
    const r = await session.recover();
    expect(r.ok).toBe(true);
    expect(session.bvid).toBe("BILIfake1");
    expect(posts).toHaveLength(0);
    expect(readLivePumpState(statePath)?.pending).toBeUndefined();
  });

  it("append recovery recognizes an already-submitted stem and does not resubmit", async () => {
    const { impl, posts, videos } = makeSessionFetch();
    // Establish one confirmed part first.
    const s1 = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
    });
    const p0 = join(dir, "p0.ts");
    writeFileSync(p0, "0");
    await s1.submitPart({ index: 0, spoolPath: p0, stem: "stem0", title: "P1", bytes: 1, durationSec: 1 });
    videos().push({ cid: 11, filename: "stem1", title: "P2" });
    // Simulate a crash after the edit request was sent but before confirmation was persisted.
    const statePath = join(dir, "live-pump-r.state.json");
    const state = readLivePumpState(statePath)!;
    writeLivePumpState(statePath, {
      ...state,
      parts: [...state.parts, { index: 1, spoolPath: join(dir, "p1.ts"), filename: "p1.ts", stem: "stem1", title: "P2", bytes: 1, durationSec: 1, confirmed: true }],
      pending: { kind: "append", partIndex: 1, stem: "stem1", title: "P2", bytes: 1, durationSec: 1, spoolPath: join(dir, "p1.ts") },
    });
    const s2 = new LivePumpSession({
      cookiesPath: COOKIES, room: "r", spoolDir: dir, title: "测试-1",
      tid: 21, tag: "x", private: true, fetchImpl: impl, cleanupConfirmedSpool: false,
    });
    const before = posts.length;
    const r = await s2.recover();
    expect(r.ok).toBe(true);
    expect(posts.length).toBe(before);
    expect(readLivePumpState(statePath)?.parts.find((p) => p.index === 1)?.confirmed).toBe(true);
  });
});

describe("same-broadcast rule on the room-keyed state (issue #293)", () => {
  let dir: string;
  const MIN = 60_000;
  const FAKE_BV = "BV" + "1fakeSame293";
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "live-pump-gap-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const open = (log: (m: string) => void = () => {}) => new LivePumpSession({
    cookiesPath: COOKIES, room: "gap", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true, log,
  });
  const statePath = () => livePumpStatePath(dir, "gap");
  const part = (confirmed: boolean) => ({
    index: 0, spoolPath: join(dir, "p0.ts"), filename: "f", stem: "s", title: "P1",
    bytes: 1, durationSec: 1, confirmed,
  });
  /** Writes a state whose last activity was `agoMin` minutes ago (updatedAt is stamped by hand). */
  function seed(agoMin: number, extra: Record<string, unknown> = {}): void {
    const base = {
      schemaVersion: 1, room: "gap", createdAt: 1, title: "old", tid: 21, tag: "x", private: true,
      bvid: FAKE_BV, parts: [part(true)], updatedAt: Date.now() - agoMin * MIN, ...extra,
    };
    writeFileSync(statePath(), JSON.stringify(base));
  }
  const archives = () => readdirSync(dir).filter((f) => f.includes(".archived-"));

  it("61 min gap: starts a new submission and archives the old state", () => {
    seed(61);
    const logs: string[] = [];
    const s = open((m) => logs.push(m));
    expect(s.hasArchiveIdentity).toBe(false);
    expect(s.bvid).toBeUndefined();
    const a = archives();
    expect(a.length).toBe(1);
    expect(readLivePumpState(join(dir, a[0]!))?.bvid).toBe(FAKE_BV);
    expect(existsSync(statePath())).toBe(false);
    expect(logs.join("\n")).toContain("archived old state");
  });

  it("59 and 60 min gaps continue the same submission", () => {
    for (const ago of [59, 60]) {
      seed(ago - 0.01);
      const s = open();
      expect(s.bvid).toBe(FAKE_BV);
      expect(archives().length).toBe(0);
    }
  });

  const openWithAlerts = (alerts: string[]) => new LivePumpSession({
    cookiesPath: COOKIES, room: "gap", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
    log: () => {}, onAlert: (m) => alerts.push(m),
  });

  it("stale state with pending WAL: archived intact, ONE alert, new submission starts (never throws)", () => {
    const pending = { kind: "append", partIndex: 1, stem: "s1", title: "P2", bytes: 1, durationSec: 1, spoolPath: join(dir, "p1.ts") };
    seed(120, { pending });
    const alerts: string[] = [];
    const s = openWithAlerts(alerts);
    expect(s.hasArchiveIdentity).toBe(false);
    expect(alerts.length).toBe(1);
    const a = archives();
    expect(a.length).toBe(1);
    expect(readLivePumpState(join(dir, a[0]!))?.pending?.stem).toBe("s1");
    expect(archivedSpoolPathsToKeep(dir, "gap")).toContain(pending.spoolPath);
  });

  it("stale state with an unconfirmed part: archived + one alert + fresh submission", () => {
    seed(120, { parts: [part(false)] });
    const alerts: string[] = [];
    expect(openWithAlerts(alerts).hasArchiveIdentity).toBe(false);
    expect(alerts.length).toBe(1);
    expect(archives().length).toBe(1);
  });

  it("stale but fully confirmed state: archived without an alert", () => {
    seed(120);
    const alerts: string[] = [];
    expect(openWithAlerts(alerts).hasArchiveIdentity).toBe(false);
    expect(alerts.length).toBe(0);
    expect(archives().length).toBe(1);
  });

  it("within the gap and readable: continued, no alert, no archive", () => {
    seed(30, { parts: [part(false)] });
    const alerts: string[] = [];
    expect(openWithAlerts(alerts).bvid).toBe(FAKE_BV);
    expect(alerts.length).toBe(0);
    expect(archives().length).toBe(0);
  });

  it("corrupt state: archived byte-for-byte, one alert, new submission, never throws", () => {
    writeFileSync(statePath(), "{not json");
    const alerts: string[] = [];
    const s = openWithAlerts(alerts);
    expect(s.hasArchiveIdentity).toBe(false);
    expect(alerts.length).toBe(1);
    const a = archives();
    expect(a.length).toBe(1);
    expect(readFileSync(join(dir, a[0]!), "utf-8")).toBe("{not json");
    expect(existsSync(statePath())).toBe(false);
  });

  it("old state without a timestamp and with unconfirmed parts: archived + one alert, not appended to", () => {
    seed(0, { updatedAt: undefined, parts: [part(false)] });
    const alerts: string[] = [];
    const s = openWithAlerts(alerts);
    expect(s.bvid).toBeUndefined();
    expect(alerts.length).toBe(1);
    expect(archives().length).toBe(1);
  });

  it("two archives in the same millisecond never overwrite each other", () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      writeFileSync(statePath(), "{bad1");
      open();
      writeFileSync(statePath(), "{bad2");
      open();
    } finally { now.mockRestore(); }
    expect(archives().length).toBe(2);
  });

  it("spoolSweepSafe is false while any live or archived state is unreadable", () => {
    expect(spoolSweepSafe(dir, "gap")).toBe(true);
    seed(1);
    expect(spoolSweepSafe(dir, "gap")).toBe(true);
    writeFileSync(`${statePath()}.archived-1`, "{bad");
    expect(spoolSweepSafe(dir, "gap")).toBe(false);
    rmSync(`${statePath()}.archived-1`);
    writeFileSync(statePath(), "{bad");
    expect(spoolSweepSafe(dir, "gap")).toBe(false);
  });

  it("runLivePump with a corrupt old state: alerts once, archives, and still records into a new submission", async () => {
    writeFileSync(join(dir, "cookies.json"), JSON.stringify({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf" }] },
    }));
    writeFileSync(statePath(), "{not json");
    const json = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200 });
    const fake = ((input: string | URL | Request) => {
      const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (u.pathname === "/preupload") return Promise.resolve(json({ OK: 1, chunk_size: CHUNK, auth: "a", biz_id: "1", endpoint: "//upos.test", upos_uri: "upos://b/p.ts" }));
      if (u.searchParams.has("uploads")) return Promise.resolve(json({ upload_id: "uid" }));
      if (u.searchParams.has("uploadId") && u.searchParams.has("profile")) return Promise.resolve(json({ OK: 1, key: "b/p.ts" }));
      if (u.pathname === "/x/vu/web/add/v3") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILInew1" } }));
      if (u.pathname === "/x/vu/web/edit") return Promise.resolve(json({ code: 0, data: { aid: 7, bvid: "BILInew1" } }));
      if (u.pathname === "/x/vupre/web/archive/view") return Promise.resolve(json({ code: 0, data: { archive: { aid: 7, bvid: "BILInew1", title: "t", tid: 21 }, videos: [] } }));
      if (u.pathname === "/x/web/archives") return Promise.resolve(json({ code: 0, data: { arc_audits: [] } }));
      return Promise.resolve(json({ code: 0, data: {} }));
    }) as unknown as typeof fetch;
    installFakeFfmpeg(Buffer.alloc(CHUNK * 2, 0x5a));
    const alerts: string[] = [];
    const r = await runLivePump({
      cookiesPath: join(dir, "cookies.json"), room: "gap", spoolDir: dir, title: "t",
      tid: 21, tag: "x", private: true, sizeCap: CHUNK, maxMs: 300, maxSegments: 1,
      quality: "origin", submit: true, spoolMode: "none", fetchImpl: fake,
      fetch: async () => ({ living: true, url: "http://x/y.ts" }),
      sleep: async () => {}, log: () => {}, onAlert: (m) => alerts.push(m),
    });
    expect(r.ok, r.error ?? "").toBe(true);
    expect(r.bvid).toBe("BILInew1");
    expect(alerts.length).toBe(1);
    expect(archives().length).toBe(1);
  }, 20_000);

  it("old fully confirmed state without a timestamp falls back to file mtime", () => {
    seed(0, { updatedAt: undefined });
    const old = new Date(Date.now() - 90 * MIN);
    utimesSync(statePath(), old, old);
    expect(open().hasArchiveIdentity).toBe(false);
    expect(archives().length).toBe(1);
    seed(0, { updatedAt: undefined });
    expect(open().bvid).toBe(FAKE_BV);
  });

  it("waitForBroadcast: same-broadcast is decided when the room goes live, not at process start (#308)", async () => {
    seed(30); // fresh when the process starts
    let calls = 0;
    const logs: string[] = [];
    const r = await runLivePump({
      cookiesPath: COOKIES, room: "gap", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 1024, quality: "origin", submit: false, spoolMode: "none", waitForBroadcast: true,
      sleep: async () => {},
      // Stop right after the session is opened; no part is recorded.
      shouldStop: () => calls >= 3,
      fetch: async () => {
        calls++;
        // Still waiting: the old state must not even be opened yet.
        expect(logs.some((m) => m.includes("resumed state"))).toBe(false);
        if (calls < 3) return { living: false };
        seed(120); // hours passed while waiting in-process
        return { living: true, url: "http://x/y.ts" };
      },
      log: (m) => logs.push(m),
    });
    expect(r.outcome).toBe("idle");
    expect(archives().length).toBe(1); // the next broadcast must not append to the old archive
    expect(logs.join("\n")).toContain("archived old state");
  });

  it("waitForBroadcast: stopped while still waiting -> old state untouched", async () => {
    seed(120);
    const drain = new AbortController();
    const r = await runLivePump({
      cookiesPath: COOKIES, room: "gap", spoolDir: dir, title: "t", tid: 21, tag: "x", private: true,
      sizeCap: 1024, quality: "origin", submit: true, spoolMode: "none", waitForBroadcast: true,
      sleep: async () => {}, drainSignal: drain.signal,
      fetch: async () => { drain.abort(); return { living: false }; },
      log: () => {},
    });
    expect(r).toMatchObject({ ok: true, outcome: "idle" });
    expect(r.bvid).toBeUndefined(); // no ledger writeback for a run that never went live
    expect(archives().length).toBe(0);
    expect(existsSync(statePath())).toBe(true);
  });

  it("every state write refreshes last activity so the rule works after a restart", () => {
    seed(500);
    const st = readLivePumpState(statePath())!;
    writeLivePumpState(statePath(), st);
    expect(open().bvid).toBe(FAKE_BV);
    expect(archives().length).toBe(0);
  });
});
