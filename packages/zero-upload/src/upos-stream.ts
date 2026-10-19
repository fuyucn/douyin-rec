/**
 * upos-stream.ts — UPOS 流式上传(preupload → 分块 PUT → complete) + 稿件提交。
 *
 * 自研 UPOS 直传(0 落盘路径的实现核心):不经过 biliup CLI,直接对 UPOS 预声明 + 分块
 * PUT + complete + 稿件建/追。既服务隐藏命令 `_live-pump`,也服务生产任务开关
 * (`record --stream-upload`,见任务字段 streamUpload)。进程内整文件上传(runBiliup)是另一条
 * 路,与本模块互斥。
 *
 * 协议事实(B 站 UPOS,均已对真实接口实测):
 *  1. preupload 必须带 `size`(分 P 预期总字节数)—— chunk 数、start/end 全靠它算;
 *  2. chunk 数 = ceil(total / chunk_size),每块参数带 upload/partNumber/total/size/start/end;
 *  3. complete 时 parts 必须连续(1..N),服务端校验;
 *  4. `size` 只是**声明值**:可以先申请再分块喂数据,不要求文件已存在 —— 这就是「不落盘」的立足点;
 *  5. complete 响应的 `key` 才是服务端分配的内部文件名;建稿时 `videos[].filename` 必须填它的
 *     stem。填 cid 或我们 preupload 时用的 name 都会被拒(实测 code 21015)。
 *
 * 为什么是独立包(@drec/zero-upload):只依赖 core + post-process 两个 L0 叶子。这样
 * record-engine/manager/orchestrator 不可能通过依赖图碰到它,"动 0 落盘不影响录制主干"
 * 由分层保证而不是靠人记得。processors 只 re-export 它(保持旧导入点),不反向依赖。
 */
import { existsSync, readFileSync } from "node:fs";
import { biliupCookieHeader } from "@drec/core";

/**
 * Read biliup cookies.json into a Cookie header, or null when the file is missing/unreadable.
 * Local to this package: depending on @drec/processors for it would invert the layer
 * (processors re-exports this package), and a silent null would just fail every upload.
 */
function readBiliupCookieHeader(cookiesPath: string): string | null {
  try {
    return biliupCookieHeader(JSON.parse(readFileSync(cookiesPath, "utf-8")));
  } catch {
    return null;
  }
}

/** 解析后的 bucket(内部 camelCase;wire 上是 snake_case,见 RawUposBucket)。 */
export interface UposBucket {
  chunkSize: number;
  auth: string;
  endpoint: string;
  bizId: string;
  uposUri: string;
}

/** preupload 响应的**原始**形状(B 站字段名是 snake_case)。 */
interface RawUposBucket {
  chunk_size?: number;
  auth?: string;
  endpoint?: string;
  biz_id?: string | number;
  upos_uri?: string;
  OK?: number;
  /** 限流(601)时才有:HTTP 406 + 这个 code。 */
  code?: number;
  message?: string;
}

export interface PreuploadResult {
  bucket: UposBucket;
  /** 分块 PUT / complete 用的完整 URL(https 开头)。 */
  url: string;
  fileName: string;
}

export interface PreuploadOptions {
  /** biliup cookies.json 路径。 */
  cookiesPath: string;
  /** 分 P 文件名;complete 时原样回传。 */
  fileName: string;
  /** **预声明**的分 P 总字节数。协议要求:未知长度无法上传。 */
  totalSize: number;
  /** 线路(upcdn),默认 txa。 */
  line?: string;
  /** 覆盖 preupload 主机(测试注入)。 */
  preuploadBase?: string;
  /** 覆盖 fetch(测试注入)。 */
  fetchImpl?: typeof fetch;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

/**
 * B 站限流:preupload 会以 HTTP 406 + `{"code":601,"message":"您上传视频过快…"}`
 * 拒绝新分 P(实测)。**只发生在 preupload**(建新上传会话),不在 chunk PUT 上。
 * 这不是失败,是「退后一点再来」——所以单独一个类,调用方能区分「限流」和「真错」。
 */
export class UposRateLimited extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super("B 站上传限流(601 上传过快,需冷却后重试)");
    this.name = "UposRateLimited";
  }
}

