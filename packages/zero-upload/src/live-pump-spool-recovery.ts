import { existsSync, statSync } from "node:fs";
import { ffprobeDuration, ffprobeDtsGap, type DtsGap } from "@drec/post-process";
import {
  preupload, uploadChunks, complete, UposRateLimited, RECOVERY_CHUNK_RETRY_DELAYS_MS,
  type PreuploadResult,
} from "./upos-stream.js";
import type { LivePumpState } from "./live-pump-state.js";
import { sleepUnlessAborted } from "./live-pump-wait.js";

/** Forward DTS jumps above 30s are held; normal reconnects remain below this threshold. */
export const DTS_GAP_FORWARD_SEC = 30;
/** Gap-held spools are outside the ordinary orphan sweep pattern. */
export const heldGapPath = (spoolPath: string): string => spoolPath.replace(/(\.[^./]+)?$/, ".held-gap$1");
export const defaultScanDtsGap = (path: string): Promise<DtsGap | null | undefined> => ffprobeDtsGap(path, DTS_GAP_FORWARD_SEC);
export type RecoverySpool = Readonly<Pick<LivePumpState["parts"][number],
  "index" | "spoolPath" | "filename" | "bytes" | "sealed" | "spoolIncomplete"
>>;

export type SpoolRecoveryDisposition =
  | { kind: "discard" }
  | { kind: "held"; error: string }
  | { kind: "gap"; gap: DtsGap }
  | { kind: "failed"; error: string; retryable?: boolean; alert?: boolean };

type RecoveryOptions = {
  target: RecoverySpool;
  cookiesPath: string;
  line?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  probeDuration?: (path: string) => Promise<number>;
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  log: (message: string) => void;
  onActivity: () => void;
  onChunk?: (uploaded: number, chunks: number) => void;
};

type ReadableSpool = { kind: "ready"; bytes: number; durationSec: number };

/** Only never-sealed placeholders may be discarded when no readable video remains. */
function unreadableSpool(target: RecoverySpool, error: string): SpoolRecoveryDisposition {
  return target.sealed === false ? { kind: "discard" } : { kind: "failed", error };
}

function inspectSpoolFile(target: RecoverySpool): { kind: "sized"; bytes: number } | SpoolRecoveryDisposition {
  // A write-truncated spool always requires a human, even when it was never sealed.
  if (target.spoolIncomplete) {
    return { kind: "failed", alert: true,
      error: `分 P ${target.index} 的 spool 写失败被截断(${target.bytes}B),不自动重传,需人工处理: ${target.spoolPath}` };
  }
  let bytes: number;
  try { bytes = statSync(target.spoolPath).size; } catch {
    if (existsSync(heldGapPath(target.spoolPath))) {
      return { kind: "held",
        error: `分 P ${target.index} 已因时间戳跳变扣留(${heldGapPath(target.spoolPath)}),稿件缺少这一 P,需人工处理` };
    }
    return unreadableSpool(target, `spool missing for unconfirmed part ${target.index}: ${target.spoolPath}`);
  }
  if (bytes <= 0) return unreadableSpool(target, `spool empty for unconfirmed part ${target.index}`);
  return { kind: "sized", bytes };
}

async function inspectRecoveryMedia(o: RecoveryOptions): Promise<ReadableSpool | SpoolRecoveryDisposition> {
  const file = inspectSpoolFile(o.target);
  if (file.kind !== "sized") return file;
  const { target } = o;
  let durationSec = 0;
  try { durationSec = await (o.probeDuration ?? ffprobeDuration)(target.spoolPath); } catch { durationSec = 0; }
  if (!(durationSec > 0)) {
    return unreadableSpool(target,
      `spool of part ${target.index} is not readable (no duration), not resubmitting: ${target.spoolPath}`);
  }
  // Preserve the recovery path's existing inconclusive-scan policy during extraction.
  let gap: DtsGap | null | undefined;
  try { gap = await (o.scanDtsGap ?? defaultScanDtsGap)(target.spoolPath); } catch { gap = undefined; }
  if (gap) return { kind: "gap", gap };
  return { kind: "ready", bytes: file.bytes, durationSec };
}

/** Prepare bytes for publication; the session owns row changes, holds and all durable writes. */
export async function prepareRecoveredSpool(o: RecoveryOptions): Promise<
  (ReadableSpool & { stem: string }) | SpoolRecoveryDisposition
