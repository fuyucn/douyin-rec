import { PartSink, type PartSinkResult } from "./live-pump-part-sink.js";
import { preuploadWithBackoff } from "./live-pump-spool-recovery.js";
import { finalizeRecordedPart } from "./live-pump-validation.js";
import { runStream } from "./live-pump-stream.js";
import type { PreuploadResult } from "./upos-stream.js";
import type { DtsGap } from "@drec/post-process";
import type { RunSegmentOpts, SealedPart, SegmentExit, SegmentRunResult } from "./live-pump-types.js";
export type PumpSegmentOptions = {
  cookiesPath: string;
  args: string[];
  fileName: string;
  sizeCap: number;
  spoolDir: string;
  line: string;
  maxMs?: number;
  stallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  onDegrade?: (reason: string) => void;
  onSpoolWriteFailed?: (reason: string) => void;
  log?: (msg: string) => void;
  onFallback?: (spoolPath: string, bytes: number) => void;
  probeDuration?: (path: string) => Promise<number>;
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  signal?: AbortSignal;
  keepSpool?: boolean;
  queueCapacity?: number;
  spoolMode?: "full" | "none";
  writeSpool?: (fd: number, buf: Buffer) => number;
};
export function segmentResultOf(part: SealedPart, sink: PartSinkResult, exit: SegmentExit): SegmentRunResult {
  return {
    exit,
    tsDiscontinuities: part.tsDiscontinuities,
    chunksUploaded: sink.chunksUploaded,
    streamedBytes: sink.streamedBytes,
    spooledBytes: sink.spooledBytes,
    uploadError: sink.uploadError,
    ...(sink.degradedReason ? { degradedReason: sink.degradedReason } : {}),
    ...(sink.spoolIncomplete ? { spoolIncomplete: true } : {}),
    ...(sink.sizeOverflow ? { sizeOverflow: true } : {}),
    sessionLeaked: sink.sessionLeaked,
    backpressured: sink.backpressured,
    sealedMs: part.sealedMs,
    sealedBy: part.sealedBy,
    ...(part.sealedBy === "duration" ? { durationSealHit: true } : {}),
    ...(part.stalledMs !== undefined ? { stalledMs: part.stalledMs } : {}),
    ...(part.timing && part.timing.durationSec > 0 ? { ptsDurationSec: part.timing.durationSec } : {}),
    ...(part.timing ? { ptsStartSec: part.timing.firstPts, ptsEndSec: part.timing.lastPts, ...(part.timing.ptsJumpSec ? { ptsJumpSec: part.timing.ptsJumpSec, ptsJumpCount: part.timing.ptsJumpCount } : {}) } : {}),
  };
}
export async function runSegment(o: RunSegmentOpts): Promise<SegmentRunResult> {
  const sink = new PartSink({
    sizeCap: o.sizeCap,
    spoolPath: o.spoolPath,
    session: o.session,
    ...(o.chunkSize !== undefined ? { chunkSize: o.chunkSize } : {}),
    ...(o.spoolMode ? { spoolMode: o.spoolMode } : {}),
    ...(o.writeSpool ? { writeSpool: o.writeSpool } : {}),
    ...(o.queueCapacity !== undefined ? { queueCapacity: o.queueCapacity } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.onChunk ? { onChunk: o.onChunk } : {}),
    ...(o.onBackpressure ? { onBackpressure: o.onBackpressure } : {}),
    ...(o.onDegrade ? { onDegrade: o.onDegrade } : {}),
    ...(o.onSpoolWriteFailed ? { onSpoolWriteFailed: o.onSpoolWriteFailed } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const stream = await runStream({
    args: o.args,
    sizeCap: o.sizeCap,
    ...(o.seal?.maxMs ? { maxMs: o.seal.maxMs } : {}),
    firstSink: sink,
    openNext: () => {
      throw new Error("runSegment: single-part run must not open a second part");
    },
    stopAtCut: () => true,
    onPartSealed: () => {
    },
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.stallTimeoutMs !== undefined ? { stallTimeoutMs: o.stallTimeoutMs } : {}),
    ...(o.destroyGraceMs !== undefined ? { destroyGraceMs: o.destroyGraceMs } : {}),
    ...(o.exitGraceMs !== undefined ? { exitGraceMs: o.exitGraceMs } : {}),
  });
  const part = stream.finalPart!;
  return segmentResultOf(part, await sink.finished, stream.exit);
}
export async function pumpSegment(o: PumpSegmentOptions): Promise<SegmentRunResult & {
  session: PreuploadResult;
}> {
  const spoolPath = `${o.spoolDir.replace(/\/$/, "")}/${o.fileName}`;
  const session = await preuploadWithBackoff({
    cookiesPath: o.cookiesPath,
    fileName: o.fileName,
    sizeCap: o.sizeCap,
    line: o.line,
    fetchImpl: o.fetchImpl,
    signal: o.signal,
    log: o.log,
  });
  const spoolMode = o.spoolMode ?? "full";
  const rec = await runSegment({
    args: o.args,
    sizeCap: o.sizeCap,
    spoolPath,
    spoolMode,
    queueCapacity: o.queueCapacity,
    ...(o.writeSpool ? { writeSpool: o.writeSpool } : {}),
    session,
    fetchImpl: o.fetchImpl,
    signal: o.signal,
    seal: { maxBytes: o.sizeCap, maxMs: o.maxMs },
    stallTimeoutMs: o.stallTimeoutMs,
    onChunk: o.onChunk,
    onBackpressure: o.onBackpressure,
    onDegrade: o.onDegrade,
    ...(o.onSpoolWriteFailed ? { onSpoolWriteFailed: o.onSpoolWriteFailed } : {}),
  });
  const fin = await finalizeRecordedPart({
    rec,
    session,
    cookiesPath: o.cookiesPath,
    fileName: o.fileName,
    spoolPath,
    spoolMode,
    line: o.line,
    fetchImpl: o.fetchImpl,
    signal: o.signal,
    onChunk: o.onChunk,
    log: o.log,
    onFallback: o.onFallback,
    probeDuration: o.probeDuration,
    scanDtsGap: o.scanDtsGap,
    keepSpool: o.keepSpool,
  });
  return { ...fin, session };
}