function isRateLimitedBody(j: { code?: unknown }): boolean {
  return Number(j.code) === 601;
}

/**
 * 申请一个 UPOS 上传会话。
 *
 * `size` 是**预声明**值:此刻不需要有任何字节存在。这就是「不落盘也能传」的关键 ——
 * 协议要的是一个数字,不是一个文件。
 */
export async function preupload(o: PreuploadOptions): Promise<PreuploadResult> {
  const cookie = readBiliupCookieHeader(o.cookiesPath);
  if (!cookie) throw new Error(`无法从 cookies 解析登录态: ${o.cookiesPath}`);
  const doFetch = o.fetchImpl ?? fetch;
  const base = o.preuploadBase ?? "https://member.bilibili.com";
  const query = new URLSearchParams({
    r: "upos",
    profile: "ugcupos/bup",
    ssl: "0",
    version: "2.14.0",
    build: "2140000",
    name: o.fileName,
    size: String(o.totalSize),
    upcdn: o.line ?? "txa",
  });
  const res = await doFetch(`${base}/preupload?${query.toString()}`, {
    headers: { "User-Agent": UA, Referer: "https://member.bilibili.com/", Cookie: cookie },
  });
  const j = (await res.json()) as RawUposBucket;
  if (isRateLimitedBody(j)) throw new UposRateLimited(j as Record<string, unknown>);
  if (!j.chunk_size || !j.auth || !j.endpoint || !j.upos_uri) {
    throw new Error(`preupload 返回缺少字段: ${JSON.stringify(j).slice(-500)}`);
  }
  if (Number(j.OK) !== 1) throw new Error(`preupload 被拒绝: ${JSON.stringify(j).slice(-500)}`);
  return {
    bucket: {
      chunkSize: Number(j.chunk_size),
      auth: String(j.auth),
      endpoint: String(j.endpoint),
      bizId: String(j.biz_id ?? ""),
      uposUri: String(j.upos_uri),
    },
    // endpoint 形如 `//upos-cs-upcdnbda2.bilivideo.com`(B 站实返回**带前导 //**,不含 scheme);
    // upos_uri 形如 `upos://bucket/x.mkv`(带 scheme 前缀)。
    // 上游 Rust: `format!("https:{}/{}", endpoint, uri.replace("upos://",""))`
    //      = `https:` + `//host` + `/` + `bucket/x.mkv`。
    // 这里不依赖 endpoint 是否带前导斜杠 —— 去掉首尾多余的 `/` 后显式拼,
    // 否则 `https:` + `upos-x` 会拼出 `https:upos-x`(被当成相对 URL)。
    url: `https://${String(j.endpoint).replace(/^\/+/, "").replace(/\/+$/, "")}/${String(j.upos_uri).replace(/^upos:\/\//, "").replace(/^\/+/, "")}`,
    fileName: o.fileName,
  };
}

export interface UploadChunkProgress {
  uploadedBytes: number;
  chunksDone: number;
}

export interface UposPart {
  partNumber: number;
  eTag: string;
}

