import type { DtsGap } from "@drec/post-process";
import type { PreuploadResult } from "./upos-stream.js";
import type { PartTiming } from "./ts-cutter.js";
import type { PartSink } from "./live-pump-part-sink.js";
export type SpawnFn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcessLike;
export interface ChildProcessLike {
  stdout: (NodeJS.ReadableStream & {
    destroy?: (error?: Error) => void;
  }) | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}
export interface SealPolicy {
  maxBytes: number;
  maxMs?: number;
}
export interface FfmpegPipeArgs {
  url: string;
  headers?: Record<string, string>;
}
export interface SegmentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}
export interface SegmentRunResult {
  exit: SegmentExit;
  tsDiscontinuities?: number;
  tsGap?: DtsGap;
  chunksUploaded: number;
  streamedBytes: number;
  spooledBytes: number;
  uploadError?: string;
  sessionLeaked?: boolean;
  backpressured?: boolean;
  degradedReason?: string;
  spoolIncomplete?: boolean;
  sizeOverflow?: boolean;
  localValidationFailed?: boolean;
  sealedMs?: number;
  ptsDurationSec?: number;
  ptsStartSec?: number;
  ptsEndSec?: number;
  ptsJumpSec?: number;
  ptsJumpCount?: number;
  spoolDurationSec?: number;
  stemOfCompleted?: string;
  durationSealHit?: boolean;
  usedFileFallback?: boolean;
  sealedBy?: "cap" | "duration" | "eof" | "abort" | "stalled";
  stalledMs?: number;
}
export type SealedBy = NonNullable<SegmentRunResult["sealedBy"]>;
export interface SealedPart {
  sink: PartSink;
  sealedBy: SealedBy;
  bytes: number;
  timing: PartTiming | null;
  tsDiscontinuities: number;
  sealedMs: number;
  stalledMs?: number;
  ptsJumpSec?: number;
  ptsJumpCount?: number;
  final: boolean;
  stopped?: boolean;
}
export interface RunStreamOpts {
  args: string[];
  sizeCap: number;
  maxMs?: number;
  firstSink: PartSink;
  openNext: () => PartSink;
  onWarn?: (msg: string) => void;
  onPrefetch?: () => void;
  prefetchRatio?: number;
  stopAtCut?: () => boolean | Promise<boolean>;
  onPartSealed: (part: SealedPart) => void;
  signal?: AbortSignal;
  stallTimeoutMs?: number;
  destroyGraceMs?: number;
  exitGraceMs?: number;
}
export interface StreamRunResult {
  exit: SegmentExit;
  endedBy: SealedBy | "stopped";
  finalPart?: SealedPart;
  discardedTail: boolean;
  discardedSink?: PartSink;
  stalledMs?: number;
}
export interface RunSegmentOpts {
  args: string[];
  chunkSize?: number;
  sizeCap: number;
  spoolPath: string;
  session: PreuploadResult;
  fetchImpl?: typeof fetch;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  queueCapacity?: number;
  spoolMode?: "full" | "none";
  writeSpool?: (fd: number, buf: Buffer) => number;
  seal?: SealPolicy;
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  onDegrade?: (reason: string) => void;
  onSpoolWriteFailed?: (reason: string) => void;
  signal?: AbortSignal;
  stallTimeoutMs?: number;
  destroyGraceMs?: number;
  exitGraceMs?: number;
}