> {
  const inspected = await inspectRecoveryMedia(o);
  if (inspected.kind !== "ready") return inspected;
  const { target } = o;
  const { bytes, durationSec } = inspected;
  o.log(`[直播直传] 分 P ${target.index} 未确认,按整文件重传补齐(${target.spoolPath})`);
  let recoveredPct = 0;
  const uploaded = await reuploadSpoolFile({
    cookiesPath: o.cookiesPath, fileName: target.filename, spoolPath: target.spoolPath,
    line: o.line ?? "txa", fetchImpl: o.fetchImpl ?? fetch,
    onChunk: (count, chunks) => {
      o.onActivity();
      const pct = Math.min(100, Math.floor((count / Math.max(1, bytes)) * 10) * 10);
      if (pct > recoveredPct) {
        recoveredPct = pct;
        o.log(`[直播直传] 分 P ${target.index} 重传进度 ${pct}% (${count}/${bytes} B)`);
      }
      try { o.onChunk?.(count, chunks); } catch { /* Display-only progress must not stop recovery. */ }
    },
    log: o.log,
    ...(o.sleep ? { sleep: o.sleep } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  if (!uploaded.ok || !uploaded.stem) {
    return { kind: "failed", retryable: true, error: `resubmit upload failed: ${uploaded.error ?? "no stem"}` };
  }
  return { kind: "ready", stem: uploaded.stem, bytes: uploaded.bytes, durationSec };
}

/** preupload with the 601 rate-limit backoff (only a fresh session can hit it). */
export async function preuploadWithBackoff(o: {
  cookiesPath: string;
  fileName: string;
  sizeCap: number;
  line: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  log?: (msg: string) => void;
  /** Sleep seam for the 601 backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
}): Promise<PreuploadResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await preupload({
        cookiesPath: o.cookiesPath, fileName: o.fileName, totalSize: o.sizeCap,
        line: o.line, fetchImpl: o.fetchImpl, ...(o.signal ? { signal: o.signal } : {}),
      });
    } catch (e) {
      if (!(e instanceof UposRateLimited) || attempt >= 8) throw e;
      // Keep bounded backoff visible so it is not mistaken for a stalled recording.
      const waitMs = Math.min(30_000 * 2 ** attempt, 300_000);
      o.log?.(`[直播直传] preupload 命中限流,${waitMs / 1000}s 后重试(${attempt + 2}/9): ${o.fileName}`);
      await sleepUnlessAborted(waitMs, [o.signal], o.sleep);
      if (o.signal?.aborted) throw new Error("live-pump aborted during preupload backoff");
    }
  }
}

/** Retransmit the exact file size in complete chunks, without live-stream tail negotiation. */
export async function reuploadSpoolFile(o: {
  cookiesPath: string;
  fileName: string;
  spoolPath: string;
  line: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  /** Progress/diagnostic log (preupload backoff). */
  log?: (msg: string) => void;
  /** Sleep seam for the preupload 601 backoff and chunk retries (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Chunk retries after the initial attempt; defaults to the recovery policy (6). */
  retries?: number;
  /** Chunk retry delays; defaults to the recovery policy (2/5/10/20/30/30s). */
  retryDelaysMs?: readonly number[];
}): Promise<{ ok: boolean; stem?: string; chunks: number; bytes: number; error?: string }> {
  const { openSync, closeSync, statSync } = await import("node:fs");
  let totalSize: number;
  let fd: number;
  try {
    totalSize = statSync(o.spoolPath).size;
    if (totalSize <= 0) return { ok: false, chunks: 0, bytes: 0, error: "spool 为空" };
    fd = openSync(o.spoolPath, "r");
  } catch (e) {
    return { ok: false, chunks: 0, bytes: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
  try {
    return await reuploadOpenSpool(o, fd, totalSize);
  } finally {
    closeSync(fd);
  }
}

/** Bound memory to one chunk while transferring an already-open spool. */
async function reuploadOpenSpool(
  o: Parameters<typeof reuploadSpoolFile>[0],
  fd: number,
  totalSize: number,
): Promise<{ ok: boolean; stem?: string; chunks: number; bytes: number; error?: string }> {
  const { readSync } = await import("node:fs");

  let session: PreuploadResult;
  try {
    // Use the same bounded backoff as live preupload, including on fallback.
    session = await preuploadWithBackoff({
      cookiesPath: o.cookiesPath, fileName: o.fileName, sizeCap: totalSize,
      line: o.line, fetchImpl: o.fetchImpl, signal: o.signal, log: o.log, sleep: o.sleep,
    });
  } catch (e) {
    return { ok: false, chunks: 0, bytes: 0, error: `preupload: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }

  const readChunk = async (i: number, size: number): Promise<Buffer> => {
    const buf = Buffer.allocUnsafe(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, i * session.bucket.chunkSize + off);
      if (n <= 0) throw new Error(`spool 读取提前结束(块 ${i}, ${off}/${size})`);
      off += n;
    }
    return buf;
  };

  try {
    const parts = await uploadChunks({
      session, totalSize,
      fetchImpl: o.fetchImpl ?? fetch,
      // Recovery runs after the segment is sealed: wait out a short CDN/TCP blip instead
      // of declaring the whole-file fallback failed. The live path keeps 3 fast retries.
      retries: o.retries ?? RECOVERY_CHUNK_RETRY_DELAYS_MS.length,
      retryDelaysMs: o.retryDelaysMs ?? RECOVERY_CHUNK_RETRY_DELAYS_MS,
      ...(o.sleep ? { retrySleep: o.sleep } : {}),
      signal: o.signal,
      onProgress: (p) => o.onChunk?.(p.uploadedBytes, p.chunksDone),
      readChunk,
    });
    const done = await complete({ session, parts, fetchImpl: o.fetchImpl, signal: o.signal });
    if (!done.ok) return { ok: false, chunks: parts.length, bytes: totalSize, error: `complete: ${JSON.stringify(done.raw).slice(0, 200)}` };
    return { ok: true, stem: done.stem, chunks: parts.length, bytes: totalSize };
  } catch (e) {
    return { ok: false, chunks: 0, bytes: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}