export interface UploadOptions {
  session: PreuploadResult;
  /** 分块总大小(与 preupload 的 totalSize 一致)。 */
  totalSize: number;
  /**
   * 取第 i 块的数据。**由调用方决定字节从哪来** —— 这正是 PoC 的核心:
   * 可来自内存缓冲(不落盘),也可来自文件(兼容现有路径)。
   * 每块除最后一块外必须是 chunkSize 字节。
   */
  readChunk: (index: number, size: number) => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
  retries?: number;
  onProgress?: (p: UploadChunkProgress) => void;
  signal?: AbortSignal;
  /**
   * 实时求值的真实总量(默认 = `totalSize`)。
   *
   * 「时长先到就结算」需要它:`totalSize` 仍是 preupload 声明的上界,但真正要传的只有
   * 已入队的满块 + 一个**更短的尾块**。`uploadChunks` 用它算每块的 `size`,写到最后一个
   * part 时 `size` 自然收敛到尾块长度,而不是永远按满块算。
   */
  totalSizeOf?: () => number;
  /**
   * 实际最多传几个块(默认 = ceil(totalSize / chunk_size))。
   *
   * 用于「时长先到就结算」:`totalSize` 仍是 preupload 声明的上界,但只传出前 N 个连续块。
   * 实测 UPOS 接受少传(`complete` 只要求 parts 连续 1..N),所以这是合法收尾而非错误。
   *
   * 传**函数**则每轮实时求值 —— 用于「时长到点才知道传几块」:到点前返回 Infinity,
   * 到点后返回已入队的块数,上传侧即干净收尾而不报「流太短」。**缺块仍算错误**。
   */
  maxChunks?: number | (() => number);
}

/**
 * 建稿 / 追 P 的第 4 步(直传)。
 *
 * 接口:`POST member.bilibili.com/x/vu/web/add/v3?t=<ms>&csrf=<bili_jct>`,body 为稿件 JSON。
 * 追 P 用 `POST .../x/vu/web/edit?t=&csrf=`,body 带 aid。
 *
 * 硬常量(与 `buildUploadArgs` / `buildAppendArgs` 逐字对齐,**漏一条就是不可逆事故**):
 *  - `copyright: 1`  自制
 *  - `watermark.state = 0`  关昵称水印
 *  - `is_only_self = 1`  仅自己可见(private)
 *  - 走 web 接口(add/v3、edit)而非 app 接口 —— app 更易触发 21566
 */
export interface StudioInput {
  cookiesPath: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  /** 仅自己可见(默认 true = private)。 |
   * ⚠️ 本项目默认 private:**公开是不可逆的曝光**,不得因图省事传 false。 */
  private?: boolean;
  /**
   * Each part: `filename` must be the UPOS stem from `complete()` (B站服务端内部名),
   * neither our pre-upload name nor cid.
   */
  videos: Array<{ cid?: string; filename: string; title?: string; desc?: string }>;
  /** 追 P 时传已有 aid;建稿留空。 */
  aid?: number;
  fetchImpl?: typeof fetch;
}

/** One part on an existing archive, as returned by the member archive endpoint. */
export interface StudioVideo {
  cid?: string | number;
  filename: string;
  title?: string;
  desc?: string;
}

/** Existing archive state needed to append a part without dropping earlier parts. */
export interface StudioArchive {
  aid: number;
  bvid?: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  private: boolean;
  videos: StudioVideo[];
}

/**
 * Any UPOS path/URI -> the stem Studio needs. Handles all three real shapes:
 *   `upos://bucket/name.ts`, `bucket/name.ts` (complete's `key`), `name.ts`.
 * Strips the URL scheme, then every leading directory, then the extension.
 */
