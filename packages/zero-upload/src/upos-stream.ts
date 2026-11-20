// Stream bytes through preupload, chunk PUTs and completion without requiring a local file.
// Keep this module's exports stable; Studio metadata operations live in separate modules.
import { noteRecorderProgress } from "@drec/core";
import { UA, controlSignal, readBiliupCookieHeader } from "./upos-http.js";
import { sleepUnlessAborted } from "./live-pump-wait.js";

export { lookupArchive, findArchiveByTitle } from "./studio-archive.js";
export type { StudioVideo, StudioArchive, LookupArchiveResult, FindArchiveResult } from "./studio-archive.js";
export { submitStudio, appendStudioPart } from "./studio-submit.js";
export type { StudioInput, SubmitResult } from "./studio-submit.js";

export interface UposBucket {
  chunkSize: number;
  auth: string;
  endpoint: string;
  bizId: string;
  uposUri: string;
}

interface RawUposBucket {
  chunk_size?: number;
  auth?: string;
  endpoint?: string;
  biz_id?: string | number;
  upos_uri?: string;
  OK?: number;
  code?: number;
  message?: string;
}

export interface PreuploadResult {
  bucket: UposBucket;
  /** Absolute URL shared by chunk PUTs and completion. */
  url: string;
  fileName: string;
}

export interface PreuploadOptions {
  cookiesPath: string;
  /** Client filename, echoed unchanged at completion; not the server's Studio stem. */
  fileName: string;
  /** Predeclared byte count; the bytes need not exist when the session is allocated. */
  totalSize: number;
  /** Upload route; defaults to txa. */
  line?: string;
  preuploadBase?: string;
  fetchImpl?: typeof fetch;
  /** Hard-stop signal; the caller also owns bounded rate-limit backoff. */
  signal?: AbortSignal;
}

/** A retryable preupload refusal, distinct from a failed chunk transfer. */
export class UposRateLimited extends Error {
  constructor(readonly detail: Record<string, unknown>) {
    super("B 站上传限流(406/601 上传过快,需冷却后重试)");
    this.name = "UposRateLimited";
  }
}

function isRateLimitedBody(j: { code?: unknown }): boolean {
  // Both observed refusal codes require backoff, not a generic missing-fields failure.
  const code = Number(j.code);
  return code === 601 || code === 406;
}

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
    signal: controlSignal(o.signal),
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
    // Normalize endpoint slashes and the UPOS scheme before building an absolute HTTPS URL.
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

/** Live-streaming path: fail fast, then degrade to spool instead of blocking the recorder. */
export const DEFAULT_CHUNK_RETRY_DELAYS_MS = [1000, 2000, 3000] as const;
/** Already-sealed recovery path: outlive a short network/CDN blip before giving up. */
export const RECOVERY_CHUNK_RETRY_DELAYS_MS = [2000, 5000, 10000, 20000, 30000, 30000] as const;

export interface UploadOptions {
  session: PreuploadResult;
  /** The byte count declared at preupload. */
  totalSize: number;
  /** Supply one chunk from memory or disk; only the final chunk may be shorter. */
  readChunk: (index: number, size: number) => Promise<Uint8Array>;
  fetchImpl?: typeof fetch;
  retries?: number;
  /** Delay before each retry; the last entry is reused when retries outnumber delays. */
  retryDelaysMs?: readonly number[];
  /** Test seam for retry backoff; production uses setTimeout. */
  retrySleep?: (ms: number) => Promise<void>;
  onProgress?: (p: UploadChunkProgress) => void;
  signal?: AbortSignal;
  /** Current real size, capped by totalSize, for finalizing a live stream early. */
  totalSizeOf?: () => number;
  /** Re-evaluated each iteration; early completion still requires contiguous parts 1..N. */
  maxChunks?: number | (() => number);
  /** Observability only: reports the last failed PUT attempt after retries are exhausted. */
  onChunkFailure?: (info: { chunk: number; httpStatus?: number; error?: string }) => void;
}

/** Strip scheme, directories and extension from a server key or UPOS URI. */
function uposStem(rawPath: string): string {
  const raw = decodeURIComponent(rawPath.replace(/^upos:\/\//, ""));
  const base = raw.split("/").pop() ?? raw;
  return base.replace(/\.[^.]+$/, "");
}

// Chunk PUTs get a longer per-attempt deadline than metadata requests.
const CHUNK_TIMEOUT_MS = 240_000;

export async function uploadChunks(o: UploadOptions): Promise<UposPart[]> {
  const { session, totalSize } = o;
  const doFetch = o.fetchImpl ?? fetch;
  const chunkSize = session.bucket.chunkSize;
  if (chunkSize <= 0) throw new Error("preupload 未返回有效 chunk_size");
  const chunks = Math.ceil(totalSize / chunkSize);
  const sizeOf = (): number => Math.min(totalSize, Math.max(1, Math.floor(o.totalSizeOf?.() ?? totalSize)));
  if (chunks === 0) throw new Error("totalSize 为 0,无可传内容");
  const retries = o.retries ?? 3;
  const retryDelaysMs = o.retryDelaysMs ?? DEFAULT_CHUNK_RETRY_DELAYS_MS;
  const parts: UposPart[] = [];
  let uploadedBytes = 0;

  let declaredTotal = totalSize;

  const maxChunksRaw = o.maxChunks;
  const maxChunksOf = (): number =>
    Math.floor(typeof maxChunksRaw === "function" ? maxChunksRaw() : maxChunksRaw ?? Number.POSITIVE_INFINITY);
  let limit = Math.min(chunks, Math.max(1, Math.floor(maxChunksOf())));

  for (let i = 0; i < limit; i++) {
    o.signal?.throwIfAborted();
    limit = Math.min(chunks, Math.max(i + 1, Math.floor(maxChunksOf())));
    const start = i * chunkSize;
    const size = Math.min(chunkSize, sizeOf() - start);
    const body = await o.readChunk(i, size);

    if (body.length > size) {
      throw new Error(`分块 ${i} 超长: 期望 ≤ ${size}, 实际 ${body.length}`);
    }
    const isTail = body.length < size;
    if (isTail) {
      // UPOS accepts a shorter tail. Never zero-pad it: padding corrupts the media payload.
      declaredTotal = uploadedBytes + body.length;
    }
    await uploadChunk(o, { doFetch, retries, retryDelaysMs, retrySleep: o.retrySleep, chunks, declaredTotal, index: i, start, body });
    parts.push({ partNumber: i + 1, eTag: "etag" });
    uploadedBytes += body.length;
    noteRecorderProgress(); // A completed chunk is real progress for the finalizing stall judge.
    o.onProgress?.({ uploadedBytes, chunksDone: i + 1 });
    if (isTail) break;
  }
  parts.forEach((p, idx) => {
    if (p.partNumber !== idx + 1) throw new Error(`parts 不连续: 位置 ${idx} 是 partNumber=${p.partNumber}`);
  });
  return parts;
}

async function uploadChunk(o: UploadOptions, transfer: {
  doFetch: typeof fetch; retries: number; retryDelaysMs: readonly number[]; retrySleep?: (ms: number) => Promise<void>;
  chunks: number; declaredTotal: number; index: number; start: number; body: Uint8Array;
}): Promise<void> {
  const { session } = o;
  const { doFetch, retries, retryDelaysMs, retrySleep, chunks, declaredTotal, index: i, start, body } = transfer;
  const params = new URLSearchParams({
    uploadId: await uploadIdOf(session, doFetch, o.signal),
    chunks: String(chunks),
    total: String(declaredTotal),
    chunk: String(i),
    size: String(body.length),
    partNumber: String(i + 1),
    start: String(start),
    end: String(start + body.length),
  });
  let lastFail: { httpStatus?: number; error?: string } | undefined;
  const ok = await putChunk(doFetch, `${session.url}?${params.toString()}`, session.bucket.auth, body, retries, retryDelaysMs, retrySleep, o.signal, (f) => { lastFail = f; });
  if (!ok) {
    o.onChunkFailure?.({ chunk: i, ...(lastFail?.httpStatus !== undefined ? { httpStatus: lastFail.httpStatus } : {}), ...(lastFail?.error !== undefined ? { error: lastFail.error } : {}) });
    // Preserve the last transport failure in the durable pump error, not just in its callback.
    const why = lastFail?.httpStatus !== undefined ? `,HTTP ${lastFail.httpStatus}` : lastFail?.error !== undefined ? `,${lastFail.error}` : "";
    throw new Error(`分块 ${i} 上传失败(已重试 ${retries} 次)${why}`);
  }
}

export interface CompleteResult {
  ok: boolean;
  raw: Record<string, unknown>;
  /** Server-assigned filename for Studio: never the client filename or a CID. */
  stem?: string;
}

export async function complete(o: {
  session: PreuploadResult;
  parts: UposPart[];
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
}): Promise<CompleteResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const url = new URL(o.session.url);
  url.searchParams.set("name", o.session.fileName);
  url.searchParams.set("uploadId", await uploadIdOf(o.session, doFetch, o.signal));
  url.searchParams.set("biz_id", o.session.bucket.bizId);
  url.searchParams.set("output", "json");
  url.searchParams.set("profile", "ugcupos/bup");
  const res = await doFetch(url.toString(), {
    method: "POST",
    headers: { "X-Upos-Auth": o.session.bucket.auth, "Content-Type": "application/json", "User-Agent": UA },
    body: JSON.stringify({ parts: o.parts }),
    signal: controlSignal(o.signal),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || raw.OK !== 1) return { ok: false, raw: { ...raw, httpStatus: res.status } };
  const key = typeof raw.key === "string" ? raw.key : undefined;
  // Prefer the completion key; the allocated UPOS URI is the compatible fallback.
  return { ok: true, raw, stem: uposStem(key ?? o.session.bucket.uposUri) };
}

/** Resolve and cache one upload ID per session, shared by all PUTs and completion. */
async function uploadIdOf(session: PreuploadResult, doFetch: typeof fetch, signal?: AbortSignal): Promise<string> {
  const cached = (session as { _uploadId?: string })._uploadId;
  if (cached) return cached;
  const url = new URL(session.url);
  url.searchParams.set("uploads", "");
  url.searchParams.set("output", "json");
  const res = await doFetch(url.toString(), {
    method: "POST",
    headers: { "X-Upos-Auth": session.bucket.auth, "User-Agent": UA },
    signal: controlSignal(signal),
  });
  const j = (await res.json()) as { upload_id?: string };
  if (!res.ok || !j.upload_id) throw new Error(`换取 upload_id 失败: HTTP ${res.status}`);
  (session as { _uploadId?: string })._uploadId = j.upload_id;
  return j.upload_id;
}

function describeFetchError(e: unknown): string {
  const err = e as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof err?.name === "string" ? err.name : "Error";
  const message = String(err?.message ?? e).slice(0, 200);
  let detail: string | undefined;
  const cause = err?.cause;
  if (typeof cause === "string") detail = cause;
  else if (cause && typeof cause === "object") {
    const c = cause as { code?: unknown; message?: unknown; name?: unknown };
    const raw = (typeof c.code === "string" && c.code) || (typeof c.message === "string" && c.message) || (typeof c.name === "string" && c.name);
    if (raw) detail = raw;
  }
  return `${name}: ${message}${detail ? ` (${detail.slice(0, 120)})` : ""}`;
}

async function putChunk(
  doFetch: typeof fetch,
  url: string,
  auth: string,
  body: Uint8Array,
  retries: number,
  retryDelaysMs: readonly number[],
  retrySleep: ((ms: number) => Promise<void>) | undefined,
  signal?: AbortSignal,
  onFail?: (info: { httpStatus?: number; error?: string }) => void,
): Promise<boolean> {
  const wait = (ms: number): Promise<void> => sleepUnlessAborted(ms, [signal], retrySleep);
  const delayOf = (attempt: number): number => retryDelaysMs[attempt] ?? retryDelaysMs.at(-1) ?? 3000;
  let httpStatus: number | undefined;
  let error: string | undefined;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Stop must not wait out a recovery backoff (up to 30s); check before every attempt.
    signal?.throwIfAborted();
    // A later timeout must replace an earlier HTTP failure in the diagnostic result.
    httpStatus = undefined;
    error = undefined;
    try {
      const res = await doFetch(url, {
        method: "PUT",
        headers: {
          "X-Upos-Auth": auth,
          "Content-Type": "application/octet-stream",
          "Content-Length": String(body.length),
          "User-Agent": UA,
        },
        // Copy exactly this view; body.buffer may include unrelated bytes beyond the chunk.
        body: new Uint8Array(body).buffer as ArrayBuffer,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(CHUNK_TIMEOUT_MS)]) : AbortSignal.timeout(CHUNK_TIMEOUT_MS),
      });
      if (res.ok) return true;
      httpStatus = res.status;
      if (res.status >= 500 && attempt < retries) { await wait(delayOf(attempt)); continue; }
      break;
    } catch (e) {
      if ((e as Error)?.name === "AbortError") throw e;
      error = describeFetchError(e);
      if (attempt >= retries) break;
      await wait(delayOf(attempt));
    }
  }
  onFail?.({ ...(httpStatus !== undefined ? { httpStatus } : {}), ...(error !== undefined ? { error } : {}) });
  return false;
}