function uposStem(rawPath: string): string {
  const raw = decodeURIComponent(rawPath.replace(/^upos:\/\//, ""));
  const base = raw.split("/").pop() ?? raw;
  return base.replace(/\.[^.]+$/, "");
}

export interface SubmitResult {
  ok: boolean;
  /** 建稿成功时的 aid。 */
  aid?: number;
  /** 稿件标识(上游返回 data.bvid,可能是空串)。 |
   * ⚠️ 解析不到 bvid 时**不得**当失败重试(服务端可能已建稿)——转人工核对。 */
  bvid?: string;
  raw: Record<string, unknown>;
}

export interface LookupArchiveResult {
  ok: boolean;
  archive?: StudioArchive;
  raw: Record<string, unknown>;
}

export interface FindArchiveResult {
  ok: boolean;
  archive?: StudioArchive;
  /** Number of exact title matches; >1 is ambiguous and must not be guessed. */
  matches: number;
  /** At least one list page was read successfully. Distinguishes "no match" from "unknown". */
  searched?: boolean;
  raw: Record<string, unknown>;
}

/** 从已解析的 biliup cookies.json 取 csrf(bili_jct)。 */
function csrfOf(data: unknown): string {
  const root = data as { cookie_info?: { cookies?: unknown }; cookies?: unknown } | null;
  const raw = root?.cookie_info?.cookies ?? root?.cookies ?? data;
  if (!Array.isArray(raw)) throw new Error("cookies 解析不到 cookie 列表,无法提交(登录态不完整)");
  const jct = raw
    .map((c) => c as { name?: unknown; value?: unknown })
    .find((c) => c?.name === "bili_jct")?.value;
  if (typeof jct !== "string" || !jct) throw new Error("cookies 里没有 bili_jct,无法提交(登录态不完整)");
  return jct;
}

function cookieHeaderOrThrow(cookiesPath: string): string {
  const cookie = readBiliupCookieHeader(cookiesPath);
  if (!cookie) throw new Error(`无法从 cookies 解析登录态: ${cookiesPath}`);
  return cookie;
}

function archiveFromViewData(data: unknown): StudioArchive | null {
  const root = data as {
    archive?: Record<string, unknown>;
    videos?: Array<Record<string, unknown>>;
  } | null;
  const a = root?.archive;
  if (!a) return null;
  const aid = Number(a.aid);
  const title = String(a.title ?? "").trim();
  const tid = Number(a.tid);
  if (!(aid > 0) || !title || !(tid > 0)) return null;
  const videos: StudioVideo[] = [];
  for (const v of root.videos ?? []) {
    const filename = String(v.filename ?? "").trim();
    if (!filename) continue;
    const cid = Number(v.cid);
    videos.push({
      ...(cid > 0 ? { cid } : {}),
      filename,
      ...(typeof v.title === "string" && v.title ? { title: v.title } : {}),
      ...(typeof v.desc === "string" && v.desc ? { desc: v.desc } : {}),
    });
  }
  const tag = String(a.tag ?? "").trim();
  const desc = typeof a.desc === "string" ? a.desc : undefined;
  return {
    aid,
    ...(typeof a.bvid === "string" && a.bvid ? { bvid: a.bvid } : {}),
    title,
    tid,
    tag,
    ...(desc ? { desc } : {}),
    private: Number(a.is_only_self ?? 0) !== 0,
    videos,
  };
}

/**
 * Read an archive, including private/auditing ones, with the uploader's login state.
 *
 * The public view endpoint returns -404 for private drafts, so append recovery must use
 * the member endpoint. The vupre shape is the one the web editor uses; fall back to the
 * client shape only when the first endpoint is unavailable.
 */
export async function lookupArchive(o: {
  cookiesPath: string;
  bvid?: string;
  aid?: number;
  fetchImpl?: typeof fetch;
}): Promise<LookupArchiveResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const cookie = cookieHeaderOrThrow(o.cookiesPath);
  const vid = o.aid && o.aid > 0 ? `aid=${o.aid}` : o.bvid ? `bvid=${encodeURIComponent(o.bvid)}` : "";
  if (!vid) throw new Error("lookupArchive 需要 bvid 或 aid");
  const endpoints = [
    `https://member.bilibili.com/x/vupre/web/archive/view?${vid}`,
    `https://member.bilibili.com/x/client/archive/view?${vid}`,
  ];
  let lastRaw: Record<string, unknown> = {};
  let transportFailures = 0;
  for (const url of endpoints) {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://member.bilibili.com/" },
      });
    } catch {
      transportFailures++;
      continue;
    }
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    lastRaw = raw;
    if (res.ok && raw.code === 0) {
      const archive = archiveFromViewData(raw.data);
      if (archive) return { ok: true, archive, raw };
    }
  }
  if (transportFailures === endpoints.length) {
    return { ok: false, raw: { error: "archive view transport failed" } };
  }
  return { ok: false, raw: lastRaw };
}

interface ArchiveSummary {
  aid: number;
  bvid?: string;
  title: string;
}

function archiveSummaries(data: unknown): ArchiveSummary[] {
  const out: ArchiveSummary[] = [];
  for (const row of archiveSummaryRows(data)) {
    const aid = Number(row.aid);
    const title = String(row.title ?? "").trim();
    if (!(aid > 0) || !title) continue;
    out.push({
      aid,
      ...(typeof row.bvid === "string" && row.bvid ? { bvid: row.bvid } : {}),
      title,
    });
  }
  return out;
}

/**
 * Bilibili list responses have two real shapes:
 *   - archived rows: `archives: [{ aid, bvid, title, ... }]`
 *   - auditing rows: `arc_audits: [{ Archive: {...}, Videos: [...] }]`
 * Keep both; using only one silently misses private drafts that are still under review.
 */
function archiveSummaryRows(data: unknown): Array<Record<string, unknown>> {
  const d = data as {
    archives?: Array<Record<string, unknown>>;
    arc_audits?: Array<Record<string, unknown> & { Archive?: Record<string, unknown> }>;
  } | null;
  const rows: Array<Record<string, unknown>> = [];
  for (const row of d?.archives ?? []) rows.push(row);
  for (const row of d?.arc_audits ?? []) {
    if (row.Archive && typeof row.Archive === "object") rows.push(row.Archive);
    else rows.push(row);
  }
  return rows;
}

/**
 * Find an archive by its exact title. Used only for crash recovery when the process died
 * between submitting P1 and persisting the returned BV. Multiple exact matches are
 * ambiguous and must be handed to a human, never guessed.
 */
export async function findArchiveByTitle(o: {
  cookiesPath: string;
  title: string;
  fetchImpl?: typeof fetch;
}): Promise<FindArchiveResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const cookie = cookieHeaderOrThrow(o.cookiesPath);
  const wanted = o.title.trim();
  if (!wanted) return { ok: false, matches: 0, raw: { error: "empty title" } };
  const summaries = new Map<number, ArchiveSummary>();
  let lastRaw: Record<string, unknown> = {};
  let successfulLookups = 0;
  for (const status of ["is_only_self", "all"]) {
    let res: Response;
    try {
      res = await doFetch(`https://member.bilibili.com/x/web/archives?status=${status}&pn=1`, {
        headers: { "User-Agent": UA, Cookie: cookie, Referer: "https://member.bilibili.com/" },
      });
    } catch {
      continue;
    }
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    lastRaw = raw;
    if (!res.ok || raw.code !== 0) continue;
    successfulLookups++;
    for (const s of archiveSummaries(raw.data)) {
      // Bilibili may normalize/truncate titles. Treat a prefix match as ambiguous too:
      // recovery must never attach to a different archive just because the title is similar.
      if (s.title === wanted || s.title.startsWith(wanted) || wanted.startsWith(s.title)) {
        summaries.set(s.aid, s);
      }
    }
  }
  if (successfulLookups === 0) {
    return { ok: false, matches: 0, searched: false, raw: { ...lastRaw, reason: "archive list unavailable" } };
  }
  const matches = [...summaries.values()];
  if (matches.length !== 1) {
    return { ok: false, matches: matches.length, searched: true, raw: lastRaw };
  }
  // Only an exact title is safe. Prefix candidates are counted to detect ambiguity, but
  // a single prefix-only match still needs a human because it may be a different archive.
  if (matches[0]!.title !== wanted) {
    return { ok: false, matches: 1, searched: true, raw: { ...lastRaw, reason: "title differs after normalization" } };
  }
  const found = await lookupArchive({
    cookiesPath: o.cookiesPath,
    aid: matches[0]!.aid,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  return { ok: found.ok, ...(found.archive ? { archive: found.archive } : {}), matches: 1, searched: true, raw: found.raw };
}

/**
 * 提交稿件(建稿 或 追 P)。
 *
 * 对应 biliup 的 `submit_by_web` / `edit_by_web`;`Studio` 字段与上游逐字对齐。
 */
export async function submitStudio(o: StudioInput): Promise<SubmitResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const cookie = cookieHeaderOrThrow(o.cookiesPath);
  const csrf = csrfOf(JSON.parse(readFileSync(o.cookiesPath, "utf-8")));
  const isEdit = typeof o.aid === "number" && o.aid > 0;
  const ts = Date.now();
  const path = isEdit ? "/x/vu/web/edit" : "/x/vu/web/add/v3";

  // `Studio` 字段与上游(Rust biliup)逐字对齐。上游按 serde **默认不跳过**未设字段,
  // 所以这里显式给出全部字段(包括空串/0/false),缺字段会被 B 站判 21001「参数错误」。
  const studio: Record<string, unknown> = {
    copyright: 1,
    source: "",
    tid: o.tid,
    cover: "",
    title: o.title.slice(0, 80), // B 站标题上限 80
    desc_format_id: 0,
    desc: o.desc ?? "",
    desc_v2: null,
    dynamic: "",
    subtitle: { open: 0, lan: "" },
    tag: (o.tag ?? "").split(",").filter(Boolean).slice(0, 10).join(","),
    // 上游 `Video`:title 可空(None),filename + desc 必填。
    // ⚠️ filename = complete() 返回的 stem。传 cid 或原名会被 21015 拒。
    videos: o.videos.map((v) => ({
      title: v.title ?? null,
      filename: v.filename,
      desc: v.desc ?? "",
    })),
    dtime: null,
    open_subtitle: false,
    interactive: 0,
    mission_id: null,
    dolby: 0,
    lossless_music: 0,
    no_reprint: 0,
    open_elec: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    // 关昵称水印:硬性,投稿后不可修改(与 run-biliup 的 --extra-fields 同值)
    watermark: { state: 0 },
    // 仅自己可见:硬性默认(private)
    is_only_self: o.private === false ? 0 : 1,
    charging_pay: 0,
  };
  if (isEdit) studio.aid = o.aid;

  const res = await doFetch(`https://member.bilibili.com${path}?t=${ts}&csrf=${encodeURIComponent(csrf)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, Cookie: cookie, Referer: "https://member.bilibili.com/" },
    body: JSON.stringify(studio),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const data = (raw.data ?? {}) as { aid?: number; bvid?: string };
  if (raw.code !== 0) return { ok: false, raw, ...(data.aid ? { aid: data.aid } : {}) };
  return { ok: true, raw, aid: data.aid, ...(data.bvid ? { bvid: data.bvid } : {}) };
}

/**
 * Append one completed part to an existing archive.
 *
 * The web edit endpoint replaces the part list. Sending only the new part therefore deletes
 * every earlier part. Always read the archive first, merge the new part at the end, and post
 * the full list. This mirrors biliup's `studio_data` + `videos.append` + `edit_by_web` flow.
 */
export async function appendStudioPart(o: {
  cookiesPath: string;
  bvid?: string;
  aid?: number;
  video: StudioVideo;
  fetchImpl?: typeof fetch;
}): Promise<SubmitResult & { archive?: StudioArchive }> {
  const found = await lookupArchive({
    cookiesPath: o.cookiesPath,
    ...(o.bvid ? { bvid: o.bvid } : {}),
    ...(o.aid ? { aid: o.aid } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  if (!found.ok || !found.archive) {
    return { ok: false, raw: { error: "lookup archive failed", ...found.raw } };
  }
  const existing = found.archive;
  if (existing.videos.some((v) => v.filename === o.video.filename)) {
    return { ok: true, aid: existing.aid, ...(existing.bvid ? { bvid: existing.bvid } : {}), raw: { idempotent: true }, archive: existing };
  }
  const videos: StudioInput["videos"] = [
    ...existing.videos.map((v) => ({
      ...(v.cid ? { cid: String(v.cid) } : {}),
      filename: v.filename,
      ...(v.title ? { title: v.title } : {}),
      ...(v.desc ? { desc: v.desc } : {}),
    })),
    {
      ...(o.video.cid ? { cid: String(o.video.cid) } : {}),
      filename: o.video.filename,
      ...(o.video.title ? { title: o.video.title } : {}),
      ...(o.video.desc ? { desc: o.video.desc } : {}),
    },
  ];
  const submitted = await submitStudio({
    cookiesPath: o.cookiesPath,
    title: existing.title,
    tid: existing.tid,
    tag: existing.tag,
    ...(existing.desc ? { desc: existing.desc } : {}),
    private: existing.private,
    videos,
    aid: existing.aid,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  return {
    ...submitted,
    archive: {
      ...existing,
      videos: [
        ...existing.videos,
        {
          ...(o.video.cid ? { cid: o.video.cid } : {}),
          filename: o.video.filename,
          ...(o.video.title ? { title: o.video.title } : {}),
          ...(o.video.desc ? { desc: o.video.desc } : {}),
        },
      ],
    },
  };
}

const CHUNK_TIMEOUT_MS = 240_000;

/**
 * 分块上传全部分 P 数据。串行(先求对,再求快;biliup 用 3 并发,后续可按需调)。
 */
export async function uploadChunks(o: UploadOptions): Promise<UposPart[]> {
  const { session, totalSize } = o;
  const doFetch = o.fetchImpl ?? fetch;
  const chunkSize = session.bucket.chunkSize;
  if (chunkSize <= 0) throw new Error("preupload 未返回有效 chunk_size");
  const chunks = Math.ceil(totalSize / chunkSize);
  const sizeOf = (): number => Math.min(totalSize, Math.max(1, Math.floor(o.totalSizeOf?.() ?? totalSize)));
  if (chunks === 0) throw new Error("totalSize 为 0,无可传内容");
  const retries = o.retries ?? 3;
  const parts: UposPart[] = [];
  let uploadedBytes = 0;
  /** 实际声明给服务端的总量;遇尾块时收敛为真实发送量。 */
  let declaredTotal = totalSize;
  // 少传收尾:传入 maxChunks 时只传前 N 块(UPOS 允许 parts < ceil(size/chunk_size))。
  const maxChunksRaw = o.maxChunks;
  const maxChunksOf = (): number =>
    Math.floor(typeof maxChunksRaw === "function" ? maxChunksRaw() : maxChunksRaw ?? Number.POSITIVE_INFINITY);
  let limit = Math.min(chunks, Math.max(1, Math.floor(maxChunksOf())));

  for (let i = 0; i < limit; i++) {
    o.signal?.throwIfAborted();
    limit = Math.min(chunks, Math.max(i + 1, Math.floor(maxChunksOf()))); // 实时收敛:时长到点后即刻停
    const start = i * chunkSize;
    const size = Math.min(chunkSize, sizeOf() - start);
    const body = await o.readChunk(i, size);
    // 尾块可以**短于** size:调用方(边录边传)在结算时才确定真实总量,而它是
    // 把一个短块交给这里的。于是这里按「收到的实际长度」推进,并把它作为
    // **最后一块** —— 之后 total/end 等参数都以它为准。
    // ⚠️ 不补零:补零能让 UPOS 收下,但 B 站转码阶段会拒,比本地失败更难排查。
    if (body.length > size) {
      throw new Error(`分块 ${i} 超长: 期望 ≤ ${size}, 实际 ${body.length}`);
    }
    const isTail = body.length < size;
    if (isTail) {
      // 尾块:把声明总量改写成「真实发送量」,后续参数全部基于它。
      declaredTotal = uploadedBytes + body.length;
    }
    const params = new URLSearchParams({
      uploadId: await uploadIdOf(session, doFetch),
      chunks: String(chunks),
      total: String(declaredTotal),
      chunk: String(i),
      size: String(body.length),
      partNumber: String(i + 1),
      start: String(start),
      end: String(start + body.length),
    });
    const ok = await putChunk(doFetch, `${session.url}?${params.toString()}`, session.bucket.auth, body, retries, o.signal);
    if (!ok) throw new Error(`分块 ${i} 上传失败(已重试 ${retries} 次)`);
    parts.push({ partNumber: i + 1, eTag: "etag" });
    uploadedBytes += body.length;
    o.onProgress?.({ uploadedBytes, chunksDone: i + 1 });
    if (isTail) break;
  }
  // parts 必须连续,服务端会校验;本地先查,避免无谓的 complete 请求。
  parts.forEach((p, idx) => {
    if (p.partNumber !== idx + 1) throw new Error(`parts 不连续: 位置 ${idx} 是 partNumber=${p.partNumber}`);
  });
  return parts;
}

export interface CompleteResult {
  ok: boolean;
  raw: Record<string, unknown>;
  /**
   * The `filename` Studio needs for this part: the `upos_uri` stem (B站服务端分配的
   * 内部文件名),**不是**我们 preupload 时声明的 name,也不是 cid。上游 Rust 同口径
   * (`Path::new(upos_uri).file_stem()`);传错会被 B 站以 21015「视频可能上传过程出现问题」拒收。
   */
  stem?: string;
}

/** 收尾:提交 parts,服务端校验连续后返回分 P 信息。 */
export async function complete(o: {
  session: PreuploadResult;
  parts: UposPart[];
  fetchImpl?: typeof fetch;
}): Promise<CompleteResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const url = new URL(o.session.url);
  url.searchParams.set("name", o.session.fileName);
  url.searchParams.set("uploadId", await uploadIdOf(o.session, doFetch));
  url.searchParams.set("biz_id", o.session.bucket.bizId);
  url.searchParams.set("output", "json");
  url.searchParams.set("profile", "ugcupos/bup");
  const res = await doFetch(url.toString(), {
    method: "POST",
    headers: { "X-Upos-Auth": o.session.bucket.auth, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ parts: o.parts }),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || raw.OK !== 1) return { ok: false, raw: { ...raw, httpStatus: res.status } };
  const key = typeof raw.key === "string" ? raw.key : undefined;
  // `key` is `bucket/name.ts`(带 bucket 前缀),必须先剥目录再剥扩展名。
  return { ok: true, raw, stem: uposStem(key ?? o.session.bucket.uposUri) };
}

/** upload_id 由 POST {url}?uploads&output=json 换取;一个会话只取一次。 */
async function uploadIdOf(session: PreuploadResult, doFetch: typeof fetch): Promise<string> {
  const cached = (session as { _uploadId?: string })._uploadId;
  if (cached) return cached;
  const url = new URL(session.url);
  url.searchParams.set("uploads", "");
  url.searchParams.set("output", "json");
  const res = await doFetch(url.toString(), {
    method: "POST",
    headers: { "X-Upos-Auth": session.bucket.auth, "User-Agent": UA },
  });
  const j = (await res.json()) as { upload_id?: string };
  if (!res.ok || !j.upload_id) throw new Error(`换取 upload_id 失败: HTTP ${res.status}`);
  (session as { _uploadId?: string })._uploadId = j.upload_id;
  return j.upload_id;
}

async function putChunk(
  doFetch: typeof fetch,
  url: string,
  auth: string,
  body: Uint8Array,
  retries: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await doFetch(url, {
        method: "PUT",
        headers: {
          "X-Upos-Auth": auth,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(body.length),
          "User-Agent": UA,
        },
        // Uint8Array<ArrayBufferLike> 不是合法 BodyInit。用 `subarray(0, len).buffer`
        // 会拿到**整块** underlying buffer(可能比 view 长)→ Content-Length 与 body 不符。
        // 必须精确切出这一块: 既让 Content-Length 与 body 一致,也满足 TS 的 BodyInit。
        body: new Uint8Array(body).buffer as ArrayBuffer,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)]) : AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
      if (res.ok) return true;
      if (res.status >= 500 && attempt < retries) { await sleep(1000 * (attempt + 1)); continue; }
      return false;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      if (attempt >= retries) return false;
      await sleep(1000 * (attempt + 1));
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
