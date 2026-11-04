/**
 * live-pump.ts — record-and-upload in one pass: one ffmpeg per stream connection, parts cut by us
 * (T-63 phase 2; plans/043).
 *
 * Nothing authoritative tells the upload layer "this part is finished" while a recorder is still
 * running, so `RollingUploader` used the appearance of the next file as its seal signal and always
 * lagged one part behind. Here the pump owns the cut point instead: ffmpeg writes one continuous
 * mpegts stream to stdout and {@link TsCutter} ends a part on a video keyframe (size bound or PTS
 * duration, whichever comes first). The part is sealed at that instant, with no dependence on a
 * successor and without stopping the pull.
 *
 * Data flow (chunking follows biliup's `sync_downloader.rs` pump_chunks; the upload is the in-house
 * upos-stream):
 *
 *   ffmpeg -f mpegts pipe:1                       (one process per connection)
 *     |- stdout --> TsCutter --> PartSink k --> UPOS chunks (+ spool file in "full" mode)
 *     \- cut     --> part k sealed; bytes flow into PartSink k+1 at once
 *                    part k: complete --> dts scan --> submit   (background, strictly in order)
 *
 * The spool is the fallback safety net until the archive confirms the part; LivePumpSession removes
 * it then. A failed upload falls back to a whole-file re-upload (reuploadSpoolFile).
 *
 * Callers: the hidden `_live-pump` command (manual/test) and the production task switch
 * `record --stream-upload` (task field streamUpload, plans/039).
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  appendStudioPart,
  complete,
  findArchiveByTitle,
  lookupArchive,
  preupload,
  submitStudio,
  uploadChunks,
  UposRateLimited,
  type PreuploadResult,
  type UposPart,
  type StudioVideo,
} from "./upos-stream.js";
import {
  addArchiveToSeasonIfConfigured,
  seasonCheckpointState,
  isSameBroadcastGap,
  isUploadRateLimited,
  noteRecorderProgress,
  type DanmuMessage,
  type LivePumpReporter,
} from "@drec/core";
import { ffprobeDuration, ffprobeDtsGap, type DtsGap } from "@drec/post-process";
import { TsCutter, type CutterEvent, type PartTiming } from "./ts-cutter.js";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** spawn 接缝(测试注入假 ffmpeg);默认 {@link FFMPEG}。 */
export type SpawnFn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcessLike;

/** 本模块用到的 ChildProcess 最小投影(便于测试用 stream 拼)。 */
export interface ChildProcessLike {
  stdout: (NodeJS.ReadableStream & { destroy?: (error?: Error) => void }) | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: string, fn: (...args: unknown[]) => void): unknown;
  kill(signal?: NodeJS.Signals): unknown;
}

let spawnOverride: SpawnFn | undefined;

/** 只在测试里用:替换 ffmpeg 启动器。 */
export function setSpawnForTest(fn: SpawnFn | undefined): void { spawnOverride = fn; }

export const CHUNK_UNIT = 10 * 1024 * 1024;

/** 向上对齐到 10 MiB 整数倍(UPOS chunk_size 即此量级;对齐上游 `align_file_size`)。 */
export function alignFileSize(n: number): number {
  return n > 0 ? Math.ceil(n / CHUNK_UNIT) * CHUNK_UNIT : 0;
}

/**
 * 默认分段上界(用户拍板:生产默认 1.5GiB;测试用 100MiB 显式传入)。
 *
 * 这只是**兜底上界**(防爆盘/防爆内存),不是分 P 的期望大小 —— 分 P 大小由
 * {@link SealPolicy} 的两个阈值谁先到决定。
 *
 * 仍然走 {@link alignFileSize}:块边界对齐 10MiB 时,尾块更可能刚好凑满一个整块,
 * 少一次「不足一块」的收尾。1.5 GiB 本身不是 10MiB 整数倍(153.6),直接写 `1.5 * 1024**3`
 * 会让每次分 P 都多出一个碎尾块。
 */
export const DEFAULT_SEGMENT_CAP = alignFileSize(1.5 * 1024 * 1024 * 1024);

/**
 * A live HTTP video stream normally emits bytes continuously. A minute without a single stdout
 * chunk means the source socket is half-open or the CDN stopped producing data; ffmpeg can sit
 * in ppoll forever because `-reconnect_at_eof` never sees EOF. Aligned with the file-recorder
 * ffmpeg watchdog (60s, issue #464): every silent minute is broadcast content lost for good,
 * so the old 5-minute default sealed far too late. Data that keeps flowing slowly never seals:
 * the timer only runs on total stdout silence.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 60_000;

/** Alert when a confirmed part's media time falls below this fraction of its wall time. */
export const DEFAULT_MEDIA_WALL_ALERT_RATIO = 0.85;

/** After a stall, keep the same archive available for this long before ending the run. */
export const DEFAULT_RECOVERY_WINDOW_MS = 20 * 60_000;

/** `queueCapacity` 的哨兵值:**只落盘、不上传**(切块照算,块直接丢弃)。 */
export const SPOOL_ONLY = 0;

/**
 * 分 P 结算策略:**字节兜底 与 时长阈值,谁先到算一 P**(用户设计)。
 *
 * 为什么能这么做:实测 UPOS 的 `complete` 接受「声明 chunks=N、实际只传 M<N 个连续 part」
 * (`preupload(size=20MiB)` → 只传 1 个 10MiB 块 → `OK:1`)。`chunks` 参数服务端不强校验,
 * 唯一硬约束是 **parts 连续(1..N)**。所以预声明的 `size` 只是上界,分 P 的真实大小
 * 就是实际流出的字节数,**不需要预知总长**。
 */
export interface SealPolicy {
  /** 字节兜底上界(= preupload 的 size)。达到即结算,无论时长是否到。 */
  maxBytes: number;
  /** 时长阈值(毫秒)。达到即结算,用**已累积的满块 + 尾块** complete。0 = 只用字节兜底。 */
  maxMs?: number;
}

export interface FfmpegPipeArgs {
  url: string;
  headers?: Record<string, string>;
}

/**
 * 构造「输出到 stdout 的 mpegts」ffmpeg argv(纯函数,便于单测)。
 *
 * 为什么是 **mpegts 而不是 matroska**(实测,换过一轮容器):
 *  - 管道是非 seekable 输出;matroska 在它上面**写不了音轨**
 *    (`Error parsing AAC extradata, unable to determine samplerate`,exit 1),
 *    且被 `-fs` 强杀时不写 trailer → `format.duration` 缺失 → B 站转码拒(实测 `62002`);
 *  - mpegts 每个 PES 包自带 PTS,**不需要尾部索引**:`-fs` 强杀后 ffprobe 照样读得出
 *    时长、解码干净、音轨保留(实测 6.99s / video+audio / exit 0);
 *  - 生产路径一直上传 `.ts` 分 P,稿件正常「开放浏览」—— 容器是被验证过的。
 *
 * 于是**不需要 remux**,也就能边录边传(见 {@link runSegment})。
 */
export function buildPipeFfmpegArgs(a: FfmpegPipeArgs): string[] {
  const isHttp = /^https?:/.test(a.url);
  const hdrs: string[] = [];
  if (isHttp && a.headers) {
    for (const [k, v] of Object.entries(a.headers)) {
      if (/^user-agent$/i.test(k)) hdrs.push("-user_agent", v);
      else if (/^referer$/i.test(k)) hdrs.push("-referer", v);
      else hdrs.push("-headers", `${k}: ${v}\r\n`);
    }
  }
  // `-reconnect*` 是 **http protocol 的 input 选项**:必须放在 `-i` 之前。
  // 实测两个坑:①放在 `-i` 之后会被当成 output 选项 → `Option reconnect not found`;
  // ②它们**只对 http 源有效**,喂本地文件路径时同样报这个错(protocol 不支持),
  // 所以只在 `isHttp` 时加。没有 `-fs`:一个连接只起一个 ffmpeg,分 P 由 TsCutter 在视频关键帧处切
  // (plans/043),ffmpeg 只在收播 / 停滞 / 被停止时退出。
  // `live_flv` makes the flv demuxer treat the input as a live stream, so ffmpeg applies one
  // offset per input file when the CDN resets timestamps mid-connection: audio and video stay
  // on a common base. With the plain demuxer a forward jump passes through and a backward
  // reset is clamped by the muxer, which cannot be repaired afterwards. FLV URLs only: an HLS
  // fallback URL must not get a forced demuxer.
  const liveFlv = isHttp && /\.flv(?:[?#]|$)/i.test(a.url) ? ["-f", "live_flv"] : [];
  const reconnect = isHttp
    ? ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30"]
    : [];
  return [
    // `warning` (not `error`) so timestamp discontinuity lines reach {@link countTsDiscontinuities}.
    "-loglevel", "warning", "-y",
    ...hdrs,
    "-fflags", "+genpts",
    ...reconnect,
    ...liveFlv,
    "-i", a.url,
    "-c", "copy", "-map", "0",
    "-reset_timestamps", "1",
    "-avoid_negative_ts", "make_zero",
    "-f", "mpegts", "-",
  ];
}

/** ffmpeg 进程退出信息 —— **本段封口的权威信号**(不依赖后继段)。 */
export interface SegmentExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderrTail: string;
}

/**
 * Forward dts step (seconds) above which a finished part is held. The ffmpeg live_flv demuxer
 * already corrects steps above its own 10s threshold, so what is left is a rare uncorrected
 * jump; 30s keeps ordinary uplink stalls and PK switches from blocking good parts (the
 * reported failures were thousands of seconds).
 */
export const DTS_GAP_FORWARD_SEC = 30;
/** Where a gap-held spool is kept: `name.held-gap.ext`. The orphan sweep only matches the plain name. */
export const heldGapPath = (spoolPath: string): string => spoolPath.replace(/(\.[^./]+)?$/, ".held-gap$1");
const defaultScanDtsGap = (path: string): Promise<DtsGap | null | undefined> => ffprobeDtsGap(path, DTS_GAP_FORWARD_SEC);

/** Matches the ffmpeg warnings emitted when input timestamps jump or go backwards. */
// ffmpeg 5.x says "Non-monotonous DTS", newer builds say "Non-monotonic DTS"; accept both.
const TS_DISCONTINUITY_RE = /timestamp discontinuity|non-monoton(?:ic|ous) dts|non monotonically increasing dts/i;

/** Count timestamp-discontinuity warning lines in a block of ffmpeg stderr text. */
export function countTsDiscontinuities(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) if (TS_DISCONTINUITY_RE.test(line)) n++;
  return n;
}

export interface SegmentRunResult {
  exit: SegmentExit;
  /** Timestamp-discontinuity warnings ffmpeg printed for this part (0 = none seen). */
  tsDiscontinuities?: number;
  /** First dts gap found by the pre-complete spool scan; set means the part is held, not submitted. */
  tsGap?: DtsGap;
  /** 已成功上传的块数。0 = 一个都没传出去(纯文件回退)。 */
  chunksUploaded: number;
  /** 实际流出到 UPOS 的字节数。 */
  streamedBytes: number;
  /** spool 实际字节数(回退文件上传时的权威长度)。 */
  spooledBytes: number;
  /** 上传任务失败原因(undefined = 全部块都传成功了)。 */
  uploadError?: string;
  /**
   * true = 有字节已 PUT 到 UPOS 但本段既不会 complete 也不会 abort。
   *
   * UPOS 协议**没有 abort 接口**(上游 biliup 也依赖「同 upload_id 重传全部块」覆盖),
   * 所以这种情况只能留下一个悬挂会话:占服务端配额、可能计入风控,且必须由调用方
   * **显式告知用户**(PoC 阶段)或在生产路径按原文件重传覆盖。
   */
  sessionLeaked?: boolean;
  /** true = 上传跟不上,已降级为纯落盘(调用方须告知用户)。 */
  backpressured?: boolean;
  /**
   * Why streaming degraded (chunk PUT failed / queue overflowed / session late), recorded the
   * moment it happens. A successful whole-file fallback clears `uploadError`; the reason
   * survives here so the part summary can still name it.
   */
  degradedReason?: string;
  /** Wall-clock recording duration of this part (ms). In zero-disk mode this is the only
   *  duration source, since there is no local file to probe. */
  sealedMs?: number;
  /** Media duration of this part from video PTS (seconds); absent when the stream carried no timestamp. */
  ptsDurationSec?: number;
  /** First video PTS of the part (seconds); absent when the stream carried no timestamp. */
  ptsStartSec?: number;
  /** Last video PTS of the part (seconds); absent when the stream carried no timestamp. */
  ptsEndSec?: number;
  /** Total seconds of forward PTS jumps inside the part (media missing at resume points). */
  ptsJumpSec?: number;
  /** Number of forward PTS jumps inside the part. */
  ptsJumpCount?: number;
  /** 投稿前自检得到的时长(秒);0/undefined = 未测或不合格(**不得投稿**)。 */
  spoolDurationSec?: number;
  /** complete 成功时的 UPOS stem;建稿 `videos[].filename` 必须用它。 */
  stemOfCompleted?: string;
  /** 本段是否由**时长阈值**结算(诊断:验证"谁先到算一 P"是否生效)。 */
  durationSealHit?: boolean;
  /** true = 本段走了**整文件回退**重传(不是流式;调用方须能区分,统计/告警各一路)。 */
  usedFileFallback?: boolean;
  /**
   * 本段为何结束。**时长结算不是失败** —— 调用方必须能把它与「流断了」区分开:
   *   - `cap`   :字节兜底先到(或没配时长阈值),常规完整收尾;
   *   - `duration`:时长阈值先到,只传出已入队的块(**少传合法**);
   *   - `eof`   :流先结束(stdout EOF),可能比声明的短;
   *   - `abort` :被 signal 取消;
   *   - `stalled`:stdout 长时间没有数据,看门狗主动封口。
   */
  sealedBy?: "cap" | "duration" | "eof" | "abort" | "stalled";
  /** Time since the last stdout chunk when the no-data watchdog fired. */
  stalledMs?: number;
}

/** Durable state for a single live archive. Written before/after every irreversible step. */
export interface LivePumpState {
  schemaVersion: 1;
  room: string;
  createdAt: number;
  title: string;
  tid: number;
  tag: string;
  /** Archive description; absent in older state files (treated as empty). */
  desc?: string;
  private: boolean;
  /** Archive identity; absent until the first part is submitted. */
  bvid?: string;
  aid?: number;
  /**
   * Season association state (issue #364). Written together with the BV, before the best-effort
   * season call, so a crash between create and association is recoverable on restart.
   */
  seasonState?: "pending" | "done" | "failed";
  /** Completed parts in submit order. Spool is deleted only after a part is confirmed. */
  parts: Array<{
    index: number;
    spoolPath: string;
    filename: string;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
    confirmed: boolean;
  }>;
  /** WAL for crash recovery. */
  pending?: {
    kind: "create" | "append";
    partIndex: number;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
    spoolPath: string;
  };
  updatedAt: number;
}

/**
 * Every spool path this state still depends on — the single source of truth for "which spool
 * files must survive a cleanup".
 *
 * Two owners, not one: `parts` holds a part's spool until that part is confirmed, and `pending`
 * is the WAL for an irreversible upload whose outcome is not yet persisted — recovery
 * (`resubmitUnconfirmedPart`) re-uploads that whole file. Listing only `parts` here looks right
 * and silently deletes the sole recovery copy of an interrupted upload (found by review):
 * the window is reachable because an upload-backoff round alone can run for minutes, which is
 * longer than the orphan-sweep grace period.
 */
export function spoolPathsToKeep(state: LivePumpState | null): string[] {
  if (!state) return [];
  const out = state.parts.map((p) => p.spoolPath);
  if (state.pending) out.push(state.pending.spoolPath);
  return out;
}

export function livePumpStatePath(spoolDir: string, room: string): string {
  const safe = room.replace(/[^0-9A-Za-z_-]+/g, "_");
  return join(spoolDir, `live-pump-${safe}.state.json`);
}

export function readLivePumpState(path: string): LivePumpState | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf-8")) as LivePumpState;
    if (s.schemaVersion !== 1 || !s.room || !Array.isArray(s.parts)) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * Whether a zero-disk run left work behind in the state file at `path`: a missing file means no
 * (nothing to recover); a file that exists but cannot be read or parsed is assumed to hold
 * unconfirmed parts, because the run that recovers them would otherwise be delayed. Shared by the
 * serve-side live gate, which must agree with the child's own recovery on what "unconfirmed" is.
 */
export function livePumpHasUnconfirmed(path: string): boolean {
  if (!existsSync(path)) return false;
  const state = readLivePumpState(path);
  if (!state) return true;
  return !!state.pending || state.parts.some((p) => !p?.confirmed);
}

export function writeLivePumpState(path: string, state: LivePumpState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}.${Date.now().toString(36)}`;
  try {
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, path);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

/** Archived state files are `<state path>.archived-<epoch ms>`; they are kept for audit, never deleted. */
const ARCHIVED_SUFFIX = ".archived-";

/**
 * Same-broadcast rule for the room-keyed state file (issue #293).
 *
 * The state is keyed by room only, so without this a later broadcast of the same room would append
 * to the previous broadcast's archive. Last activity = `updatedAt`, which `writeLivePumpState`
 * stamps on every write (so it survives restarts). Within `SAME_BROADCAST_GAP_MS` (core's single
 * rule) and readable, the old state is continued.
 *
 * The zero-disk path has no local copy of the stream, so refusing to start loses the broadcast for
 * good; a split submission is the lesser evil. Therefore this never throws. Whenever the old state
 * cannot be trusted to belong to the current broadcast, it is renamed aside intact (the WAL and the
 * spool files it references are kept) and a new submission starts:
 *  - stale (older than the gap) - archived; an alert is raised only if it still holds
 *    pending/unconfirmed parts, because then a human must reconcile them;
 *  - unreadable/corrupt, or room mismatch, or no usable timestamp with unconfirmed parts - archived
 *    with an alert, and never appended to.
 * An old state without a timestamp whose parts are all confirmed falls back to the file mtime.
 * Returns the alert message, if any.
 */
function rolloverStaleState(path: string, room: string, nowMs: number, log: (msg: string) => void): string | undefined {
  if (!existsSync(path)) return undefined;
  const archive = (reason: string, alert: boolean): string => {
    let archived = `${path}${ARCHIVED_SUFFIX}${nowMs}`;
    for (let n = 1; existsSync(archived); n++) archived = `${path}${ARCHIVED_SUFFIX}${nowMs}-${n}`; // rename would overwrite
    renameSync(path, archived);
    const msg = `直播直传旧状态${reason},已原样归档到 ${archived}(含未确认分 P 与暂存文件),本场开新稿件继续录制,需人工核对旧稿件`;
    log(`[直播直传] ${reason}; archived old state to ${archived}, starting a new submission`);
    return alert ? msg : "";
  };
  const state = readLivePumpState(path);
  if (!state) return archive("无法读取或已损坏", true) || undefined;
  if (state.room !== room) return archive(`房间不匹配(${state.room})`, true) || undefined;
  const unconfirmed = !!state.pending || state.parts.some((p) => !p.confirmed);
  let lastActivity = state.updatedAt;
  if (typeof lastActivity !== "number" || !Number.isFinite(lastActivity) || lastActivity <= 0) {
    if (unconfirmed) return archive("缺少最后活动时间且有未确认分 P,无法判断是否同一场", true) || undefined;
    try { lastActivity = statSync(path).mtimeMs; } catch { return archive("无法读取文件时间", true) || undefined; }
  }
  if (isSameBroadcastGap(nowMs - lastActivity)) return undefined;
  const reason = `距最后活动 ${Math.round((nowMs - lastActivity) / 60_000)} 分钟,超过同场间隔`;
  return archive(reason, unconfirmed) || undefined;
}

/**
 * False when the orphan-spool sweep must be skipped: the live state or an archived state exists
 * but cannot be read, so the spool files it references are unknown and deleting "unreferenced"
 * files could destroy the only copy of an unconfirmed part.
 */
export function spoolSweepSafe(spoolDir: string, room: string): boolean {
  const live = livePumpStatePath(spoolDir, room);
  if (existsSync(live) && !readLivePumpState(live)) return false;
  const base = basename(live) + ARCHIVED_SUFFIX;
  try {
    for (const f of readdirSync(spoolDir)) {
      if (f.startsWith(base) && !readLivePumpState(join(spoolDir, f))) return false;
    }
  } catch { /* spool dir missing: nothing to protect */ }
  return true;
}

/** Spool paths still referenced by archived (rolled-over) states; the orphan sweep must keep them. */
export function archivedSpoolPathsToKeep(spoolDir: string, room: string): string[] {
  const base = basename(livePumpStatePath(spoolDir, room)) + ARCHIVED_SUFFIX;
  const out: string[] = [];
  try {
    for (const f of readdirSync(spoolDir)) {
      if (f.startsWith(base)) out.push(...spoolPathsToKeep(readLivePumpState(join(spoolDir, f))));
    }
  } catch { /* spool dir missing: nothing archived */ }
  return out;
}

/**
 * Which directory a zero-disk run must use (issue #360).
 *
 * Sticky rule, same as the stage resolver: a broadcast whose state already lives in the legacy
 * root keeps writing there until that broadcast ends, so an upgrade never moves a session (or
 * its unconfirmed WAL and spools) underneath a running archive. Only a room with no legacy
 * state moves to the room directory. No file is ever moved: the legacy path stays authoritative
 * for its own broadcast, which removes the whole class of half-migration data loss.
 */
export function resolvePumpDir(
  roomDir: string,
  legacyDir: string,
  room: string,
  nowMs: number = Date.now(),
): string {
  if (roomDir === legacyDir) return legacyDir;
  const legacyPath = livePumpStatePath(legacyDir, room);
  if (!existsSync(legacyPath)) return roomDir;
  const legacy = readLivePumpState(legacyPath);
  // An unreadable root state may hold an unconfirmed WAL: keep it where rolloverStaleState can
  // archive it and raise the "needs a human" alert, exactly as the legacy layout did.
  if (!legacy) return legacyDir;
  // Only an ACTIVE broadcast stays at the root: an unconfirmed part (its WAL is still needed) or
  // a last activity inside the same-broadcast window. Anything older is a finished broadcast;
  // keeping it at the root forever would mean upgraded rooms never reach the room directory.
  if (legacy.pending || legacy.parts.some((p) => !p?.confirmed)) return legacyDir;
  // A missing/corrupt timestamp cannot prove the broadcast ended; the legacy rollover falls back
  // to file mtime, so stay at the root and let that same rule decide instead of splitting the
  // session into a second archive.
  if (typeof legacy.updatedAt !== "number" || !Number.isFinite(legacy.updatedAt)) return legacyDir;
  return isSameBroadcastGap(nowMs - legacy.updatedAt) ? legacyDir : roomDir;
}

export interface LivePumpSessionOpts {
  cookiesPath: string;
  room: string;
  spoolDir: string;
  title: string;
  tid: number;
  tag: string;
  /** Archive description from hub rules (optional; empty when not configured). */
  desc?: string;
  private?: boolean;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Delete the spool only after the part is confirmed in the archive. Default true. */
  cleanupConfirmedSpool?: boolean;
  /** Sleep seam for rate-limit backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** First cooldown for submission rate limits (default 60s). */
  rateLimitBaseMs?: number;
  /** Max submit attempts including the first one (default 5). */
  rateLimitAttempts?: number;
  /** UPOS upload line used when resubmitting a whole spool file. */
  line?: string;
  /** Chunk progress observer for resubmission. */
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  /** Readability/duration probe for a recovered spool (default ffprobe); same gate as a freshly recorded part. */
  probeDuration?: (path: string) => Promise<number>;
  /** dts-gap scan for a recovered spool (default ffprobe); same gate as a freshly recorded part. */
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  /** Optional Bilibili season section id; added after the first successful create. */
  seasonSectionId?: number;
  /** Display-only run timeline sink; errors are swallowed. */
  reporter?: LivePumpReporter;
  /** Error-level alert channel (same notifier as the other zero-disk alerts). Fired at most once per start. */
  onAlert?: (message: string) => void;
  /**
   * Shared account accounting for archive submissions (issue #331). Zero-disk submits (create/append)
   * count against the same per-account window as every other upload on the node, and a rate-limit hit
   * cools that account for everyone. Both hooks are synchronous and non-blocking on purpose: the part
   * is already uploaded and recording continues, so waiting out a 30-minute cooldown here would lose
   * live video. Errors thrown by the hooks are swallowed.
   */
  submitGate?: SubmitGate;
}

/** See {@link LivePumpSessionOpts.submitGate}. */
export interface SubmitGate {
  /** Called before each submit attempt; record the submission in the shared window. */
  noteSubmit(): void;
  /** Called when Bilibili answered with a submission rate limit; cool the shared account. */
  noteRateLimited(): void;
}

/**
 * Durable single-archive uploader.
 *
 * The first completed part creates the archive immediately. Every later completed part is
 * appended to that same archive before recording continues. State is fsynced before and after
 * each irreversible request so a restart can recover instead of creating a second archive.
 */
export class LivePumpSession {
  private readonly statePath: string;
  private state: LivePumpState;
  private readonly log: (msg: string) => void;
  private stateUntrusted = false;
  private seasonTail: Promise<void> = Promise.resolve();
  private seasonWriteFails = false;
  private readonly resumed: boolean;

  constructor(private readonly o: LivePumpSessionOpts) {
    mkdirSync(o.spoolDir, { recursive: true });
    this.log = o.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.statePath = livePumpStatePath(o.spoolDir, o.room);
    const rolloverAlert = rolloverStaleState(this.statePath, o.room, Date.now(), this.log);
    if (rolloverAlert) o.onAlert?.(rolloverAlert);
    const loaded = readLivePumpState(this.statePath);
    this.resumed = !!loaded;
    if (loaded && loaded.room !== o.room) {
      throw new Error(`live-pump state room mismatch: ${loaded.room} != ${o.room}`);
    }
    this.state = loaded ?? {
      schemaVersion: 1,
      room: o.room,
      createdAt: Date.now(),
      title: o.title,
      tid: o.tid,
      tag: o.tag,
      ...(o.desc ? { desc: o.desc } : {}),
      private: o.private !== false,
      parts: [],
      updatedAt: Date.now(),
    };
    if (loaded) {
      // A resumed session belongs to the archive created by the original title. Keep that
      // identity, but record the caller's current options for diagnostics.
      this.log(`[直播直传] resumed state ${this.statePath} (${loaded.parts.length} parts, title=${loaded.title})`);
    }
  }

  get bvid(): string | undefined { return this.state.bvid; }
  /** Archive identity for the run timeline; `resumed` distinguishes run_resume from run_start. */
  get sessionInfo(): { sessionId: string; createdAt: number; resumed: boolean } {
    return { sessionId: `${this.state.room}:${this.state.createdAt}`, createdAt: this.state.createdAt, resumed: this.resumed };
  }
  get aid(): number | undefined { return this.state.aid; }
  get parts(): LivePumpState["parts"] { return [...this.state.parts]; }
  /** True when any recorded part is still unconfirmed or an irreversible request is pending. */
  get hasUnconfirmed(): boolean {
    return !!this.state.pending || this.state.parts.some((p) => !p.confirmed);
  }
  /** Archive identity as persisted; used to reject starting a fresh archive by accident. */
  get roomKey(): string { return this.state.room; }
  /** Archive title persisted with this session (not the current CLI argument). */
  get archiveTitle(): string { return this.state.title; }
  /** First unused part index; confirmed and unconfirmed rows both reserve their index. */
  get nextPartIndex(): number {
    return this.state.parts.reduce((m, p) => Math.max(m, p.index + 1), 0);
  }
  /** True once the archive exists or a part/pending upload has been recorded. */
  get hasArchiveIdentity(): boolean {
    return !!this.state.bvid || !!this.state.aid || this.state.parts.length > 0 || !!this.state.pending;
  }

  /** Update the title only while the archive is still fresh; resumed identities stay stable. */
  setTitleIfFresh(title: string): boolean {
    if (this.hasArchiveIdentity || !title.trim()) return false;
    this.state = { ...this.state, title };
    return true;
  }

  /** Persisted state snapshot (diagnostics and tests). */
  snapshot(): LivePumpState { return JSON.parse(JSON.stringify(this.state)) as LivePumpState; }

  /** The unconfirmed part that must be settled first: parts are submitted strictly in index order. */
  private lowestUnconfirmed(): LivePumpState["parts"][number] | undefined {
    let best: LivePumpState["parts"][number] | undefined;
    for (const p of this.state.parts) if (!p.confirmed && (!best || p.index < best.index)) best = p;
    return best;
  }

  /**
   * Re-submit every unconfirmed part in index order (a failed part can leave later, already-cut
   * parts behind it). Stops at the first failure: a later part must never be submitted past an
   * unconfirmed earlier one.
   *
   * A part held by the dts-gap gate is the one exception: like on the normal path it never enters
   * the archive, its spool is kept as `.held-gap` and a loud alert is raised. Its row is dropped,
   * so it does not block the parts after it (the archive only needs the remaining parts in order;
   * the held part is a known, reported hole, never a silent one).
   */
  async resubmitAllUnconfirmed(signal?: AbortSignal): Promise<{ ok: boolean; bvid?: string; aid?: number; error?: string; held?: number[] }> {
    let last: { ok: boolean; bvid?: string; aid?: number; error?: string } = { ok: true, bvid: this.state.bvid, aid: this.state.aid };
    const held: number[] = [];
    while (this.lowestUnconfirmed()) {
      const before = this.lowestUnconfirmed()!.index;
      const r = await this.resubmitUnconfirmedPart(signal);
      if (r.held) { held.push(before); continue; }
      last = { ok: r.ok, bvid: r.bvid, aid: r.aid, error: r.error };
      if (!r.ok) return { ...last, ...(held.length ? { held } : {}) };
    }
    return { ...last, ...(held.length ? { held } : {}) };
  }

  /** Drop a part's row (a held part that will never enter the archive). Persists. */
  dropPart(index: number): void {
    if (!this.state.parts.some((p) => p.index === index)) return;
    this.state = { ...this.state, parts: this.state.parts.filter((p) => p.index !== index) };
    try { this.persist(); } catch { /* the caller already reports the held part */ }
  }

  /**
   * Re-submit an unconfirmed part whose bytes are still on disk.
   *
   * Recovery deliberately refuses to guess: a part that is not on the archive may have failed
   * before `complete()`, after `complete()` (only `edit` failed, e.g. submission throttling), or
   * never reached the archive at all. The first two cases are safe and recoverable here because
   * the spool file is still intact: upload it as a whole file, then append it with the same stem
   * check. Callers must only invoke this when no other part is pending; a missing archive identity
   * is safe for the first unconfirmed part because `submitPart` then creates the archive path.
   */
  async resubmitUnconfirmedPart(signal?: AbortSignal): Promise<{ ok: boolean; bvid?: string; aid?: number; error?: string; held?: boolean }> {
    if (this.stateUntrusted) return { ok: false, error: "state sidecar is untrusted" };
    if (this.state.pending) return { ok: false, error: "another submit is pending" };
    const target = this.lowestUnconfirmed();
    if (!target) return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
    const doFetch = this.o.fetchImpl ?? fetch;
    let bytes = 0;
    try { bytes = statSync(target.spoolPath).size; } catch {
      if (existsSync(heldGapPath(target.spoolPath))) {
        // A crash between renaming a gap spool and dropping its row: the part is already held.
        const msg = `分 P ${target.index} 已因时间戳跳变扣留(${heldGapPath(target.spoolPath)}),稿件缺少这一 P,需人工处理`;
        this.log(`[直播直传] ⚠️ ${msg}`);
        try { this.o.onAlert?.(msg); } catch { /* alert channel must not break recovery */ }
        this.dropPart(target.index);
        return { ok: false, held: true, error: msg };
      }
      return { ok: false, error: `spool missing for unconfirmed part ${target.index}: ${target.spoolPath}` };
    }
    if (bytes <= 0) return { ok: false, error: `spool empty for unconfirmed part ${target.index}` };
    // Same gate as a freshly recorded part: a spool can reach the recovery state without ever being
    // probed (written when a stop cut its finalize short, or behind a failed part).
    let durationSec = 0;
    try { durationSec = await (this.o.probeDuration ?? ffprobeDuration)(target.spoolPath); } catch { durationSec = 0; }
    if (!(durationSec > 0)) {
      // By design this blocks the room: an unreadable spool is not a known gap, so dropping its row
      // would silently lose the only copy (and the next parts must not pass an unconfirmed one).
      // Manual fix: repair or delete the spool and remove its row from the state file (plans/043).
      return { ok: false, error: `spool of part ${target.index} is not readable (no duration), not resubmitting: ${target.spoolPath}` };
    }
    let gap: DtsGap | null | undefined;
    try { gap = await (this.o.scanDtsGap ?? defaultScanDtsGap)(target.spoolPath); } catch { gap = undefined; }
    if (gap) {
      const heldPath = heldGapPath(target.spoolPath);
      const why = `分 P ${target.index} 时间戳跳变(流${gap.streamIndex}: ${gap.fromSec.toFixed(1)}s → ${gap.toSec.toFixed(1)}s),不投稿`;
      // Drop the row BEFORE renaming: a crash in between then leaves a stray `.held-gap` file, never a
      // row pointing at a missing spool. If the rename fails the row goes back (the orphan sweep keeps
      // what the state references, so the only copy survives) and the room waits for a human.
      const row = this.state.parts.find((x) => x.index === target.index)!;
      this.dropPart(target.index);
      try {
        renameSync(target.spoolPath, heldPath);
      } catch (e) {
        this.state = { ...this.state, parts: [...this.state.parts, row].sort((a, b) => a.index - b.index) };
        try { this.persist(); } catch { /* the alert below carries the situation */ }
        const msg = `${why},但 spool 无法改名扣留(${String((e as Error)?.message ?? e).slice(0, 120)}),保留在恢复状态,需人工处理: ${target.spoolPath}`;
        this.log(`[直播直传] ⚠️ ${msg}`);
        try { this.o.onAlert?.(msg); } catch { /* alert channel must not break recovery */ }
        return { ok: false, error: msg };
      }
      const msg = `${why},spool 保留为 ${heldPath};稿件缺少这一 P,需人工处理`;
      this.log(`[直播直传] ⚠️ ${msg}`);
      try { this.o.onAlert?.(msg); } catch { /* alert channel must not break recovery */ }
      return { ok: false, held: true, error: msg };
    }
    this.log(`[直播直传] 分 P ${target.index} 未确认,按整文件重传补齐(${target.spoolPath})`);
    const fb = await reuploadSpoolFile({
      cookiesPath: this.o.cookiesPath,
      fileName: target.filename,
      spoolPath: target.spoolPath,
      line: this.o.line ?? "txa",
      fetchImpl: doFetch,
      onChunk: this.o.onChunk,
      log: this.log,
      ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!fb.ok || !fb.stem) {
      return { ok: false, error: `resubmit upload failed: ${fb.error ?? "no stem"}` };
    }
    if (signal?.aborted) return { ok: false, error: "resubmit aborted" };
    const submitted = await this.submitPart({
      index: target.index,
      spoolPath: target.spoolPath,
      stem: fb.stem,
      title: target.title,
      bytes: fb.bytes,
      durationSec,
    }, signal);
    if (!submitted.ok) return { ok: false, error: submitted.error };
    return { ok: true, bvid: submitted.bvid, aid: submitted.aid };
  }

  /**
   * Persist bytes that reached disk but never reached an archive response.
   *
   * The orphan-spool sweep only trusts `spoolPathsToKeep`, so returning an upload error without
   * this write can delete the only recoverable copy after the grace period. An empty stem is
   * intentional: restart recovery re-uploads the whole file and obtains a fresh UPOS stem before
   * submitting it. The create path is allowed here because no archive identity means the first
   * submit never succeeded.
   */
  noteUnconfirmedPart(input: {
    index: number;
    spoolPath: string;
    title: string;
    bytes: number;
    durationSec: number;
    stem?: string;
  }): { ok: boolean; error?: string } {
    if (this.stateUntrusted) return { ok: false, error: "state sidecar is untrusted" };
    // A pending request belongs to one part; recording a different part's bytes does not conflict
    // with it (recovery settles the pending request first, then resubmits parts in index order).
    if (this.state.pending && this.state.pending.partIndex === input.index) return { ok: false, error: "another submit is pending" };
    const existing = this.state.parts.find((p) => p.index === input.index);
    if (existing?.confirmed) return { ok: true };
    const part = {
      index: input.index,
      spoolPath: input.spoolPath,
      filename: basename(input.spoolPath),
      stem: input.stem ?? "",
      title: input.title,
      bytes: input.bytes,
      durationSec: input.durationSec,
      confirmed: false,
    };
    this.state = {
      ...this.state,
      parts: existing
        ? this.state.parts.map((p) => p.index === input.index ? part : p)
        : [...this.state.parts, part],
    };
    try {
      this.persist();
    } catch (e) {
      return { ok: false, error: `cannot persist unconfirmed part: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    return { ok: true };
  }

  private persist(opts?: { seasonOnly?: boolean }): void {
    try {
      writeLivePumpState(this.statePath, this.state);
    } catch (e) {
      // Only authoritative upload state fails closed. The season field is metadata: losing it must
      // never make confirmed parts untrusted and refuse the next part.
      if (!opts?.seasonOnly) this.stateUntrusted = true;
      throw e;
    }
  }

  /**
   * Reconcile a crash left in `pending`. A create intent without a BV is resolved by exact
   * title lookup; an append intent is resolved by checking whether the stem is already present.
   * Ambiguous outcomes stay pending and are reported, never retried blindly.
   */
  async recover(): Promise<{ ok: boolean; reason?: string; archiveExists?: boolean }> {
    const p = this.state.pending;
    if (!p) return { ok: true };
    const reportRecovered = (): void => {
      try { this.o.reporter?.event({ at: Date.now(), kind: "recovered", part: p.partIndex }); } catch { /* observability */ }
    };
    const doFetch = this.o.fetchImpl ?? fetch;
    const markPending = (confirmed: boolean): void => {
      const existing = this.state.parts.find((x) => x.index === p.partIndex);
      const part = {
        index: p.partIndex, spoolPath: p.spoolPath, filename: basename(p.spoolPath),
        stem: p.stem, title: p.title, bytes: p.bytes, durationSec: p.durationSec,
        confirmed,
      };
      this.state = {
        ...this.state,
        parts: existing
          ? this.state.parts.map((x) => x.index === p.partIndex ? { ...x, confirmed, ...(p.stem ? { stem: p.stem } : {}) } : x)
          : [...this.state.parts, part],
        pending: undefined,
      };
    };
    if (p.kind === "create" && !this.state.bvid && !this.state.aid) {
      let found;
      try {
        found = await findArchiveByTitle({
          cookiesPath: this.o.cookiesPath,
          title: this.state.title,
          fetchImpl: doFetch,
        });
      } catch (e) {
        return { ok: false, reason: `cannot search archive during recovery: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
      }
      if (found.searched === false) {
        return { ok: false, reason: "cannot search archive during recovery; needs manual verification" };
      }
      if (found.searched === true && found.matches === 0) {
        // The list was readable and no archive with this title exists. The create request
        // certainly did not produce a draft, so the caller may safely retry create.
        this.state = { ...this.state, pending: undefined };
        try {
          this.persist();
        } catch (e) {
          return { ok: false, reason: `create did not happen but cannot persist recovery: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
        }
        reportRecovered();
        return { ok: true };
      }
      if (!found.ok || !found.archive) {
        return { ok: false, reason: `create outcome ambiguous (matches=${found.matches}); needs manual verification` };
      }
      const confirmed = found.archive.videos.some((v) => v.filename === p.stem);
      if (!confirmed) {
        // The archive exists, but P1 is not present. The submit outcome is still ambiguous:
        // retrying create would duplicate the archive; retrying append would silently drop P1.
        return { ok: false, archiveExists: true, reason: "archive found but first part is not present; needs manual verification" };
      }
      // An archive without a BV cannot be resumed safely: append needs a stable identifier.
      if (!found.archive.bvid && !(found.archive.aid > 0)) {
        return { ok: false, archiveExists: true, reason: "archive found but has no bvid/aid; needs manual verification" };
      }
      this.state = {
        ...this.state,
        ...(found.archive.bvid ? { bvid: found.archive.bvid } : {}),
        ...(found.archive.aid > 0 ? { aid: found.archive.aid } : {}),
      };
      markPending(confirmed);
      try {
        this.persist();
      } catch (e) {
        return { ok: false, archiveExists: true, reason: `recovered archive but cannot persist state: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
      }
      this.cleanupConfirmed();
      reportRecovered();
      return { ok: true };
    }
    if (!this.state.bvid && !this.state.aid) {
      return { ok: false, reason: "pending append without archive identity" };
    }
    let found;
    try {
      found = await lookupArchive({
        cookiesPath: this.o.cookiesPath,
        ...(this.state.bvid ? { bvid: this.state.bvid } : { aid: this.state.aid }),
        fetchImpl: doFetch,
      });
    } catch (e) {
      return { ok: false, reason: `cannot read archive during recovery: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    if (!found.ok || !found.archive) {
      return { ok: false, reason: "cannot read archive during recovery" };
    }
    const confirmed = found.archive.videos.some((v) => v.filename === p.stem);
    this.state = {
      ...this.state,
      bvid: found.archive.bvid ?? this.state.bvid,
      aid: found.archive.aid,
    };
    markPending(confirmed);
    try {
      this.persist();
    } catch (e) {
      return { ok: false, archiveExists: true, reason: `recovered append but cannot persist state: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    this.cleanupConfirmed();
    reportRecovered();
    return { ok: true };
  }

  /** Submit a completed part. Returns only after the archive has acknowledged it. */
  async submitPart(input: {
    index: number;
    spoolPath: string;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
  }, signal?: AbortSignal): Promise<{ ok: boolean; bvid?: string; aid?: number; error?: string }> {
    if (this.stateUntrusted) {
      return { ok: false, error: "state sidecar is untrusted; refusing to submit (manual recovery required)" };
    }
    // Head-of-line blocking: an unconfirmed part (or a pending irreversible request) must be
    // reconciled before any later part is submitted. Otherwise a failed P1 could be misread as
    // "archive exists" and the next part would become P1 of a different archive.
    if (this.state.pending) {
      return { ok: false, error: "previous part outcome is pending; run recover() before submitting more parts" };
    }
    const unconfirmed = this.lowestUnconfirmed();
    if (unconfirmed && unconfirmed.index !== input.index) {
      return { ok: false, error: `part ${unconfirmed.index} is not confirmed; refusing to submit part ${input.index}` };
    }
    const existing = this.state.parts.find((p) => p.index === input.index);
    if (existing?.confirmed) return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
    const doFetch = this.o.fetchImpl ?? fetch;
    // Bilibili part titles are capped; long filenames otherwise make the whole edit fail.
    const video: StudioVideo = { filename: input.stem, title: input.title.slice(0, 80) };
    const pending: LivePumpState["pending"] = {
      kind: this.state.bvid || this.state.aid ? "append" : "create",
      partIndex: input.index,
      stem: input.stem,
      title: input.title,
      bytes: input.bytes,
      durationSec: input.durationSec,
      spoolPath: input.spoolPath,
    };
    this.state = { ...this.state, pending };
    try {
      this.persist();
    } catch (e) {
      return { ok: false, error: `cannot persist upload intent: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }

    const result = await this.submitWithRateLimitRetry(pending, video, doFetch, signal);
    if (!result.ok) return { ok: false, error: result.error };
    this.state = {
      ...this.state,
      bvid: result.bvid ?? this.state.bvid,
      aid: result.aid ?? this.state.aid,
      // P1 create: the season call has NOT run yet. Persist "pending" now so a kill before it
      // completes is reconciled on restart instead of silently skipping the association.
      ...(pending.kind === "create" && this.o.seasonSectionId ? { seasonState: "pending" as const } : {}),
      parts: existing
        ? this.state.parts.map((p) => p.index === input.index ? {
          ...p,
          spoolPath: input.spoolPath,
          filename: basename(input.spoolPath),
          stem: input.stem,
          title: input.title,
          bytes: input.bytes,
          durationSec: input.durationSec,
          confirmed: true,
        } : p)
        : [...this.state.parts, {
          index: input.index, spoolPath: input.spoolPath, filename: basename(input.spoolPath),
          stem: input.stem, title: input.title, bytes: input.bytes,
          durationSec: input.durationSec, confirmed: true,
        }],
      pending: undefined,
    };
    if (pending.kind === "create" && this.o.seasonSectionId) {
      try { this.o.reporter?.event({ at: Date.now(), kind: "season_pending", part: input.index }); } catch { /* observability */ }
    }
    try {
      this.persist();
    } catch (e) {
      return { ok: false, error: `cannot persist confirmation: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    noteRecorderProgress(); // a confirmed part is progress for the finalizing stall judge (plans/044)
    this.cleanupConfirmed();
    if (pending.kind === "create" && this.o.seasonSectionId) {
      this.queueSeason(doFetch, false);
    }
    return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
  }

  /**
   * Submit with cooldown on Bilibili submission rate limits (601 / 21566 / 21540).
   *
   * Real run 2026-10-18: consecutive `edit` calls hit `code:21540 请求过于频繁` and the part
   * was treated as a permanent failure — the rest of the broadcast was head-of-line blocked and
   * lost. These codes are per-submission throttling, so the submit did not take effect and a
   * cooled retry is idempotent for append (the stem check makes a duplicate impossible).
   */
  private async submitWithRateLimitRetry(
    pending: NonNullable<LivePumpState["pending"]>,
    video: StudioVideo,
    doFetch: typeof fetch,
    signal?: AbortSignal,
  ): Promise<{ ok: true; bvid?: string; aid?: number } | { ok: false; error: string }> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const baseMs = this.o.rateLimitBaseMs ?? 60_000;
    const maxAttempts = this.o.rateLimitAttempts ?? 5;
    let lastError = "";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try { this.o.submitGate?.noteSubmit(); } catch { /* accounting must never block a submit */ }
      let raw: Record<string, unknown>;
      let ok: boolean;
      let bvid: string | undefined;
      let aid: number | undefined;
      try {
        if (pending.kind === "create") {
          const r = await submitStudio({
            cookiesPath: this.o.cookiesPath,
            title: this.state.title,
            tid: this.state.tid,
            tag: this.state.tag,
            ...(this.state.desc ? { desc: this.state.desc } : {}),
            private: this.state.private,
            videos: [{ filename: video.filename, ...(video.title ? { title: video.title } : {}), ...(video.desc ? { desc: video.desc } : {}) }],
            fetchImpl: doFetch,
          });
          ok = r.ok;
          raw = r.raw;
          bvid = r.bvid;
          aid = r.aid;
        } else {
          const r = await appendStudioPart({
            cookiesPath: this.o.cookiesPath,
            ...(this.state.bvid ? { bvid: this.state.bvid } : { aid: this.state.aid }),
            video,
            fetchImpl: doFetch,
          });
          ok = r.ok;
          raw = r.raw;
          bvid = r.bvid;
          aid = r.aid;
        }
      } catch (e) {
        return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
      }
      if (ok) {
        return { ok: true, ...(bvid ? { bvid } : {}), ...(aid ? { aid } : {}) };
      }
      const detail = `${pending.kind} failed: ${JSON.stringify(raw).slice(0, 300)}`;
      lastError = detail;
      if (!isUploadRateLimited(detail)) return { ok: false, error: detail };
      try { this.o.submitGate?.noteRateLimited(); } catch { /* accounting must never block a submit */ }
      const waitMs = Math.min(baseMs * 2 ** attempt, 300_000);
      this.log(
        `[直播直传] ${pending.kind} 命中投稿限流(${JSON.stringify(raw).slice(0, 120)}),` +
        `${waitMs / 1000}s 后重试(${attempt + 2}/${maxAttempts})`,
      );
      await sleepUnlessAborted(waitMs, [signal], sleep);
      if (signal?.aborted) return { ok: false, error: "submit aborted" };
    }
    return { ok: false, error: `${lastError}(限流重试 ${maxAttempts} 次后仍失败)` };
  }

  /**
   * Best-effort season association AFTER the BV is persisted. Never throws; records the outcome in
   * the state so an interrupted or failed call is visible and can be reconciled on restart.
   */
  private async associateSeason(doFetch: typeof fetch, reconcileFirst: boolean): Promise<void> {
    if (!this.o.seasonSectionId) return;
    if (this.state.seasonState === "done" || this.state.seasonState === "failed") return;
    const outcome = await addArchiveToSeasonIfConfigured({
      cookiesPath: this.o.cookiesPath,
      sectionId: this.o.seasonSectionId,
      ...(this.state.aid ? { aid: this.state.aid } : {}),
      ...(this.state.bvid ? { bvid: this.state.bvid } : {}),
      reconcileFirst,
      fetchImpl: doFetch,
      note: (m) => this.log(m),
    });
    this.state = {
      ...this.state,
      seasonState: seasonCheckpointState(outcome),
      updatedAt: Date.now(),
    };
    try {
      const kind = this.state.seasonState === "done" ? "season_done" : this.state.seasonState === "failed" ? "season_failed" : "season_pending";
      this.o.reporter?.event({ at: Date.now(), kind });
    } catch { /* observability */ }
    try {
      if (this.seasonWriteFails) {
        this.seasonWriteFails = false;
        throw new Error("injected season checkpoint write failure");
      }
      this.persist({ seasonOnly: true });
    } catch (e) {
      this.log(`[直播直传] season 状态落盘失败(保留 pending,不影响后续分 P): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }

  private queueSeason(doFetch: typeof fetch, reconcileFirst: boolean): void {
    if (this.state.seasonState === "done" || this.state.seasonState === "failed") return;
    this.seasonTail = this.seasonTail
      .then(() => this.associateSeason(doFetch, reconcileFirst))
      .catch((e) => {
        this.log(`[直播直传] season association exception (left pending): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      });
  }

  /** Wait for the best-effort season call at a run boundary, never on the part-upload path. */
  drainSeason(): Promise<void> {
    return this.seasonTail;
  }

  /** Test seam: make the next season checkpoint write fail (metadata only, parts still accepted). */
  failSeasonWriteOnce(): void {
    this.seasonWriteFails = true;
  }

  /** Restart hook: retry only an explicit pending checkpoint. */
  async reconcileSeason(fetchImpl?: typeof fetch): Promise<void> {
    if (!this.o.seasonSectionId || this.state.seasonState !== "pending") return;
    await this.associateSeason(fetchImpl ?? this.o.fetchImpl ?? fetch, true);
  }

  private cleanupConfirmed(): void {
    if (this.o.cleanupConfirmedSpool === false) return;
    for (const p of this.state.parts) {
      if (!p.confirmed) continue;
      // Zero-disk parts have no spool; do not claim to have removed one.
      if (!existsSync(p.spoolPath)) continue;
      try {
        rmSync(p.spoolPath, { force: true });
        this.log(`[直播直传] confirmed part ${p.index}, removed spool ${p.spoolPath}`);
      } catch (e) {
        this.log(`[直播直传] confirmed part ${p.index}, spool cleanup failed: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }
}

/** 有界 FIFO:满时 `push` 丢弃并返回 false(背压),`shift` 空且已 close 时返回 undefined。 */
class BoundedQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private readonly capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }
  /** spool-only 模式:永不入队(只落盘),`push` 恒 false。见 {@link SPOOL_ONLY}。 */
  get disabled(): boolean { return this.capacity === SPOOL_ONLY; }
  push(v: T): boolean {
    if (this.disabled) return false; // spool-only:块不入队(调用方据此停止切块)
    if (this.closed || this.items.length >= this.capacity) return false;
    this.items.push(v);
    this.waiters.shift()?.();
    return true;
  }
  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }
  get depth(): number { return this.items.length; }
  async shift(): Promise<T | undefined> {
    while (true) {
      if (this.items.length > 0) return this.items.shift();
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

/** Why a part ended; see {@link SegmentRunResult.sealedBy}. */
type SealedBy = NonNullable<SegmentRunResult["sealedBy"]>;

const NO_EXIT: SegmentExit = { code: null, signal: null, stderrTail: "" };

export interface PartSinkOpts {
  /** Declared upper bound for this part (= the size passed to preupload). */
  sizeCap: number;
  /** Spool path (written synchronously in "full" mode). */
  spoolPath: string;
  /**
   * The UPOS session. May still be in flight (a prefetched preupload): bytes written before it
   * resolves are held in a bounded buffer and replayed, so the stream never waits for it.
   */
  session: PreuploadResult | Promise<PreuploadResult>;
  /** Override the chunk size (default: the session's). */
  chunkSize?: number;
  fetchImpl?: typeof fetch;
  /** Called per uploaded chunk. */
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  /** Queue depth in chunks (default 4). {@link SPOOL_ONLY} = spool only. */
  queueCapacity?: number;
  /**
   * "full" (default): mirror every byte into the spool (whole-file fallback, dts scan).
   * "none": true zero-disk; nothing is written.
   */
  spoolMode?: "full" | "none";
  /** Backpressure callback: upload fell behind and the part degraded to spool-only (called once). */
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  /**
   * Streaming degraded (chunk PUT failed / queue overflowed / session late): called once, the
   * moment it happens, so the caller can log + alert immediately instead of waiting for the
   * part summary (which may be many minutes later, and loses the reason after a fallback).
   */
  onDegrade?: (reason: string) => void;
  /**
   * Called once, at the first byte that arrives while the session is still not ready (a late or
   * rate-limited preupload). `lossy` = true in zero-disk mode, where the bounded buffer is all
   * that stands between those bytes and losing the part.
   */
  onSessionLate?: (info: { lossy: boolean; bufferLimitBytes: number }) => void;
  /**
   * Called when a part stopped waiting for its session: full mode falls back to a whole-file upload,
   * zero-disk (`lossy`) lost the part. Either way the pending preupload should be cancelled.
   */
  onSessionAbandoned?: (info: { lossy: boolean }) => void;
  /** Aborts this part's upload (the part being recorded when a stop arrives). */
  signal?: AbortSignal;
}

/** Upload-side outcome of one part, available once the part is sealed and its upload settled. */
export interface PartSinkResult {
  /** The session the part was uploaded to; absent when preupload itself failed. */
  session?: PreuploadResult;
  chunksUploaded: number;
  streamedBytes: number;
  spooledBytes: number;
  uploadError?: string;
  /** Why streaming degraded; see {@link PartSinkOpts.onDegrade}. Survives a successful fallback. */
  degradedReason?: string;
  sessionLeaked: boolean;
  backpressured: boolean;
}

/**
 * One part's upload side: an UPOS session + bounded chunk queue + optional spool file.
 *
 * `write()` takes the part's bytes in order; `seal()` ends the part (tail chunk, queue close) and
 * `finished` settles when the upload task has. The tail/`totalSizeOfNow` semantics are exactly the
 * ones the one-ffmpeg-per-part code had: the uploader asks for "the real total" before sizing a
 * chunk, so the tail must be queued before it reads again (a wrong tail length silently drops the
 * last seconds of a part).
 *
 * Nothing here throws on a bad upload: failures land in `uploadError`, the spool stays complete,
 * and the caller falls back to a whole-file re-upload (full mode) or reports the part lost (none).
 */
export class PartSink {
  readonly finished: Promise<PartSinkResult>;
  readonly spoolPath: string;
  private readonly fd: number | undefined;
  private readonly queue: BoundedQueue<Uint8Array>;
  private readonly spoolOnly: boolean;
  private readonly waitingLimit: number;
  private session: PreuploadResult | undefined;
  private chunkSize = 0;
  private ready = false;
  /** Bytes written before the session was known (bounded by {@link waitingLimit}). */
  private waiting: Buffer[] = [];
  private waitingBytes = 0;
  /** Residue shorter than a chunk; kept as a list so it is concatenated once per chunk, not per read. */
  private carryList: Buffer[] = [];
  private carryLen = 0;
  private spooled = 0;
  private queuedChunks = 0;
  /** Full chunks queued (the tail is not counted). */
  private fullChunks = 0;
  private tailLen = 0;
  private chunksUploaded = 0;
  private streamed = 0;
  private uploadError: string | undefined;
  private overflow = false;
  /** Full mode: the session was late and the buffer filled; the spool is the only copy to upload. */
  private lateDegraded = false;
  private lateNotified = false;
  /** Why streaming degraded (first reason wins); survives a successful whole-file fallback. */
  private degradedReason: string | undefined;
  private degradedNotified = false;
  /** Set by fail()/discard(): the part already failed for a non-upload reason, so the uploader's
   *  end-of-queue error is expected bookkeeping, not a degradation. */
  private nonUploadFail = false;
  /** Zero-disk: the wait buffer overflowed before the session arrived; the part is lost, do not wait for it. */
  private waitAbandoned = false;
  private sealed = false;
  private uploadTask: Promise<void> = Promise.resolve();
  private markSettled!: () => void;
  private markSealed!: () => void;
  private readonly settledP: Promise<void>;
  private readonly sealedP: Promise<void>;

  constructor(private readonly o: PartSinkOpts) {
    this.spoolPath = o.spoolPath;
    mkdirSync(dirname(o.spoolPath), { recursive: true });
    // spoolMode "none" = true zero-disk: no file at all (not even a zero-length placeholder).
    this.fd = (o.spoolMode ?? "full") === "full" ? openSync(o.spoolPath, "w") : undefined;
    const capacity = o.queueCapacity ?? 4;
    this.queue = new BoundedQueue<Uint8Array>(capacity);
    this.spoolOnly = this.queue.disabled;
    this.waitingLimit = capacity * CHUNK_UNIT;
    this.settledP = new Promise<void>((r) => { this.markSettled = r; });
    this.sealedP = new Promise<void>((r) => { this.markSealed = r; });
    const s = o.session;
    if (typeof (s as Promise<PreuploadResult>).then === "function") {
      (s as Promise<PreuploadResult>).then((v) => this.attach(v), (e: unknown) => this.sessionFailed(e));
    } else {
      this.attach(s as PreuploadResult);
    }
    this.finished = this.finish();
  }

  get spooledBytes(): number { return this.spooled; }

  /** Record a failure that is not an upload error (e.g. a stdout read error) so the part is not submitted. */
  fail(message: string): void {
    this.nonUploadFail = true;
    this.uploadError ??= message;
  }

  /** Remember the first degradation reason and forward it exactly once, at the moment it happens. */
  private degrade(reason: string): void {
    this.degradedReason ??= reason;
    if (this.degradedNotified) return;
    this.degradedNotified = true;
    this.o.onDegrade?.(reason);
  }

  /** Append the part's next bytes. Never throws for upload reasons; spool write errors do throw. */
  write(buf: Buffer): void {
    if (this.sealed) throw new Error("PartSink: write after seal");
    if (this.fd !== undefined) writeSync(this.fd, buf);
    this.spooled += buf.length;
    if (this.spooled > this.o.sizeCap) {
      // The cutter bounds every part to the declared size; reaching this is a bug, and a part
      // larger than what was declared to UPOS must not be completed as if it were fine.
      this.uploadError ??= `分 P 超出声明大小 ${this.o.sizeCap}B(${this.spooled}B)`;
    }
    if (this.uploadError || this.overflow) return;
    if (!this.ready) {
      if (!this.lateNotified) {
        this.lateNotified = true;
        this.o.onSessionLate?.({ lossy: (this.o.spoolMode ?? "full") === "none", bufferLimitBytes: this.waitingLimit });
      }
      this.waiting.push(buf);
      this.waitingBytes += buf.length;
      if (this.waitingBytes > this.waitingLimit) {
        // Full mode: the spool already holds every byte, so a slow session is not backpressure; the
        // part falls back to a whole-file upload (with the same 601 backoff). Zero-disk has no
        // spool: running out of buffer here is real data loss and is reported as backpressure.
        if (this.fd !== undefined) this.degradeLate();
        else {
          // Zero-disk late session: the cause is the missing session, not a slow uploader — the
          // part is lost, say exactly that instead of a queue-full line with a wrong chunk count.
          this.overflowNow(`下一分 P 的上传会话未及时就绪,零落盘等待缓冲已满(${Math.round(this.waitingLimit / MiB)}MiB),该分 P 丢失`);
          this.waitAbandoned = true;
        }
      }
      return;
    }
    this.feed(buf);
  }

  /** No more bytes: queue the tail, close the queue, close the spool. Idempotent. */
  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.closeSpool();
    if (this.ready) this.closeQueue();
    this.markSealed();
  }

  /** Drop a part that holds nothing worth uploading (a head-only tail after the last cut). */
  discard(): void {
    this.nonUploadFail = true;
    this.uploadError ??= "discarded";
    this.seal();
    this.queue.close();
    if (this.fd !== undefined) {
      try { rmSync(this.o.spoolPath, { force: true }); } catch { /* best effort */ }
    }
  }

  private closeSpool(): void {
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { /* already closed */ }
  }

  private closeQueue(): void {
    this.pushTail();
    this.queue.close();
  }

  private attach(session: PreuploadResult): void {
    this.session = session;
    this.chunkSize = this.o.chunkSize ?? session.bucket.chunkSize;
    this.ready = true;
    if (this.lateDegraded) {
      // Too late: the early bytes only exist in the spool. Use the whole-file path instead.
      this.markSettled();
      return;
    }
    if (!this.spoolOnly) this.uploadTask = this.startUpload(session);
    const held = this.waiting;
    this.waiting = [];
    this.waitingBytes = 0;
    for (const b of held) this.feed(b);
    if (this.sealed) this.closeQueue();
    this.markSettled();
  }

  private sessionFailed(e: unknown): void {
    const why = `preupload 失败: ${String((e as Error)?.message ?? e).slice(0, 200)}`;
    this.uploadError ??= why;
    // Same immediate-report rule as the other degradations — but a stop aborting the pending
    // preupload is the stop paths' business, not a degradation.
    if (!this.nonUploadFail && !this.o.signal?.aborted && (e as Error)?.name !== "AbortError") this.degrade(why);
    this.waiting = [];
    this.waitingBytes = 0;
    this.markSettled();
  }

  private degradeLate(): void {
    this.lateDegraded = true;
    this.overflow = true;
    this.waiting = [];
    this.waitingBytes = 0;
    // Same moment rule as the other degradations: say why now, not when the summary runs.
    this.degrade(`下一分 P 的上传会话未及时就绪,等待缓冲已满(${Math.round(this.waitingLimit / MiB)}MiB),按整文件回退上传`);
  }

  private overflowNow(reason?: string): void {
    this.overflow = true;
    this.waiting = [];
    this.waitingBytes = 0;
    this.carryList = [];
    this.carryLen = 0;
    // Backpressure must be explicit: silent degradation turns "streaming upload" into "disk only".
    this.o.onBackpressure?.(this.spooled, this.queuedChunks);
    this.degrade(reason ?? (this.fd !== undefined
      ? `上传跟不上录制,队列已满(${this.queuedChunks} 块),本段降级为纯落盘`
      : `上传跟不上录制,队列已满(${this.queuedChunks} 块),零落盘无本地副本,该分 P 丢失`));
  }

  /** Slice residue into full chunks and queue them; a full queue means the uploader fell behind. */
  private feed(buf: Buffer): void {
    if (this.uploadError || this.overflow) return;
    this.carryList.push(buf);
    this.carryLen += buf.length;
    if (this.carryLen < this.chunkSize) return;
    const all = this.carryList.length === 1 ? this.carryList[0]! : Buffer.concat(this.carryList, this.carryLen);
    let off = 0;
    while (all.length - off >= this.chunkSize) {
      const chunk = Buffer.from(all.subarray(off, off + this.chunkSize));
      if (!this.queue.push(chunk)) {
        this.overflowNow();
        return;
      }
      off += this.chunkSize;
      this.queuedChunks++;
      this.fullChunks++;
    }
    const rest = all.subarray(off);
    this.carryList = rest.length ? [Buffer.from(rest)] : [];
    this.carryLen = rest.length;
  }

  /**
   * Queue the residue as the tail chunk. MUST happen before the uploader reads again (see class
   * doc). Idempotent: a second call is a no-op because `tailLen` is already set.
   */
  private pushTail(): void {
    if (this.uploadError || this.overflow || this.carryLen === 0 || this.tailLen > 0) return;
    const tail = Buffer.concat(this.carryList, this.carryLen);
    this.carryList = [];
    this.carryLen = 0;
    if (this.spoolOnly) return;
    if (!this.queue.push(tail)) {
      // No room for the tail: it can neither be uploaded nor silently dropped.
      this.overflowNow();
      return;
    }
    this.queuedChunks++;
    this.tailLen = tail.length;
  }

  /**
   * The part's real size: exact once sealed (full chunks + tail), the declared bound before that.
   * The uploader sizes its next chunk and its stop point from this.
   */
  private totalSizeNow(): number {
    return this.tailLen > 0 || (this.sealed && this.fullChunks > 0)
      ? this.fullChunks * this.chunkSize + this.tailLen
      : this.o.sizeCap;
  }

  /** True when the part ended with data and nothing was lost to backpressure or errors. */
  private sealedWithData(): boolean {
    return this.sealed && !this.overflow && (this.fullChunks > 0 || this.tailLen > 0);
  }

  private startUpload(session: PreuploadResult): Promise<void> {
    const o = this.o;
    return uploadChunks({
      session,
      // `totalSize` stays the declared upper bound; `totalSizeOf` tells the uploader the real
      // amount, so the tail length is not always computed as a full chunk.
      totalSize: o.sizeCap,
      totalSizeOf: () => this.totalSizeNow(),
      fetchImpl: o.fetchImpl ?? fetch,
      retries: 3,
      signal: o.signal,
      maxChunks: () => Math.ceil(this.totalSizeNow() / this.chunkSize),
      // The only trusted "chunks uploaded" count: uploadChunks drops its own progress on failure.
      onProgress: (p) => {
        this.chunksUploaded = p.chunksDone;
        this.streamed = p.uploadedBytes;
        o.onChunk?.(p.uploadedBytes, p.chunksDone);
      },
      readChunk: async (index, size) => {
        const chunk = await this.queue.shift();
        if (!chunk) throw new Error(`流比声明的 ${o.sizeCap}B 短:第 ${index} 块(${size}B)没有数据`);
        // Length validation belongs to uploadChunks, which accepts a tail shorter than `size`.
        return chunk;
      },
    }).then(
      () => undefined,
      (e: unknown) => {
        const msg = String((e as Error)?.message ?? e).slice(0, 300);
        // A sealed part with data ends exactly where its queue closes: the uploader asking for
        // one more chunk is the end-of-part signal, not a failure (it would otherwise look like
        // a stream cut short and mark the session leaked).
        if (this.sealedWithData() && /没有数据|流比声明的/.test(msg)) return;
        this.uploadError ??= msg;
        // The chunk failure must be visible the moment it happens (it used to sit silently in
        // uploadError until the part summary — or vanish entirely once the fallback succeeded).
        // A stop aborting the in-flight part is not a degradation: the stop paths report it.
        // Neither is a deliberate drop / non-upload sink failure: the uploader's end-of-queue
        // error is expected bookkeeping then, not a degradation.
        if (this.nonUploadFail || o.signal?.aborted || (e as Error)?.name === "AbortError") return;
        // A part that never received a byte (empty seal on ffmpeg exit / stall-empty) fails the
        // uploader by design; that was silent before and is not a degradation of a real upload.
        if (this.spooled === 0) return;
        // Zero-disk has no local copy: a failed chunk upload loses the part, say so.
        this.degrade(this.o.spoolMode === "none" ? `${msg};零落盘无本地副本,该分 P 丢失` : msg);
      },
    );
  }

  private async finish(): Promise<PartSinkResult> {
    await this.sealedP;
    if (this.lateDegraded || this.waitAbandoned) {
      // Do not wait for a session that may take minutes (rate limit backoff). Full mode: the
      // whole-file fallback does its own preupload. Zero-disk: the bytes are already lost.
      if (this.lateDegraded) this.uploadError ??= "下一分 P 的上传会话未及时就绪,按整文件回退上传";
      this.o.onSessionAbandoned?.({ lossy: this.waitAbandoned });
      this.queue.close();
    } else {
      await this.settledP;
      await this.uploadTask;
    }
    return {
      ...(this.session ? { session: this.session } : {}),
      chunksUploaded: this.chunksUploaded,
      streamedBytes: this.streamed,
      spooledBytes: this.spooled,
      uploadError: this.uploadError,
      ...(this.degradedReason ? { degradedReason: this.degradedReason } : {}),
      // "Half session" = bytes PUT but the part can neither complete nor abort (UPOS has no
      // abort). Size-/duration-sealed parts uploading fewer chunks than the bound are NOT leaks.
      sessionLeaked: this.uploadError != null && this.chunksUploaded > 0,
      backpressured: this.overflow && !this.lateDegraded,
    };
  }
}

/** A part the stream has finished cutting; hand it to {@link finalizeRecordedPart} for complete/submit. */
export interface SealedPart {
  sink: PartSink;
  sealedBy: SealedBy;
  /** Part size in bytes, PAT/PMT head included. */
  bytes: number;
  /** Media time of the part from video PTS; null when no timestamp was seen. */
  timing: PartTiming | null;
  tsDiscontinuities: number;
  /** Wall-clock the part was open (a stall window is excluded). */
  sealedMs: number;
  stalledMs?: number;
  /** Total seconds of forward PTS jumps inside the part (media missing at resume points). */
  ptsJumpSec?: number;
  /** Number of forward PTS jumps inside the part. */
  ptsJumpCount?: number;
  /** True when this part ended the connection (EOF, stall, abort, or stop at a cut). */
  final: boolean;
  /** True when `stopAtCut` ended the connection here (the stream itself was still healthy). */
  stopped?: boolean;
}

export interface RunStreamOpts {
  /** ffmpeg argv ({@link buildPipeFfmpegArgs}). */
  args: string[];
  /** Hard size bound per part (= UPOS-declared size). */
  sizeCap: number;
  /** Duration threshold per part from video PTS; the part ends at the next keyframe once reached. 0/undefined = size only. */
  maxMs?: number;
  /** The first part's sink (the caller already has its session). */
  firstSink: PartSink;
  /** Open the next part's sink at a cut. Must not throw. */
  openNext: () => PartSink;
  /** Diagnostics worth a log line (e.g. an ignored PTS jump). */
  onWarn?: (msg: string) => void;
  /** Called once per part when it reaches `prefetchRatio` of its size/duration threshold. */
  onPrefetch?: () => void;
  /** Fraction of the threshold at which {@link onPrefetch} fires (default 0.8). */
  prefetchRatio?: number;
  /** Evaluated at each cut: true = seal the part, stop ffmpeg, open nothing. */
  stopAtCut?: () => boolean | Promise<boolean>;
  /** A part that ended at a cut while the stream keeps going. */
  onPartSealed: (part: SealedPart) => void;
  signal?: AbortSignal;
  /** Kill ffmpeg after this long without a stdout chunk. Default 60s; 0 disables. */
  stallTimeoutMs?: number;
  /** Test seam: how long to wait for stdout EOF after killing ffmpeg before destroying it. */
  destroyGraceMs?: number;
  /** Test seam: maximum wait for the child close event after killing ffmpeg. */
  exitGraceMs?: number;
}

export interface StreamRunResult {
  exit: SegmentExit;
  /** Why the connection ended. `stopped` = {@link RunStreamOpts.stopAtCut} fired at a cut. */
  endedBy: SealedBy | "stopped";
  /** The part that ended the connection; absent when the tail held nothing worth uploading. */
  finalPart?: SealedPart;
  /** A head-only tail part (right after the last cut) was dropped instead of uploaded. */
  discardedTail: boolean;
  /** The dropped sink, so the caller can forget it. */
  discardedSink?: PartSink;
  stalledMs?: number;
}

/**
 * One ffmpeg for the whole stream connection (plans/043).
 *
 * The old design ran one ffmpeg per part and lost the broadcast for the whole
 * complete/submit/re-acquire/preupload gap at every switch. Here ffmpeg keeps pulling and the
 * {@link TsCutter} ends parts on video keyframes; at a cut the bytes simply start flowing into the
 * next part's sink. ffmpeg only ends on EOF, a stall (no stdout for `stallTimeoutMs`), an abort,
 * or `stopAtCut`.
 *
 * Process handling is unchanged from the per-part code: kill only the ffmpeg child, bounded waits
 * for stdout EOF and for the close event, and a stderr scan for timestamp-discontinuity warnings.
 */
export async function runStream(o: RunStreamOpts): Promise<StreamRunResult> {
  const cutter = new TsCutter({
    maxPartBytes: o.sizeCap,
    ...(o.maxMs && o.maxMs > 0 ? { maxDurationMs: o.maxMs } : {}),
    onPtsJump: (j) => o.onWarn?.(`视频时间戳跳变 ${j.fromSec.toFixed(1)}s → ${j.toSec.toFixed(1)}s,按不连续处理(不计入分 P 时长)`),
  });
  const startedAt = Date.now();
  const spawnNow: SpawnFn = spawnOverride ?? ((cmd, args, opts) => spawn(cmd, args as string[], opts as never) as unknown as ChildProcessLike);
  const proc = spawnNow(FFMPEG, o.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  let stderrPartial = "";
  let tsDisc = 0;
  if (proc.stderr) {
    (proc.stderr as NodeJS.ReadableStream & { setEncoding(e: string): void }).setEncoding("utf-8");
    proc.stderr.on("data", (c: unknown) => {
      const text = String(c);
      stderrTail = (stderrTail + text).slice(-4000);
      // Count per complete line: a warning can be split across two data events.
      stderrPartial += text;
      const nl = stderrPartial.lastIndexOf("\n");
      if (nl >= 0) {
        tsDisc += countTsDiscontinuities(stderrPartial.slice(0, nl));
        stderrPartial = stderrPartial.slice(nl + 1);
      }
    });
  }
  let childClosed = false;
  let killSent = false;
  let stdoutDestroyTimer: NodeJS.Timeout | undefined;
  const armStdoutDestroy = (): void => {
    if (stdoutDestroyTimer) return;
    stdoutDestroyTimer = setTimeout(() => {
      const stdout = proc.stdout;
      const state = stdout as (NodeJS.ReadableStream & { destroyed?: boolean; readableEnded?: boolean }) | null;
      if (!stdout || state?.destroyed || state?.readableEnded) return;
      try { stdout.destroy?.(new Error("live-pump: ffmpeg stdout did not close after kill")); } catch { /* already gone */ }
    }, o.destroyGraceMs ?? 5_000);
    stdoutDestroyTimer.unref?.();
  };
  const exited = new Promise<SegmentExit>((resolve) => {
    proc.on("close", (...a: unknown[]) => {
      childClosed = true;
      // A grandchild can keep the stdout pipe open after ffmpeg itself has reported close.
      // Arm the same bounded fallback here, not only after an explicit kill.
      armStdoutDestroy();
      resolve({ code: (a[0] as number | null) ?? null, signal: (a[1] as NodeJS.Signals | null) ?? null, stderrTail });
    });
  });
  /**
   * Kill only the ffmpeg child. It shares the Node process group, so a group kill would
   * terminate the uploader itself. A grandchild can keep the stdout pipe open even after
   * ffmpeg exits; destroy the stream after a short grace period so the reader cannot stay
   * parked forever.
   */
  const stopChild = (): void => {
    if (killSent) return;
    killSent = true;
    try { proc.kill("SIGKILL"); } catch { /* already exited */ }
    armStdoutDestroy();
  };
  const onAbort = (): void => { stopChild(); };
  if (o.signal) {
    // An already-aborted signal never fires "abort", so check it explicitly — otherwise the
    // ffmpeg spawned above is never killed and outlives the run.
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  }

  let cur = o.firstSink;
  let curStartedAt = startedAt;
  let discBase = 0;
  let prefetched = false;
  let lastDataAt = startedAt;
  let stalled = false;
  let stalledAt = 0;
  let stoppedAtCut = false;
  let readError: string | undefined;
  let finalPart: SealedPart | undefined;
  const stallTimeoutMs = o.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  const stallTimer = stallTimeoutMs > 0
    ? setInterval(() => {
      if (childClosed || o.signal?.aborted || stalled) return;
      if (Date.now() - lastDataAt < stallTimeoutMs) return;
      stalled = true;
      stalledAt = Date.now();
      stopChild();
    }, Math.max(25, Math.min(5_000, Math.floor(stallTimeoutMs / 4))))
    : undefined;

  const sealCurrent = (sealedBy: SealedBy, final: boolean, timing: PartTiming | null, bytes: number): SealedPart => {
    cur.seal();
    const part: SealedPart = {
      sink: cur, sealedBy, bytes, timing, final,
      ...(final && stoppedAtCut ? { stopped: true } : {}),
      tsDiscontinuities: tsDisc - discBase,
      sealedMs: (stalled ? lastDataAt : Date.now()) - curStartedAt,
      ...(final && stalled ? { stalledMs: stalledAt - lastDataAt } : {}),
      ...(timing?.ptsJumpSec ? { ptsJumpSec: timing.ptsJumpSec, ptsJumpCount: timing.ptsJumpCount } : {}),
    };
    discBase = tsDisc;
    return part;
  };
  const apply = async (events: CutterEvent[], finalizing: boolean): Promise<void> => {
    for (const ev of events) {
      if (ev.kind === "data") {
        cur.write(ev.bytes);
        continue;
      }
      const stop = finalizing ? false : !!(await o.stopAtCut?.());
      if (stop) stoppedAtCut = true;
      const part = sealCurrent(ev.reason === "requested" || ev.reason === "duration" ? "duration" : "cap", stop, ev.timing, ev.partBytes);
      if (stop) {
        // Whatever follows the cut (and the stream itself) is dropped on purpose: the run was told
        // to end here (window drain / part limit), and ffmpeg is killed below.
        finalPart = part;
        stopChild();
        return;
      }
      o.onPartSealed(part);
      cur = o.openNext();
      curStartedAt = Date.now();
      prefetched = false;
    }
  };
  const afterPush = (): void => {
    const t = cutter.currentTiming();
    const durMs = t ? t.durationSec * 1000 : 0;
    // A stream whose video carries no PTS has no media clock: fall back to the wall clock so the
    // duration threshold still ends parts (the cut itself still waits for a keyframe).
    if (!t && o.maxMs && o.maxMs > 0 && Date.now() - curStartedAt >= o.maxMs) cutter.requestCut();
    if (prefetched || !o.onPrefetch) return;
    const ratio = o.prefetchRatio ?? 0.8;
    if (cutter.currentPartBytes >= cutter.sizeTriggerBytes * ratio || (o.maxMs && o.maxMs > 0 && durMs >= o.maxMs * ratio)) {
      prefetched = true;
      o.onPrefetch();
    }
  };

  try {
    for await (const data of proc.stdout!) {
      if (o.signal?.aborted) break;
      if (!stalled) lastDataAt = Date.now();
      // stdout may be a Buffer / Uint8Array / string (tests push through a PassThrough).
      const buf = Buffer.isBuffer(data) ? data : typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
      await apply(cutter.push(buf), false);
      if (stoppedAtCut || stalled) break;
      afterPush();
    }
  } catch (e) {
    // Destroying stdout after a watchdog kill is expected to reject the async iterator. Keep
    // real stream errors visible instead of swallowing them.
    if (!stalled && !o.signal?.aborted && !killSent && !childClosed) {
      readError = String((e as Error)?.message ?? e).slice(0, 300);
    }
  } finally {
    if (!stoppedAtCut) {
      // A trailing partial packet still belongs to the stream: never drop bytes.
      try { await apply(cutter.flush(), true); } catch (e) { readError ??= String((e as Error)?.message ?? e).slice(0, 300); }
    }
    o.signal?.removeEventListener("abort", onAbort);
    if (stallTimer) clearInterval(stallTimer);
    if (stdoutDestroyTimer) clearTimeout(stdoutDestroyTimer);
  }

  let endedBy: SealedBy | "stopped" = "stopped";
  let discardedTail = false;
  let discardedSink: PartSink | undefined;
  if (!stoppedAtCut) {
    // An abort that lands before any data (or right at EOF) never reaches the in-loop check,
    // so classify it here. Callers rely on "abort" to tell "stopped on purpose" from "stream
    // ended" — mislabelling it makes a stopped run with delivered parts look like a failure.
    endedBy = o.signal?.aborted ? "abort" : stalled ? "stalled" : cutter.currentPartBytes >= o.sizeCap ? "cap" : "eof";
    if (readError) cur.fail(readError);
    if (cur !== o.firstSink && cutter.currentMediaBytes === 0 && !readError) {
      // Nothing but the PAT/PMT head after the last cut: not a part.
      cur.discard();
      discardedTail = true;
      discardedSink = cur;
    } else {
      finalPart = sealCurrent(endedBy, true, cutter.currentTiming(), cutter.currentPartBytes);
    }
  }
  const exit = await Promise.race([
    exited,
    new Promise<SegmentExit>((resolve) => {
      const timer = setTimeout(() => {
        stopChild();
        resolve({ code: null, signal: endedBy === "abort" ? "SIGTERM" : "SIGKILL", stderrTail });
      }, o.exitGraceMs ?? 10_000);
      timer.unref?.();
    }),
  ]);
  tsDisc += countTsDiscontinuities(stderrPartial);
  if (finalPart) finalPart.tsDiscontinuities = tsDisc - discBase;
  return {
    exit, endedBy, discardedTail,
    ...(discardedSink ? { discardedSink } : {}),
    ...(finalPart ? { finalPart } : {}),
    ...(stalled ? { stalledMs: stalledAt - lastDataAt } : {}),
  };
}

/** Per-part result as the old one-ffmpeg-per-part code reported it. */
function segmentResultOf(part: SealedPart, sink: PartSinkResult, exit: SegmentExit): SegmentRunResult {
  return {
    exit,
    tsDiscontinuities: part.tsDiscontinuities,
    chunksUploaded: sink.chunksUploaded,
    streamedBytes: sink.streamedBytes,
    spooledBytes: sink.spooledBytes,
    uploadError: sink.uploadError,
    ...(sink.degradedReason ? { degradedReason: sink.degradedReason } : {}),
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

export interface RunSegmentOpts {
  /** ffmpeg argv(由 {@link buildPipeFfmpegArgs} 产出)。 */
  args: string[];
  /** 覆盖分块大小(默认取 session.bucket.chunkSize);spool-only 模式没有真会话,需显式给。 */
  chunkSize?: number;
  /** 本段字节上界(= UPOS 预声明的 size)。 */
  sizeCap: number;
  /** spool 路径(同步写)。 */
  spoolPath: string;
  session: PreuploadResult;
  fetchImpl?: typeof fetch;
  /** 每完成一个块回调一次(含耗时观测 —— PoC 要的就是「块在 ffmpeg 退出前就流出」)。 */
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  /** 队列容量(块数);超限即停止预传、只落盘。 */
  queueCapacity?: number;
  /**
   * Whether to mirror the stream into a spool file.
   *   - "full" (default): every byte is written, so a failed upload can fall back to a
   *     whole-file re-upload, and ffprobe can self-check the exact bytes.
   *   - "none": true zero-disk. Nothing is written; a failed upload has no local fallback.
   * Callers pick "none" only when disk saving is the explicit goal (plans/039).
   */
  spoolMode?: "full" | "none";
  /**
   * 分 P 结算策略。缺省 = 只用字节兜底(`sizeCap`)。
   * 传了 `maxMs` 时,**时长先到也结算**(按视频 PTS 在下一个关键帧切):用已累积的满块 + 尾块 complete(UPOS 允许少传)。
   */
  seal?: SealPolicy;
  /**
   * 背压回调:上传跟不上录制、已降级为纯落盘时调用一次。
   * **不是可选观测** —— 调用方必须据此告知用户/记日志,否则降级完全静默。
   */
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  /** Same as {@link PartSinkOpts.onDegrade}: fired the moment streaming degrades. */
  onDegrade?: (reason: string) => void;
  signal?: AbortSignal;
  /** Kill ffmpeg after this long without a stdout chunk. Default 60s; 0 disables. */
  stallTimeoutMs?: number;
  /** Test seam: how long to wait for stdout EOF after killing ffmpeg before destroying it. */
  destroyGraceMs?: number;
  /** Test seam: maximum wait for the child close event after killing ffmpeg. */
  exitGraceMs?: number;
}

/**
 * 跑一段(单 P):一个 ffmpeg、一个 {@link PartSink},到字节兜底 / 时长阈值 / 流结束即收尾。
 *
 * 这是 {@link runStream} 的单 P 封装(`stopAtCut` 恒为真):一次性调用与测试用它;
 * 直播直传主循环直接用 `runStream`,一个连接产出多个分 P。
 *
 * 块的上传与 ffmpeg 并行,ffmpeg 还在录的时候就上传。失败路径一个都不抛:
 *  - 上传块失败 → 停止预传,spool 仍完整 → 调用方按 `spooledBytes` 回退文件上传;
 *  - 流比声明短 → 尾块按实际长度传出,不补零;
 *  - 取消 → ffmpeg 被杀,已写字节留在 spool。
 * 三种情况都**不补零、不伪造媒体长度**(B 站会先收下再在转码阶段拒,比本地报错更糟)。
 */
export async function runSegment(o: RunSegmentOpts): Promise<SegmentRunResult> {
  const sink = new PartSink({
    sizeCap: o.sizeCap,
    spoolPath: o.spoolPath,
    session: o.session,
    ...(o.chunkSize !== undefined ? { chunkSize: o.chunkSize } : {}),
    ...(o.spoolMode ? { spoolMode: o.spoolMode } : {}),
    ...(o.queueCapacity !== undefined ? { queueCapacity: o.queueCapacity } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.onChunk ? { onChunk: o.onChunk } : {}),
    ...(o.onBackpressure ? { onBackpressure: o.onBackpressure } : {}),
    ...(o.onDegrade ? { onDegrade: o.onDegrade } : {}),
    ...(o.signal ? { signal: o.signal } : {}),
  });
  const stream = await runStream({
    args: o.args,
    sizeCap: o.sizeCap,
    ...(o.seal?.maxMs ? { maxMs: o.seal.maxMs } : {}),
    firstSink: sink,
    openNext: () => { throw new Error("runSegment: single-part run must not open a second part"); },
    stopAtCut: () => true,
    onPartSealed: () => {},
    ...(o.signal ? { signal: o.signal } : {}),
    ...(o.stallTimeoutMs !== undefined ? { stallTimeoutMs: o.stallTimeoutMs } : {}),
    ...(o.destroyGraceMs !== undefined ? { destroyGraceMs: o.destroyGraceMs } : {}),
    ...(o.exitGraceMs !== undefined ? { exitGraceMs: o.exitGraceMs } : {}),
  });
  // The first part is never discarded, so it is always the final part.
  const part = stream.finalPart!;
  return segmentResultOf(part, await sink.finished, stream.exit);
}

/** preupload with the 601 rate-limit backoff (only a fresh session can hit it). */
async function preuploadWithBackoff(o: {
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
      // Must log: this backoff can total ~48 minutes (30s doubling, capped at 300s, 8 tries).
      // Silent, it looks exactly like a hang — no ffmpeg output, no log, no error.
      const waitMs = Math.min(30_000 * 2 ** attempt, 300_000);
      o.log?.(`[直播直传] preupload 命中限流,${waitMs / 1000}s 后重试(${attempt + 2}/9): ${o.fileName}`);
      await sleepUnlessAborted(waitMs, [o.signal], o.sleep);
      if (o.signal?.aborted) throw new Error("live-pump aborted during preupload backoff");
    }
  }
}

/**
 * Everything that happens to a sealed part before it can be submitted: duration, dts-gap scan,
 * UPOS `complete`, whole-file fallback. Shared by the per-part wrapper ({@link pumpSegment}) and the
 * background finalize chain of {@link runLivePump}.
 *
 * Full mode always runs the ffprobe readability/duration check (background work now, it no longer
 * blocks the pull); zero-disk uses the part's video PTS ({@link SegmentRunResult.ptsDurationSec}),
 * cross-checked against the wall clock.
 *
 * spool stays unless `keepSpool` is false and the part was completed (the caller owns the file until
 * the archive acknowledges the part).
 */
async function finalizeRecordedPart(o: {
  rec: SegmentRunResult;
  session: PreuploadResult | undefined;
  cookiesPath: string;
  fileName: string;
  spoolPath: string;
  spoolMode: "full" | "none";
  line: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  log?: (msg: string) => void;
  onFallback?: (spoolPath: string, bytes: number) => void;
  probeDuration?: (path: string) => Promise<number>;
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  /** Sleep seam for the fallback preupload 601 backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Called after a gap-held spool was renamed to `.held-gap` (drop its recovery row). */
  onHold?: () => void;
  /** Called when that rename failed: the row must stay and a human must be told. */
  onHoldFailed?: (detail: string) => void;
  keepSpool?: boolean;
}): Promise<SegmentRunResult & { session?: PreuploadResult }> {
  const { rec, session, spoolPath, spoolMode } = o;
  const withSession = <T extends object>(x: T): T & { session?: PreuploadResult } => ({ ...x, ...(session ? { session } : {}) });

  // A zero-byte stall has no media to submit. Treat it as a no-part result so the caller can
  // recover the stream instead of turning a dead socket into a permanent task failure.
  if (rec.sealedBy === "stalled" && rec.spooledBytes === 0) {
    if (spoolMode === "full") {
      try { rmSync(spoolPath, { force: true }); } catch { /* best effort */ }
    }
    return withSession({ ...rec, spoolDurationSec: 0, usedFileFallback: false });
  }

  // Duration. PTS is the cheap source, but a PTS reset (CDN timestamp jump) can make it lie, so it is
  // sanity-checked against the wall-clock time the part was open (only meaningful for long parts).
  let durationSec = 0;
  const pts = rec.ptsDurationSec ?? 0;
  const wallSec = (rec.sealedMs ?? 0) / 1000;
  let ptsTrusted = pts > 0;
  if (pts > 0 && wallSec > 60 && (pts > 1.5 * wallSec + 60 || pts < 0.5 * wallSec)) {
    ptsTrusted = false;
    o.log?.(`[直播直传] ⚠️ ${o.fileName}: PTS 时长 ${pts.toFixed(1)}s 与墙钟 ${wallSec.toFixed(1)}s 不符,PTS 不可信`);
  }
  if (spoolMode === "full") {
    // T-53 readability check: runs on the finished spool in the background (it no longer blocks the
    // pull). The ffprobe duration wins; a spool ffprobe cannot read is not submitted.
    const probe = o.probeDuration ?? ffprobeDuration;
    try { durationSec = await probe(spoolPath); } catch { durationSec = 0; }
    if (!(durationSec > 0)) {
      durationSec = 0;
      rec.uploadError = rec.uploadError ?? `产物自检失败(TS 读不出 duration,不可投): ${spoolPath}`;
    }
  } else {
    // Zero-disk: no local file to probe; the uploaded bytes are validated by UPOS `complete`.
    // Keep sub-second precision: a short part must not round down to 0 seconds and be rejected as
    // "no duration" (real bug: a 67ms slice became an unsubmittable part). An untrusted or missing
    // PTS falls back to the wall clock.
    durationSec = ptsTrusted ? pts : Math.max(0.001, wallSec);
  }

  if (rec.tsDiscontinuities) {
    o.log?.(`[直播直传] ⚠️ ${o.fileName}: ffmpeg 报告 ${rec.tsDiscontinuities} 次时间戳不连续(流内跳变或被复用器钳平)`);
  }

  // Pre-complete gate: a part is only visible in the archive after `complete` + submit, so a
  // scan here can still keep a broken part out. Held parts skip BOTH complete and the
  // whole-file fallback (that fallback would upload the same bad bytes), and this runs even
  // when the chunk upload already failed, for the same reason.
  if (spoolMode === "full" && rec.spooledBytes > 0 && durationSec > 0) {
    let gap: DtsGap | null | undefined;
    try { gap = await (o.scanDtsGap ?? defaultScanDtsGap)(spoolPath); } catch { gap = undefined; }
    if (gap) {
      rec.tsGap = gap;
      // Rename so the orphan sweep (which only matches the plain spool name) keeps the sample.
      let kept = spoolPath;
      const heldPath = heldGapPath(spoolPath);
      // Rename first, drop the recovery row only after it succeeded: if the rename fails the row must
      // stay (the orphan sweep keeps what the state references, so the only copy survives). A crash
      // between the two steps leaves a row whose spool is gone but whose `.held-gap` sibling exists,
      // which recovery treats as held.
      let renamed = false;
      try { renameSync(spoolPath, heldPath); kept = heldPath; renamed = true; } catch (e) {
        o.onHoldFailed?.(`${spoolPath}: ${String((e as Error)?.message ?? e).slice(0, 120)}`);
      }
      if (renamed) o.onHold?.();
      const why = `时间戳跳变(流${gap.streamIndex}: ${gap.fromSec.toFixed(1)}s → ${gap.toSec.toFixed(1)}s),不投稿,spool 保留为 ${kept}`;
      rec.uploadError = rec.uploadError ? `${rec.uploadError};${why}` : why;
      // Chunks may already be on UPOS but this part will never complete.
      if (rec.chunksUploaded > 0) rec.sessionLeaked = true;
    } else if (gap === undefined) {
      o.log?.(`[直播直传] ⚠️ ${o.fileName}: 时间戳扫描无法判定,按原流程继续`);
    }
  }

  let stem: string | undefined;
  let usedFallback = false;

  if (!rec.uploadError && rec.chunksUploaded > 0 && session) {
    const parts = Array.from({ length: rec.chunksUploaded }, (_, i) => ({ partNumber: i + 1, eTag: "etag" }));
    const done = await complete({ session, parts, fetchImpl: o.fetchImpl, signal: o.signal });
    if (done.ok) stem = done.stem;
    else rec.uploadError = `complete 失败: ${JSON.stringify(done.raw).slice(0, 200)}`;
  }

  // ── 失败回退:按**整文件**重传 ──────────────────
  // 边录边传失败的每种情形(块失败 / 背压降级 / complete 失败 / 自检不过但内容可读)
  // 都不能让已录的字节白白躺在盘上。这里新开一个会话、用**精确文件大小**整体上传,
  // 与生产的 biliup 文件上传等价。UPOS 没有 abort,旧会话只能留着(见 sessionLeaked)。
  if (spoolMode === "full" && rec.uploadError && !rec.tsGap && rec.spooledBytes > 0 && durationSec > 0) {
    const fb = await reuploadSpoolFile({
      cookiesPath: o.cookiesPath, fileName: o.fileName, spoolPath,
      line: o.line, fetchImpl: o.fetchImpl, signal: o.signal,
      onChunk: o.onChunk, log: o.log, sleep: o.sleep,
    });
    if (fb.ok) {
      stem = fb.stem;
      rec.uploadError = undefined;     // 回退成功 = 这一段最终是成功的
      rec.chunksUploaded = fb.chunks;
      rec.streamedBytes = fb.bytes;
      usedFallback = true;
      o.onFallback?.(spoolPath, fb.bytes);
    } else {
      rec.uploadError = `${rec.uploadError};整文件回退也失败: ${fb.error}`;
    }
  }
  // keepSpool=true means the caller owns the file until the archive acknowledges this part.
  if (!o.keepSpool && stem) {
    try { rmSync(spoolPath, { force: true }); } catch { /* cleanup is best effort */ }
  }
  return withSession({ ...rec, spoolDurationSec: durationSec, stemOfCompleted: stem, usedFileFallback: usedFallback });
}

/**
 * 单段闭环(边录边传版,TS 容器):一个 preupload → {@link runSegment} → {@link finalizeRecordedPart}。
 *
 * 直播直传主循环不再逐段调用它(一个连接产出多个分 P,见 {@link runStream}),它保留给
 * 一次性调用与测试,行为与拆分前一致:
 *
 *   1. preupload(size = 结算上界)  —— 字节还没产生就先申请会话;
 *   2. ffmpeg 边录,stdout 切块**当场** PUT(录制与上传并行);
 *   3. 结算点(字节兜底 / 时长阈值谁先到)→ complete 已传出的连续 parts。
 *
 * 为什么可以这样:UPOS 的 `complete` 接受「声明 chunks=N、实际只传 M<N 个连续 part」
 * (实测:声明 20MiB、只传 1 个 10MiB 块 → `OK:1`)。所以 `size` 是**上界**而非精确值,
 * 分 P 的真实大小就是实际流出的字节数 —— 不需要预知总长。
 *
 * spool **仍然写**,且失败时真的会用它回退({@link reuploadSpoolFile}):块失败 /
 * 背压降级 / complete 失败 / 自检不过但内容可读 —— 四种都按**整文件**重传,
 * 不补零伪造媒体长度。自检读不出时长的除外(那种内容本身就不可投)。
 */
export async function pumpSegment(o: {
  cookiesPath: string;
  args: string[];
  /** 分 P 文件名(同时是 spool 名;UPOS `name` 用同一个;容器为 .ts)。 */
  fileName: string;
  /** 结算上界(= preupload 声明的 size)。 */
  sizeCap: number;
  spoolDir: string;
  line: string;
  /** 时长阈值(毫秒,按视频 PTS);与 sizeCap 谁先到算一 P。 */
  maxMs?: number;
  /** Kill ffmpeg after this long without a stdout chunk (default 5 minutes). */
  stallTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  /** 降级当场回调(块失败/背压/会话迟到),见 {@link PartSinkOpts.onDegrade}。 */
  onDegrade?: (reason: string) => void;
  /** Progress/diagnostic log (preupload backoff). Without it a long backoff looks like a hang. */
  log?: (msg: string) => void;
  /** 回退整文件重传成功时回调一次(调用方须告知用户:这一段不是流式传上去的)。 */
  onFallback?: (spoolPath: string, bytes: number) => void;
  /** 时长自检接缝(测试注入;缺省 {@link ffprobeDuration};只在流里没有 PTS 时用)。 */
  probeDuration?: (path: string) => Promise<number>;
  /** dts gap scan seam (tests inject; default {@link ffprobeDtsGap}). `undefined` = could not judge. */
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  signal?: AbortSignal;
  /** Keep the spool after completion (the caller confirms submission and cleans it up). */
  keepSpool?: boolean;
  /** Upload queue depth in chunks (default 4). Tests use 1 to force backpressure. */
  queueCapacity?: number;
  /**
   * "full" (default) writes a fallback spool; "none" is true zero-disk. In "none" mode there is
   * no file to ffprobe or to re-upload, so the self-check and whole-file fallback are skipped —
   * a failed chunk upload is a hard failure for that part (logged, never silently dropped).
   */
  spoolMode?: "full" | "none";
}): Promise<SegmentRunResult & { session: PreuploadResult }> {
  const spoolPath = `${o.spoolDir.replace(/\/$/, "")}/${o.fileName}`;
  const session = await preuploadWithBackoff({
    cookiesPath: o.cookiesPath, fileName: o.fileName, sizeCap: o.sizeCap,
    line: o.line, fetchImpl: o.fetchImpl, signal: o.signal, log: o.log,
  });
  const spoolMode = o.spoolMode ?? "full";
  const rec = await runSegment({
    args: o.args,
    sizeCap: o.sizeCap,
    spoolPath,
    spoolMode,
    queueCapacity: o.queueCapacity,
    session,
    fetchImpl: o.fetchImpl,
    signal: o.signal,
    // 时长阈值必须传下去,否则"谁先到"永远只可能是字节先到。
    seal: { maxBytes: o.sizeCap, maxMs: o.maxMs },
    stallTimeoutMs: o.stallTimeoutMs,
    onChunk: o.onChunk,
    onBackpressure: o.onBackpressure,
    onDegrade: o.onDegrade,
  });
  const fin = await finalizeRecordedPart({
    rec, session, cookiesPath: o.cookiesPath, fileName: o.fileName, spoolPath, spoolMode,
    line: o.line, fetchImpl: o.fetchImpl, signal: o.signal, onChunk: o.onChunk, log: o.log,
    onFallback: o.onFallback, probeDuration: o.probeDuration, scanDtsGap: o.scanDtsGap, keepSpool: o.keepSpool,
  });
  return { ...fin, session };
}

/**
 * 按**整文件**重传一个 spool(失败回退路径)。
 *
 * 与边录边传的区别:size 用文件真实大小(不预声明上界),所以每个块都是完整长度,
 * 不存在尾块协商。这是生产的 biliup 文件上传在本模块内的等价物。
 */
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
  /** Sleep seam for the preupload 601 backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
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

/** Uploads an already-open spool in chunk-sized slices, so memory no longer scales with the file size (one chunk buffer at a time). */
async function reuploadOpenSpool(
  o: Parameters<typeof reuploadSpoolFile>[0],
  fd: number,
  totalSize: number,
): Promise<{ ok: boolean; stem?: string; chunks: number; bytes: number; error?: string }> {
  const { readSync } = await import("node:fs");

  let session: PreuploadResult;
  try {
    // Same 601 backoff as the main preupload (a rate limit here must not fail the fallback outright).
    session = await preuploadWithBackoff({
      cookiesPath: o.cookiesPath, fileName: o.fileName, sizeCap: totalSize,
      line: o.line, fetchImpl: o.fetchImpl, signal: o.signal, log: o.log, sleep: o.sleep,
    });
  } catch (e) {
    return { ok: false, chunks: 0, bytes: 0, error: `preupload: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
  }

  try {
    const parts = await uploadChunks({
      session, totalSize,
      fetchImpl: o.fetchImpl ?? fetch,
      retries: 3,
      signal: o.signal,
      onProgress: (p) => o.onChunk?.(p.uploadedBytes, p.chunksDone),
      readChunk: async (i, size) => {
        const buf = Buffer.allocUnsafe(size);
        let off = 0;
        while (off < size) {
          const n = readSync(fd, buf, off, size - off, i * session.bucket.chunkSize + off);
          if (n <= 0) throw new Error(`spool 读取提前结束(块 ${i}, ${off}/${size})`);
          off += n;
        }
        return buf;
      },
    });
    const done = await complete({ session, parts, fetchImpl: o.fetchImpl, signal: o.signal });
    if (!done.ok) return { ok: false, chunks: parts.length, bytes: totalSize, error: `complete: ${JSON.stringify(done.raw).slice(0, 200)}` };
    return { ok: true, stem: done.stem, chunks: parts.length, bytes: totalSize };
  } catch (e) {
    return { ok: false, chunks: 0, bytes: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** Minimal stream projection for acquisition tests; avoids depending on the full Platform contract. */
export interface StreamAcquirer {
  living: boolean;
  url?: string;
  /** HTTP headers required by the platform; passed through to ffmpeg. */
  headers?: Record<string, string>;
  /** Live stream title when the platform exposes it (used for title templates). */
  title?: string;
  /** Anchor name when the platform exposes it (used for XML metadata). */
  owner?: string;
}

export interface AcquireStreamOpts {
  /** Room identifier (room number or URL, depending on the platform). */
  room: string;
  /** Stream fetcher (production passes `platform.getStream`). */
  fetch: (room: string, quality: string) => Promise<StreamAcquirer>;
  quality: string;
  /** Maximum retries after the initial attempt (default 5). */
  maxRetries?: number;
  /** Backoff base in milliseconds (default 5000); retry n waits base × 2^(n-1). */
  baseMs?: number;
  onRetry?: (waitMs: number, attempt: number, max: number) => void;
  /** Receives the total number of failed attempts, including the initial one. */
  onGiveUp?: (totalAttempts: number) => void;
  /** Sleep seam for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Per-attempt timeout (default 30s). A platform fetch can hang forever (DNS/socket without a
   * timeout), which would freeze the whole pump after a part and look like a silent stop —
   * no retry log, danmu keeps flowing, no new parts. A timeout must count as a failed attempt.
   */
  timeoutMs?: number;
}

/**
 * Acquire a fresh stream URL with exponential backoff.
 *
 * Direct URLs expire and anchors briefly disconnect. Treating one failed fetch as "offline"
 * silently drops the rest of the broadcast. Retry with bounded backoff, then stop as offline;
 * already uploaded parts remain intact.
 *
 * The counter resets whenever a stream is acquired, so each segment gets its own retry budget.
 */
export async function acquireStreamWithBackoff(o: AcquireStreamOpts): Promise<StreamAcquirer> {
  const max = o.maxRetries ?? 5;
  const base = o.baseMs ?? 5000;
  const sleep = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs ?? 30_000;
  let fails = 0;
  for (;;) {
    // Bound each attempt: a hung fetch must degrade to "not living" (retry), never freeze the pump.
    let timer: NodeJS.Timeout | undefined;
    // Do NOT unref: if `fetch` never settles, this timer is the only thing keeping the event
    // loop alive. Unref'ing it lets Node go idle forever (process alive, no sockets, no logs).
    const timeout = new Promise<StreamAcquirer>((resolve) => {
      timer = setTimeout(() => resolve({ living: false }), timeoutMs);
    });
    let s: StreamAcquirer;
    try {
      s = await Promise.race([o.fetch(o.room, o.quality), timeout]);
    } catch {
      s = { living: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (s.living && s.url) return s;
    if (fails >= max) {
      o.onGiveUp?.(fails + 1);
      return s;
    }
    const wait = base * 2 ** fails;
    fails++;
    o.onRetry?.(wait, fails, max);
    await sleep(wait);
  }
}

/** One recorded segment, as reported by {@link runLivePump}. */
export interface LivePumpSegmentReport {
  seg: number;
  chunks: number;
  bytes: number;
  spooled: number;
  ms: number;
  stem?: string;
  exit?: number | null;
  backpressured?: boolean;
  /** 流式上传为何降级(块失败/背压/会话迟到);整文件回退成功后 uploadError 为空,原因靠它保留。 */
  degradedReason?: string;
  spoolDurationSec?: number;
  sessionLeaked?: boolean;
  uploadError?: string;
  usedFileFallback?: boolean;
}

export interface RunLivePumpOptions {
  /** Error-level alert channel for conditions a human must act on (e.g. old state archived at start). */
  onAlert?: (message: string) => void;
  cookiesPath: string;
  room: string;
  /** Stream fetcher (production passes `platform.getStream` through a projection). */
  fetch: (room: string, quality: string) => Promise<StreamAcquirer>;
  quality: string;
  spoolDir: string;
  title: string;
  /** Render the archive title after the first stream acquisition (for `{title}` templates). */
  titleForLive?: (liveTitle: string) => string;
  tid: number;
  tag: string;
  /** Optional Bilibili season section id; added after the first successful create. */
  seasonSectionId?: number;
  /** Archive description; omitted/empty = no description. */
  desc?: string;
  private?: boolean;
  /** Byte cap per part (also the UPOS preupload declaration). */
  sizeCap: number;
  /** Duration cap per part; whichever fires first seals the part. */
  maxMs?: number;
  /** Kill ffmpeg after this long without a stdout chunk. Default 60s; 0 disables. */
  stallTimeoutMs?: number;
  /** Wait this long for the same room to return after a stall before ending the run. */
  recoverWindowMs?: number;
  /**
   * Alert via {@link onAlert} when a confirmed part's media duration (video PTS) is below this
   * fraction of its wall time (0-1; default {@link DEFAULT_MEDIA_WALL_ALERT_RATIO}). Long tails
   * and intentional stops are exempt. 0 disables the alert.
   */
  mediaWallAlertRatio?: number;
  /** Max parts to record in this run (0/undefined = keep going until offline). */
  maxSegments?: number;
  /**
   * Per-part spool file name (issue #360). The CLI passes a room/anchored name when the room
   * layout is on; without it the time-first `.live.ts` name is used.
   */
  spoolName?: (segIndex: number) => string;
  line?: string;
  /** Submit every completed part to the archive. Default true. */
  submit?: boolean;
  /** Render a part title from its 1-based index; null = keep the generated stem. */
  partTitle?: (partIndex: number, liveTitle?: string) => string | null;
  log?: (msg: string) => void;
  /** Shared account accounting for archive submissions (see {@link LivePumpSessionOpts.submitGate}). */
  submitGate?: SubmitGate;
  /** Display-only run timeline sink; errors are swallowed and never change upload behavior. */
  reporter?: LivePumpReporter;
  /**
   * Called after each part is confirmed into the archive: `count` = parts confirmed so far (including
   * earlier runs of the same archive). Progress for the master console; throwing is swallowed.
   */
  onPartConfirmed?: (info: { count: number; bvid?: string }) => void;
  /** Stop the loop after this many parts (tests / manual runs). */
  shouldStop?: () => boolean | Promise<boolean>;
  /**
   * Window-end DRAIN (the scheduler is out of window and sends SIGUSR2): stop acquiring NEW
   * streams, but let the in-flight part finish uploading.
   *
   * Deliberately separate from `signal`, which aborts the in-flight part (SIGTERM / manual
   * stop). Record-engine's `drain()` makes the same split — it only clears the open-poll timer.
   *
   * An AbortSignal rather than a callback because the caller registers its signal handler
   * *before* starting the pump: that is what guarantees a window-end signal always finds a
   * handler instead of falling through to Node's default for SIGUSR2, which kills the process
   * outright (measured: exit 159) — cutting the in-flight part, and in `spoolMode:"none"`
   * losing that video for good, because there is no local copy to fall back to.
   */
  drainSignal?: AbortSignal;
  /** Sleep seam for stream-acquisition backoff and the idle poll (tests). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Stay in-process until a broadcast starts instead of giving up after a few failed probes.
   * Production zero-disk tasks set this: exiting made the scheduler restart the task every few
   * minutes, and every restart re-hit the stream and danmu endpoints (issue #308). Only a
   * stop/drain ends the wait. Default false keeps the one-shot behavior of manual runs.
   */
  waitForBroadcast?: boolean;
  /**
   * Phase reports for the process state file (plans/044): `polling` while waiting for a stream,
   * `recording` while the stream is pulled, `finalizing` once pulling stopped but parts are still being
   * sealed / uploaded. Observability only: a throwing callback never affects the run.
   */
  onPhase?: (phase: "polling" | "recording" | "finalizing") => void;
  /** Poll interval while waiting for a broadcast (default 30s, same as the file recorder). */
  idlePollMs?: number;
  /**
   * "full" (default) mirrors each part to a spool file (fallback + ffprobe self-check).
   * "none" = true zero-disk: nothing is written for video; a failed part cannot be retried
   * from local bytes. Danmu xml still hits disk (it is the only artifact that must).
   */
  spoolMode?: "full" | "none";
  /** Override the upload queue depth (blocks of chunks). Tests use 1 to force backpressure. */
  queueCapacity?: number;
  /** Override UPOS fetch (tests / fake servers). */
  fetchImpl?: typeof fetch;
  /** Duration probe seam for tests; production uses ffprobe. */
  probeDuration?: (path: string) => Promise<number>;
  /** DTS gap scan seam for tests; production uses ffprobe. */
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  /** Retry a failed upload from its persisted spool before returning to the caller. */
  autoRetryUpload?: boolean;
  /**
   * After a stop (`signal` aborted), how long the already-sealed parts may keep finalizing
   * (complete / dts scan / submit) before they are cut off and written to the recovery state.
   * Default 7s: TaskManager SIGKILLs 10s after SIGTERM, and this must end before that.
   */
  finalizeBudgetMs?: number;
  /**
   * Cancellation for the whole run. The CLI installs SIGINT/SIGTERM handlers and aborts this,
   * so the current ffmpeg is killed instead of being orphaned when the task is stopped.
   */
  signal?: AbortSignal;
  /**
   * Danmu capture seam. The pump is platform-agnostic and must not import a platform package,
   * so the caller (record CLI) supplies a started source plus a writer path. The xml is the
   * only artifact that still lands on disk on the zero-disk path.
   */
  danmu?: {
    start: (onMessage: (m: DanmuMessage) => void) => Promise<void>;
    stop: () => Promise<void>;
    xmlPath: string;
  };
}

export interface RunLivePumpResult {
  ok: boolean;
  error?: string;
  /**
   * Why an `ok` run ended. Distinguishes "this run produced something" from "this run recorded
   * nothing", which `ok` alone cannot do: a pump that never acquires a stream also returns ok
   * with zero segments (found by review #280 — the caller then exited 0, and TaskManager read
   * that as a clean stop, so a room that recorded nothing looked finished).
   *
   * `uploaded` — at least one part completed. With `submit` enabled that means it reached the
   *   archive; with `submit:false` it means it was fully recorded and only held back locally.
   * `no-stream` — the stream could not be acquired and the run gave up (only without
   *   `waitForBroadcast`), so no part exists. Callers treat it as a failure.
   * `idle` — `waitForBroadcast` run that recorded no part: a stop/drain arrived while waiting, or
   *   the room dropped right after it was seen live. Waiting never gives up on its own
   *   (issue #308), so this is a normal ending, never a failure.
   *
   * Absent when `ok:false` (an error cut the run); read `error` for the reason and
   * `segments` for what was already delivered.
   */
  outcome?: "uploaded" | "no-stream" | "idle";
  /**
   * Parts lost because of a stop (zero-disk without a local copy, or a recovery-state write that failed).
   * Set on `ok:true` runs too: a run that delivered parts stays successful so its archive is ledgered.
   */
  lostParts?: number;
  /** Zero-disk parts whose archive submit was in flight when the run was cut off; outcome unknown, not lost. */
  unknownParts?: number;
  /** The archive already exists, so creating a new one is forbidden. */
  archiveExists?: boolean;
  bvid?: string;
  aid?: number;
  title: string;
  segments: LivePumpSegmentReport[];
  spoolDir: string;
  statePath: string;
}

const MiB = 1024 * 1024;
/** Below this a segment is treated as "the stream just ended", not a real part. */
const MIN_PART_BYTES = 1024 * 1024;

/**
 * A final part holding less than two video frames (PTS seen, no span): the stream ended or
 * was killed right after a cut. It has no duration, ffprobe cannot read it, and it is not worth a
 * part. Treating it as a failed/unconfirmed part would fail an otherwise clean run, or leave a row
 * in the recovery state that blocks every later start.
 */
function negligibleTail(part: SealedPart): boolean {
  if (!part.final || part.sink.spooledBytes >= MIN_PART_BYTES) return false;
  // Only when video timestamps WERE seen but span nothing. A stream without any PTS (or a
  // non-TS test input) has no media clock to judge by, and keeps the old rules.
  return !!part.timing && !(part.timing.durationSec > 0);
}

/** Error text for a part lost on the zero-disk path (no local fallback). */
export const ZERO_DISK_PART_LOST = "上传跟不上录制且未保留本地 spool:该分 P 已丢失";

/**
 * True when a part's bytes were produced but never uploaded and cannot be recovered.
 * On the zero-disk path there is no spool file, so backpressure is data loss, not a
 * performance degradation; callers must fail the part instead of only logging it.
 */
export function zeroDiskPartLost(
  spoolMode: "full" | "none" | undefined,
  backpressured: boolean | undefined,
): boolean {
  return (spoolMode ?? "full") === "none" && backpressured === true;
}

/** A recovery deadline belongs only to the current stalled segment; normal progress clears it. */
export function recoveryDeadlineAfterPart(
  sealedBy: SegmentRunResult["sealedBy"],
  nowMs: number,
  windowMs: number,
): number | undefined {
  return sealedBy === "stalled" ? nowMs + windowMs : undefined;
}

/** Default poll interval while no broadcast is live; keeps risk-control pressure at file-recorder level. */
export const IDLE_POLL_MS = 30_000;

/**
 * Sleep that ends early when any signal aborts. `sleepImpl` is the test seam; it is still raced
 * against the signals so a stop is never delayed by a long poll interval.
 */
export async function sleepUnlessAborted(
  ms: number,
  signals: Array<AbortSignal | undefined>,
  sleepImpl?: (ms: number) => Promise<void>,
): Promise<void> {
  // Every wait in this file (601 / submit backoff, upload retry pacing, idle poll) is a bounded pause (<= 5 min)
  // inside work this child still owns: it is not a stall for the finalizing judge (plans/044). The 24h backstop
  // bounds an endless wait.
  noteRecorderProgress();
  const live = signals.filter((x): x is AbortSignal => !!x);
  if (live.some((x) => x.aborted)) return;
  let timer: NodeJS.Timeout | undefined;
  let onAbort: () => void = () => {};
  const aborted = new Promise<void>((resolve) => {
    onAbort = resolve;
    for (const sig of live) sig.addEventListener("abort", onAbort, { once: true });
  });
  const slept = sleepImpl
    ? sleepImpl(ms)
    : new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); });
  try {
    await Promise.race([slept, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
    for (const sig of live) sig.removeEventListener("abort", onAbort);
  }
}

/**
 * Record a live room and upload every finished part into one archive.
 *
 * This is the single implementation behind both the hidden `_live-pump` command and the
 * production streaming-upload path, so behavior cannot drift between the two.
 */
export async function runLivePump(o: RunLivePumpOptions): Promise<RunLivePumpResult> {
  const log = o.log ?? ((m: string) => process.stderr.write(`${m}\n`));
  const sleep = o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const maxSegments = Math.max(0, o.maxSegments ?? 0);
  const emit = (e: Parameters<LivePumpReporter["event"]>[0]): void => {
    try { o.reporter?.event(e); } catch { /* observability only */ }
  };
  const progress = (p: { part: number; uploadedBytes: number; chunks: number }): void => {
    try { o.reporter?.progress(p); } catch { /* observability only */ }
  };
  /** Live title seen on the first acquisition (platforms may not expose one). */
  let liveTitle: string | undefined;
  // TaskManager derives the task's recording phase from these exact markers
  // (`[状态] 录制中` / `[状态] 等待开播`). Without them a zero-disk task shows as "running"
  // but never "recording", so the UI cannot tell waiting-for-stream from actually recording.
  const phase = (p: "polling" | "recording" | "finalizing"): void => {
    try { o.onPhase?.(p); } catch { /* observability only */ }
  };
  /** Phase while no stream is being pulled: parts that stayed unconfirmed are still upload work → finalizing. */
  const idlePhase = (s: LivePumpSession): "polling" | "finalizing" => (s.hasUnconfirmed ? "finalizing" : "polling");
  emit({ at: Date.now(), kind: "waiting" });
  phase("polling");
  log("[状态] 等待开播");
  const idlePollMs = o.idlePollMs ?? IDLE_POLL_MS;
  const stopRequested = async (): Promise<boolean> =>
    !!o.signal?.aborted || !!o.drainSignal?.aborted || !!(await o.shouldStop?.());
  /** Probe until a stream is live. Resolves null once a stop or drain is requested. */
  const waitForBroadcast = async (deadlineMs?: number): Promise<StreamAcquirer | null> => {
    for (let misses = 0; ; misses++) {
      if (await stopRequested()) return null;
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        log(`[直播直传] 停滞恢复窗口已耗尽(${Math.round((o.recoverWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS) / 60_000)} 分钟),结束本次录制`);
        return null;
      }
      // One attempt per poll (no backoff retries): the interval itself is the retry cadence.
      const s = await acquireStreamWithBackoff({
        room: o.room, fetch: o.fetch, quality: o.quality, maxRetries: 0, sleep,
      });
      if (s.living && s.url) return s;
      // Log the first miss and then roughly every 10 minutes, so a long wait is visible
      // without flooding the task log.
      if (misses % Math.max(1, Math.round(600_000 / idlePollMs)) === 0) {
        log(`[直播直传] 未开播,每 ${idlePollMs / 1000}s 探测一次(留在进程内等待)`);
      }
      const waitMs = deadlineMs === undefined ? idlePollMs : Math.max(0, Math.min(idlePollMs, deadlineMs - Date.now()));
      if (waitMs <= 0) continue;
      await sleepUnlessAborted(waitMs, [o.signal, o.drainSignal], o.sleep);
    }
  };
  /**
   * Open the room's session and settle what a previous run left behind (WAL recovery, one
   * re-uploadable unconfirmed part). Constructing the session also applies the same-broadcast
   * rule (#293) against the current time. Returns a failure result instead of a session when
   * the archive is in a state that must not collect more parts.
   */
  const openSession = async (): Promise<{ session: LivePumpSession } | { fail: RunLivePumpResult }> => {
    const session = new LivePumpSession({
      cookiesPath: o.cookiesPath,
      room: o.room,
      spoolDir: o.spoolDir,
      title: o.title,
      tid: o.tid,
      tag: o.tag,
      ...(o.desc ? { desc: o.desc } : {}),
      ...(o.seasonSectionId ? { seasonSectionId: o.seasonSectionId } : {}),
      private: o.private !== false,
      log,
      ...(o.onAlert ? { onAlert: o.onAlert } : {}),
      ...(o.submitGate ? { submitGate: o.submitGate } : {}),
      // The session performs the archive create/append requests; it must use the same fetch
      // override as the segment uploader, or a fake transport would silently fall back to the
      // real network (real bug: a fake-UPOS run hit live Bilibili and got -400).
      fetchImpl: o.fetchImpl,
      ...(o.reporter ? { reporter: o.reporter } : {}),
      ...(o.probeDuration ? { probeDuration: o.probeDuration } : {}),
      ...(o.scanDtsGap ? { scanDtsGap: o.scanDtsGap } : {}),
      ...(o.sleep ? { sleep: o.sleep } : {}),
    });
    const info = session.sessionInfo;
    emit({
      at: Date.now(),
      kind: info.resumed ? "run_resume" : "run_start",
      session: info,
    });

    if (o.submit !== false) {
      // Whenever this child owns unconfirmed upload work the phase is `finalizing` (plans/044): WAL recovery and
      // the whole-file re-upload of a previous run's parts must never look like "idle, waiting for a broadcast".
      phase("finalizing");
      try {
      const recovered = await session.recover();
      if (!recovered.ok) {
        log(
          recovered.archiveExists
            ? `[直播直传] 稿件已存在但状态不确定,禁止新建稿件: ${recovered.reason}`
            : `[直播直传] 恢复失败,停止以避免重复建稿: ${recovered.reason}`,
        );
        return { fail: {
          ok: false, error: recovered.reason, archiveExists: !!recovered.archiveExists,
          title: session.archiveTitle, segments: [], spoolDir: o.spoolDir,
          statePath: livePumpStatePath(o.spoolDir, o.room),
        } };
      }
      // A restart after the archive was created never reaches the create hook again. Reconcile the
      // persisted BV when the marker is pending (or absent on legacy state); the add is idempotent.
      if (session.bvid || session.aid) await session.reconcileSeason(o.fetchImpl);
      if (session.hasUnconfirmed) {
        const pending = session.parts.filter((p) => !p.confirmed);
        // Unconfirmed parts whose spools all survived are recoverable: re-upload each whole file and
        // append them in index order. A missing spool means a real gap, so stop for a human.
        if (pending.length >= 1 && pending.every((p) => existsSync(p.spoolPath) || existsSync(heldGapPath(p.spoolPath)))) {
          log(`[直播直传] 有 ${pending.length} 个未确认分 P(索引 ${pending.map((p) => p.index).join(",")}),按整文件重传补齐`);
          const fixed = await session.resubmitAllUnconfirmed();
          if (fixed.held?.length) log(`[直播直传] ⚠️ 恢复时有 ${fixed.held.length} 个分 P 因时间戳跳变被扣留(索引 ${fixed.held.join(",")}),稿件缺这几 P,需人工处理`);
          if (!fixed.ok) {
            return { fail: {
              ok: false, error: fixed.error, bvid: session.bvid, aid: session.aid,
              title: session.archiveTitle, segments: [], spoolDir: o.spoolDir,
              statePath: livePumpStatePath(o.spoolDir, o.room),
            } };
          }
        } else {
          const error = `unconfirmed parts: ${pending.map((p) => p.index).join(",")}`;
          log(`[直播直传] 有 ${pending.length} 个未确认分 P;为避免重复/空洞,拒绝继续录制上传`);
          return { fail: {
            ok: false, error, bvid: session.bvid, aid: session.aid,
            title: session.archiveTitle, segments: [], spoolDir: o.spoolDir,
            statePath: livePumpStatePath(o.spoolDir, o.room),
          } };
        }
      }
      } finally {
        phase(idlePhase(session));
      }
    }
    return { session };
  };

  let preRecoveryOpened = false;
  if (o.waitForBroadcast) {
    // A previous run may have left a pending/unconfirmed part (e.g. the last part's submit failed
    // as the show ended). Settle it now, while its archive is still "this broadcast", instead of
    // after a long wait when the gap rule would archive it for a human (review of #319).
    const st = existsSync(livePumpStatePath(o.spoolDir, o.room))
      ? readLivePumpState(livePumpStatePath(o.spoolDir, o.room))
      : undefined;
    if (o.submit !== false && st !== undefined && (!st || !!st.pending || st.parts.some((p) => !p.confirmed))) {
      log("[直播直传] 上次运行留有未确认分 P,等待开播前先恢复");
      const pre = await openSession();
      if ("fail" in pre) return pre.fail;
      preRecoveryOpened = true;
    }
    if (preRecoveryOpened) emit({ at: Date.now(), kind: "waiting" });
    // Wait BEFORE opening the session for recording. The session decides "same broadcast or a
    // new one" from the state's last activity when it is constructed; deciding at process start
    // and then waiting hours would append the next broadcast to the previous one's archive. The
    // probe result is dropped on purpose: the loop below fetches a fresh URL.
    const first = await waitForBroadcast();
    if (!first) {
      return {
        ok: true, outcome: "idle", title: o.title, segments: [], spoolDir: o.spoolDir,
        statePath: livePumpStatePath(o.spoolDir, o.room),
      };
    }
  }
  const opened = await openSession();
  if ("fail" in opened) return opened.fail;
  const session = opened.session;

  // Danmu is the one artifact that still hits disk on the zero-disk path. It starts only once a
  // stream is actually live (never while waiting): connecting before the broadcast resolves a
  // stale liveId, so the WS stays connected but receives nothing for the whole show. It also
  // starts only after recovery succeeded (an archive in an uncertain state must not collect
  // more parts), and is stopped on every exit path below. Failure is non-fatal: video upload
  // must not be blocked by WS.
  let danmuStarted = false;
  let danmuAttempted = false;
  const startDanmuOnce = async (): Promise<void> => {
    if (!o.danmu || danmuAttempted) return;
    danmuAttempted = true;
    try {
      await o.danmu.start((m) => { /* writer is owned by the caller's start() */ });
      danmuStarted = true;
      log(`[直播直传] 弹幕已连接 → ${o.danmu.xmlPath}`);
    } catch (e) {
      log(`[直播直传] ⚠️ 弹幕连接失败(不影响视频上传): ${(e as Error).message}`);
    }
  };
  const stopDanmu = async (): Promise<void> => {
    if (!danmuStarted || !o.danmu) return;
    danmuStarted = false;
    await o.danmu.stop().catch((e: unknown) => log(`[直播直传] ⚠️ 弹幕停止失败: ${(e as Error).message}`));
  };

  const segments: LivePumpSegmentReport[] = [];
  const recoverWindowMs = Math.max(1_000, o.recoverWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS);
  let recoveryDeadline: number | undefined;
  let recoveryTimedOut = false;
  const spoolMode = o.spoolMode ?? "full";
  const spoolDirClean = o.spoolDir.replace(/\/$/, "");
  const defaultFileName = (seg: number): string => `${Date.now()}_${String(seg).padStart(3, "0")}.live.ts`;
  // Computed once per part: the prefetch and the later openNext must agree on the name (the default
  // name embeds Date.now(), so recomputing would give the session and the spool different names).
  const fileNames = new Map<number, string>();
  const fileNameFor = (seg: number): string => {
    let n = fileNames.get(seg);
    if (n === undefined) {
      n = o.spoolName ? o.spoolName(seg) : defaultFileName(seg);
      fileNames.set(seg, n);
    }
    return n;
  };
  /** Archive index of the next part to open. Allocated when a part starts, never at submit time. */
  let nextIndex = session.nextPartIndex;
  /** Run-local part sequence (spool names, "段N" in logs, report.seg). */
  let partSeq = 0;
  let partsOpened = 0;
  interface PartCtx {
    index: number;
    seg: number;
    fileName: string;
    spoolPath: string;
    openedAt: number;
    onChunk: (streamedBytes: number, chunksDone: number) => void;
    /**
     * This part's own cancellation. Aborted by a stop only while the part is still being recorded;
     * once sealed, its finalize/upload keeps running (a sealed part is complete and deliverable) and
     * is only cut off when the stop's finalize budget runs out.
     */
    ac: AbortController;
    sealed: boolean;
    part?: SealedPart;
    /** The archive submit request is in flight (outcome unknown if the run is cut off now). */
    submitting: boolean;
    /** Cancels this part's pending preupload (backoff) once it stopped waiting for it. */
    sessionAbort?: AbortController;
  }
  const ctxs = new Map<PartSink, PartCtx>();
  /** When the stop signal fired: the finalize budget runs from here, not from when we start waiting. */
  let stopAt: number | undefined = o.signal?.aborted ? Date.now() : undefined;
  if (o.signal && !o.signal.aborted) o.signal.addEventListener("abort", () => { stopAt = Date.now(); }, { once: true });
  /** Set when the run returns: the background chain must not touch the returned result after that. */
  let closed = false;
  const pushSegment = (x: LivePumpSegmentReport): void => { if (!closed) segments.push(x); };
  /** Parts lost for good because of a stop (zero-disk, or a state write that failed). */
  const stopLost: string[] = [];
  /** Zero-disk parts whose archive submit was in flight when the run was cut off (outcome unknown). */
  const stopUnknown: string[] = [];
  /** What the connection loop should do after a part's background finalize. */
  type Disposition = { kind: "continue" } | { kind: "ended" } | { kind: "stall-empty" };
  /** First background failure (the same result shape the sequential code returned). */
  let fatal: RunLivePumpResult | undefined;
  /** An exception thrown on the chain; rethrown by the main loop, never swallowed. */
  let fatalThrown: { error: unknown } | undefined;
  let currentConnAbort: AbortController | undefined;
  /** Strictly ordered background chain: part k+1 is not finalized before part k is. */
  let finalizeTail: Promise<void> = Promise.resolve();
  const failRun = (result: RunLivePumpResult): Disposition => {
    fatal ??= result;
    // A failed part must stop the pull: parts after it could not be submitted anyway.
    currentConnAbort?.abort();
    return { kind: "ended" };
  };

  /** complete → dts scan → submit for one sealed part. Mirrors the sequential per-part code. */
  const finalizeOne = async (part: SealedPart, exit: SegmentExit | undefined): Promise<Disposition> => {
    const ctx = ctxs.get(part.sink)!;
    const { index, seg, fileName, spoolPath } = ctx;
    const sig = ctx.ac.signal;
    const sinkRes = await part.sink.finished;
    if (negligibleTail(part) && sinkRes.spooledBytes > 0) {
      log(`[直播直传] 段${seg + 1} 只有不足两帧(${sinkRes.spooledBytes}B),判定为切点后的尾巴,丢弃`);
      if (spoolMode === "full") { try { rmSync(spoolPath, { force: true }); } catch { /* best effort */ } }
      return part.sealedBy === "stalled" ? { kind: "stall-empty" } : { kind: "ended" };
    }
    const r = await finalizeRecordedPart({
      rec: segmentResultOf(part, sinkRes, exit ?? NO_EXIT),
      session: sinkRes.session,
      cookiesPath: o.cookiesPath, fileName, spoolPath, spoolMode,
      line: o.line ?? "txa",
      fetchImpl: o.fetchImpl, signal: sig,
      onChunk: ctx.onChunk, log,
      onFallback: (p, b) => log(`[直播直传] ↺ 段${seg + 1} 走整文件回退重传: ${(b / MiB).toFixed(1)}MiB (${p})`),
      probeDuration: o.probeDuration, scanDtsGap: o.scanDtsGap,
      ...(o.sleep ? { sleep: o.sleep } : {}),
      onHold: () => session.dropPart(index),
      onHoldFailed: (detail) => {
        const msg = `段${seg + 1} 时间戳跳变的 spool 无法改名扣留,保留在恢复状态,需人工处理(${detail})`;
        log(`[直播直传] ⚠️ ${msg}`);
        try { o.onAlert?.(msg); } catch { /* alert channel must not break the run */ }
      },
      keepSpool: true,
    });
    // The run already returned (budget cut-off): leave the archive and the returned result alone.
    if (closed) return { kind: "ended" };
    const base: LivePumpSegmentReport = {
      seg: seg + 1,
      chunks: r.chunksUploaded,
      bytes: r.streamedBytes,
      spooled: r.spooledBytes,
      ms: Date.now() - ctx.openedAt,
      exit: r.exit.code,
      backpressured: r.backpressured,
      ...(r.degradedReason ? { degradedReason: r.degradedReason } : {}),
      sessionLeaked: r.sessionLeaked,
      usedFileFallback: r.usedFileFallback,
    };
    const fail = (error: string, extra: Partial<LivePumpSegmentReport> = {}): Disposition => failRun({
      ok: false, error, bvid: session.bvid, aid: session.aid, title: session.archiveTitle,
      segments: [...segments, { ...base, ...extra, uploadError: error }],
      spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
    });

    // No bytes means there is nothing to append. Recover the source instead of turning a dead
    // socket into a permanent task failure.
    if (r.spooledBytes === 0) {
      if (r.sealedBy === "stalled") return { kind: "stall-empty" };
      if (!r.uploadError) {
        log("[直播直传] 本段没有写入,判定已收播");
        return { kind: "ended" };
      }
      // A non-stalled empty part with an upload error is a real failure. Fall through to the
      // existing error return; treating it as a source stall would spin preupload forever.
    }

    const unconfirmedIndex = index;
    const persistUnconfirmed = (): string | undefined => {
      if (r.tsGap || spoolMode !== "full" || o.submit === false || r.spooledBytes <= 0) {
        return undefined;
      }
      const note = session.noteUnconfirmedPart({
        index: unconfirmedIndex,
        spoolPath,
        title: o.partTitle?.(unconfirmedIndex + 1, liveTitle) ?? fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
        bytes: r.spooledBytes,
        durationSec: r.spoolDurationSec ?? 0,
        ...(r.stemOfCompleted ? { stem: r.stemOfCompleted } : {}),
      });
      if (note.ok) emit({ at: Date.now(), kind: "part_unconfirmed", part: unconfirmedIndex, bytes: r.spooledBytes });
      return note.ok ? undefined : (note.error ?? "无法记录未确认分 P");
    };
    const retryUnconfirmed = async (): Promise<{ ok: boolean; stem?: string; bvid?: string; aid?: number; error?: string }> => {
      emit({ at: Date.now(), kind: "part_retry", part: unconfirmedIndex });
      const deadline = Date.now() + recoverWindowMs;
      let waitMs = Math.min(5_000, recoverWindowMs);
      let lastError = "";
      for (;;) {
        // Drain means "finish this part, do not start another"; a hard signal is the only thing
        // that should abort the current spool retry.
        if (sig.aborted) return { ok: false, error: "stopped" };
        const recovered = await session.recover().catch((e: unknown) => ({
          ok: false,
          reason: String((e as Error)?.message ?? e).slice(0, 200),
        }));
        if (!recovered.ok) {
          lastError = recovered.reason ?? "状态恢复失败";
        } else {
          const submitted: { ok: boolean; bvid?: string; aid?: number; error?: string } =
            await session.resubmitUnconfirmedPart(sig).catch((e: unknown) => ({
              ok: false,
              error: String((e as Error)?.message ?? e).slice(0, 200),
            }));
          if (submitted.ok) {
            const confirmedPart = session.parts.find((p) => p.index === unconfirmedIndex && p.confirmed);
            if (!confirmedPart) {
              return { ok: false, error: `自动重试未确认目标分 P(索引 ${unconfirmedIndex})` };
            }
            emit({ at: Date.now(), kind: "part_confirmed", part: unconfirmedIndex, ...(submitted.bvid ? { bvid: submitted.bvid } : {}) });
            return {
              ok: true,
              ...(confirmedPart?.stem ? { stem: confirmedPart.stem } : {}),
              ...(submitted.bvid ? { bvid: submitted.bvid } : {}),
              ...(submitted.aid ? { aid: submitted.aid } : {}),
            };
          }
          lastError = submitted.error ?? "未确认分 P 重试失败";
        }
        if (Date.now() >= deadline) return { ok: false, error: lastError || "自动重试窗口耗尽" };
        const sleepMs = Math.max(0, Math.min(waitMs, deadline - Date.now()));
        log(`[直播直传] 段${seg + 1} 自动重试上传,${Math.max(1, Math.ceil(sleepMs / 1000))}s 后继续: ${lastError}`);
        await sleepUnlessAborted(sleepMs, [sig], o.sleep);
        waitMs = Math.min(60_000, Math.max(1_000, waitMs * 2));
      }
    };

    // Zero-disk: backpressure means bytes were produced but not uploaded, and there is no file
    // to fall back to. Treating it as a warning would silently lose video — it is a hard error.
    if (spoolMode === "none" && r.backpressured) {
      const error = ZERO_DISK_PART_LOST;
      log(`[直播直传] ⚠️ 段${seg + 1} ${error}`);
      emit({ at: Date.now(), kind: "part_failed", part: index, message: error });
      return fail(error);
    }
    // A part that fails self-check or upload never enters the archive (T-53).
    if (r.uploadError || !r.spoolDurationSec) {
      let error = r.uploadError ?? "缺 duration(产物不可投)";
      const where = spoolMode === "none" ? "无本地副本" : `spool ${(r.spooledBytes / MiB).toFixed(1)}MiB`;
      log(`[直播直传] ⚠️ 段${seg + 1} 未可投,不进入稿件: ${error}(${where})`);
      // Keep recoverable bytes in the WAL before returning. Without this, the orphan sweep can
      // delete the only spool copy after its grace period while the uploader is offline.
      const persistError = persistUnconfirmed();
      if (persistError) error = `${error};${persistError}`;
      const persisted = persistError === undefined;
      if (r.sealedBy === "stalled" && o.autoRetryUpload !== false
        && persisted && spoolMode === "full" && !r.tsGap && r.spooledBytes > 0
        && !sig.aborted && !o.drainSignal?.aborted) {
        const retried = await retryUnconfirmed();
        if (retried.ok) {
          const recovered = session.parts.find((p) => p.index === unconfirmedIndex && p.confirmed);
          pushSegment({
            ...base,
            ...(recovered?.stem ? { stem: recovered.stem } : {}),
            spooled: r.spooledBytes,
            bytes: r.spooledBytes,
            spoolDurationSec: r.spoolDurationSec ?? 0,
          });
          log(`[直播直传] 段${seg + 1} 自动重试成功,已追到稿件 ${retried.bvid ?? session.bvid ?? retried.aid ?? "当前稿件"}`);
          log("[状态] 分P已确认");
          try {
            const bv = retried.bvid ?? session.bvid;
            o.onPartConfirmed?.({
              count: session.parts.filter((p) => p.confirmed).length,
              ...(bv ? { bvid: bv } : {}),
            });
          } catch { /* progress reporting must never fail an upload */ }
          recoveryDeadline = Date.now() + recoverWindowMs;
          return { kind: "continue" };
        }
        error = `${error};自动重试失败: ${retried.error ?? "窗口耗尽"}`;
      }
      // A cancelled run that already delivered parts is still a success: the archive holds
      // everything recorded so far. Reporting failure would make callers (ledger writeback,
      // exit code) discard real uploaded parts just because the *last* segment was cut short
      // by the stop signal.
      if (r.sealedBy === "abort" && segments.some((x) => x.stem)) {
        if (spoolMode === "none" && r.spooledBytes > 0) {
          // The part being recorded at the stop had no local copy: it is lost. Not silent any more.
          stopLost.push(`段${seg + 1}`);
          log(`[直播直传] ⚠️ 段${seg + 1} 停止时正在录制,零落盘无本地副本,该分 P 已丢失`);
        }
        log("[直播直传] 已停止,此前分 P 均已入稿:按成功收尾");
        pushSegment({ ...base, uploadError: error });
        return { kind: "ended" };
      }
      // A part cut off by a stop is not a failure of the run when it is recoverable: in full mode
      // its spool is in the recovery state and the next run delivers it, in order.
      if (o.signal?.aborted && session.parts.some((x) => x.index === index && !x.confirmed)) {
        log(`[直播直传] 已停止:段${seg + 1} 未传完,已记入恢复状态,下次运行按整文件补传`);
        pushSegment({ ...base, uploadError: error });
        return { kind: "ended" };
      }
      emit({ at: Date.now(), kind: "part_failed", part: unconfirmedIndex, message: error });
      return fail(error);
    }

    const stem = r.stemOfCompleted;
    if (!stem) {
      let error = "complete 未返回 UPOS stem";
      const persistError = persistUnconfirmed();
      if (persistError) error = `${error};${persistError}`;
      emit({ at: Date.now(), kind: "part_failed", part: unconfirmedIndex, message: error });
      return fail(error, { spoolDurationSec: r.spoolDurationSec });
    }

    const report: LivePumpSegmentReport = { ...base, stem, spoolDurationSec: r.spoolDurationSec };
    if (o.submit !== false) {
      emit({ at: Date.now(), kind: "part_submit", part: index });
      ctx.submitting = true;
      const submitted = await session.submitPart({
        index,
        spoolPath,
        stem,
        title: o.partTitle?.(index + 1, liveTitle) ?? fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
        bytes: r.spooledBytes,
        durationSec: r.spoolDurationSec,
      }, sig);
      ctx.submitting = false;
      if (!submitted.ok) {
        log(`[直播直传] 段${seg + 1} 稿件提交失败${spoolMode === "none" ? "(无本地副本)" : ",保留 spool"}: ${submitted.error}`);
        emit({ at: Date.now(), kind: "part_failed", part: index, message: submitted.error });
        return failRun({
          ok: false, error: submitted.error, bvid: session.bvid, aid: session.aid,
          title: session.archiveTitle, segments: [...segments, { ...report, uploadError: submitted.error }],
          spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
        });
      }
      log(
        `[直播直传] 段${seg + 1} 已确认到稿件 ${submitted.bvid ?? submitted.aid}` +
        `${r.usedFileFallback ? " (整文件回退)" : ""}`,
      );
      emit({ at: Date.now(), kind: "part_confirmed", part: index, ...(submitted.bvid ? { bvid: submitted.bvid } : {}) });
      log("[状态] 分P已确认");
      try {
        const bv = submitted.bvid ?? session.bvid;
        o.onPartConfirmed?.({ count: session.parts.filter((p) => p.confirmed).length, ...(bv ? { bvid: bv } : {}) });
      } catch { /* progress reporting must never fail an upload */ }
    }
    pushSegment(report);
    // A normal part with bytes proves the source is producing again. Do not let an old stall
    // deadline cut off a healthy broadcast later in the same run.
    recoveryDeadline = part.final ? recoveryDeadlineAfterPart(r.sealedBy, Date.now(), recoverWindowMs) : undefined;
    const disk = spoolMode === "none"
      ? "无本地回退文件(真直播直传)"
      : `spool ${(r.spooledBytes / MiB).toFixed(1)}MiB`;
    log(
      `[直播直传] 段${seg + 1} 结束: ${r.chunksUploaded} 块 / ${(r.streamedBytes / MiB).toFixed(1)}MiB,` +
      `${disk},ffmpeg exit=${r.exit.code}` +
      `${r.degradedReason ? `,降级: ${r.degradedReason}` : ""}` +
      `${r.usedFileFallback ? ",整文件回退成功" : ""}`,
    );
    // End-of-part media report (issue #464): PTS span vs wall time plus the PTS jumps (holes)
    // observed inside the part. All values are already in memory at seal time — no ffprobe here.
    const wallSec = (part.sealedMs + (part.stalledMs ?? 0)) / 1000;
    const mediaBits: string[] = [];
    if (r.ptsDurationSec !== undefined) {
      mediaBits.push(`媒体 ${r.ptsDurationSec.toFixed(0)}s(PTS ${r.ptsStartSec?.toFixed(0) ?? "?"}→${r.ptsEndSec?.toFixed(0) ?? "?"})`);
    }
    mediaBits.push(`墙钟 ${wallSec.toFixed(0)}s`);
    if (r.ptsJumpCount) mediaBits.push(`空洞 ${r.ptsJumpCount} 处共 ${(r.ptsJumpSec ?? 0).toFixed(0)}s`);
    log(`[直播直传] 段${seg + 1} 数据: ${mediaBits.join(",")}`);
    const alertRatio = o.mediaWallAlertRatio ?? DEFAULT_MEDIA_WALL_ALERT_RATIO;
    // Guards: tiny tails and first-byte latency must not page anyone; a stalled or gappy part
    // with real media behind it must.
    if (alertRatio > 0 && r.ptsDurationSec !== undefined && !part.stopped
      && wallSec >= 90 && r.ptsDurationSec >= 30 && r.ptsDurationSec / wallSec < alertRatio) {
      const msg = `段${seg + 1} 媒体 ${r.ptsDurationSec.toFixed(0)}s / 墙钟 ${wallSec.toFixed(0)}s`
        + `(比例 ${(r.ptsDurationSec / wallSec).toFixed(2)} < ${alertRatio})`
        + `${r.ptsJumpCount ? `,其中 PTS 空洞 ${r.ptsJumpCount} 处共 ${(r.ptsJumpSec ?? 0).toFixed(0)}s` : ""},直播内容疑似缺失`;
      log(`[直播直传] ⚠️ ${msg}`);
      try { o.onAlert?.(msg); } catch { /* alert channel must not break the run */ }
    }
    if (r.sessionLeaked) log("[直播直传] ⚠️ UPOS 会话半截泄漏:协议无 abort,须按原文件重传覆盖");
    if (!part.final) return { kind: "continue" };
    if (r.sealedBy === "abort") return { kind: "ended" };
    // A tiny final part at a normal stream end is usually the last few packets, not a useful P.
    // A stalled part is different: it is the tail we are explicitly trying to preserve.
    if (r.spooledBytes < MIN_PART_BYTES && r.sealedBy !== "stalled" && !part.stopped) {
      log("[直播直传] 本段 < 1MiB,判定已收播");
      return { kind: "ended" };
    }
    return { kind: "continue" };
  };

  /** Duration estimate for a sealed part before ffprobe has seen it (PTS span, else wall clock). */
  const estimateDuration = (part: SealedPart): number =>
    part.timing && part.timing.durationSec > 0 ? part.timing.durationSec : Math.max(0.001, part.sealedMs / 1000);
  const titleOf = (ctx: PartCtx): string =>
    o.partTitle?.(ctx.index + 1, liveTitle) ?? ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, "");

  /**
   * Full mode: put a sealed part into the recovery state the moment it is sealed (its spool is
   * complete and closed), and let the confirmation clear it. A SIGKILL (or a finalize that never
   * ends) then cannot orphan the spool: the orphan sweep only trusts what the state references.
   * The recovered spool is probed and gap-scanned before it is resubmitted (see the session).
   */
  const noteSealed = (ctx: PartCtx, part: SealedPart): void => {
    if (spoolMode !== "full" || o.submit === false) return;
    const bytes = part.sink.spooledBytes;
    if (bytes <= 0 || negligibleTail(part) || session.parts.some((p) => p.index === ctx.index)) return;
    const note = session.noteUnconfirmedPart({
      index: ctx.index, spoolPath: ctx.spoolPath, title: titleOf(ctx), bytes, durationSec: estimateDuration(part),
    });
    if (!note.ok) log(`[直播直传] ⚠️ 段${ctx.seg + 1} 无法提前记入恢复状态: ${note.error}`);
  };

  /**
   * A sealed part that will not be finalized (an earlier part failed, or a stop cut it off).
   * Full mode: it is (or is now put) in the recovery state so the next run re-uploads it, in index
   * order. None mode: there is no local copy, so it is lost (or, with a submit in flight, unknown);
   * say so loudly and remember it so the run does not end as a success.
   */
  const keepOrLose = async (ctx: PartCtx, part: SealedPart, why: string, probe: boolean): Promise<void> => {
    const label = `段${ctx.seg + 1}`;
    const row = session.parts.find((p) => p.index === ctx.index);
    if (row?.confirmed) return; // already in the archive: nothing was lost
    if (spoolMode === "none") {
      if (ctx.submitting) {
        stopUnknown.push(label);
        log(`[直播直传] ⚠️ ${label} ${why};归档提交请求进行中,结果未知(下次启动按状态文件核对),不是已丢失`);
        return;
      }
      stopLost.push(label);
      log(`[直播直传] ⚠️ ${label} ${why};零落盘无本地副本,该分 P 已丢失`);
      emit({ at: Date.now(), kind: "part_failed", part: ctx.index, message: `${why};无本地副本,已丢失` });
      return;
    }
    const bytes = part.sink.spooledBytes;
    if (negligibleTail(part)) {
      log(`[直播直传] ${label} ${why};只有不足两帧的尾巴,不值得保留`);
      return;
    }
    if (o.submit === false || bytes <= 0) {
      log(`[直播直传] ${label} ${why}(spool 保留: ${ctx.spoolPath})`);
      return;
    }
    if (row) {
      log(`[直播直传] ⚠️ ${label} ${why};已在恢复状态,下次运行按整文件补传(${ctx.spoolPath})`);
      return;
    }
    let durationSec = estimateDuration(part);
    if (probe) {
      try {
        const d = await (o.probeDuration ?? ffprobeDuration)(ctx.spoolPath);
        if (Number.isFinite(d) && d > 0) durationSec = d;
      } catch { /* keep the PTS/wall estimate */ }
    }
    const note = session.noteUnconfirmedPart({ index: ctx.index, spoolPath: ctx.spoolPath, title: titleOf(ctx), bytes, durationSec });
    if (note.ok) {
      emit({ at: Date.now(), kind: "part_unconfirmed", part: ctx.index, bytes });
      log(`[直播直传] ⚠️ ${label} ${why};已记入恢复状态,下次运行按整文件补传(${ctx.spoolPath})`);
    } else {
      stopLost.push(`${label}(恢复状态写入失败)`);
      log(`[直播直传] ⚠️ ${label} ${why};且无法记入恢复状态(${note.error}),spool 保留: ${ctx.spoolPath}`);
    }
  };

  /** Queue a sealed part on the ordered background chain. Never rejects. */
  const enqueueFinalize = (part: SealedPart, exit?: SegmentExit): Promise<Disposition> => {
    const run = finalizeTail.then(async (): Promise<Disposition> => {
      const ctx = ctxs.get(part.sink);
      if (!ctx) return { kind: "ended" };
      if (fatal || fatalThrown) {
        // An earlier part failed. This one cannot be submitted (the archive refuses a part after an
        // unconfirmed one), but it must not vanish: keep it recoverable (full) or report it lost (none).
        ctx.ac.abort();
        await keepOrLose(ctx, part, "前序分 P 已失败,本分 P 未提交", true);
        return { kind: "ended" };
      }
      try {
        return await finalizeOne(part, exit);
      } catch (e) {
        if (ctx.ac.signal.aborted || o.signal?.aborted) {
          // A stop cut the finalize short. Never let the cancellation surface as a run failure.
          await keepOrLose(ctx, part, "已停止,分 P 未传完", false).catch(() => {});
          return { kind: "ended" };
        }
        fatalThrown ??= { error: e };
        currentConnAbort?.abort();
        return { kind: "ended" };
      }
    });
    finalizeTail = run.then(() => { ctxs.delete(part.sink); });
    return run;
  };
  /**
   * Wait for the finalize chain. After a stop it waits until `finalizeBudgetMs` after the stop
   * signal fired (runStream teardown counts), then cuts the unfinished parts off through their own
   * signals; what cannot be cut off is reported. Total from the signal stays under the budget plus
   * a short grace, i.e. before the supervisor's SIGKILL.
   */
  const settleFinalize = async (): Promise<void> => {
    const chain = finalizeTail;
    const budgetMs = Math.max(0, o.finalizeBudgetMs ?? 7_000);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const budget = new Promise<"budget">((resolve) => {
      const arm = (): void => {
        const left = Math.max(0, (stopAt ?? Date.now()) + budgetMs - Date.now());
        timer = setTimeout(() => resolve("budget"), left);
      };
      if (o.signal?.aborted) arm();
      else if (o.signal) { onAbort = arm; o.signal.addEventListener("abort", arm, { once: true }); }
    });
    const first = await Promise.race([chain.then(() => "done" as const), budget]);
    if (timer) clearTimeout(timer);
    if (onAbort) o.signal?.removeEventListener("abort", onAbort);
    if (first === "done") return;
    log(`[直播直传] ⚠️ 停止后 ${budgetMs}ms 内仍有 ${ctxs.size} 个分 P 未收尾,中止并记入恢复状态`);
    const pendingCtxs = [...ctxs.entries()];
    for (const [, c] of pendingCtxs) c.ac.abort();
    // Aborted work normally settles within moments; do not wait on something that ignores abort.
    let grace: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      chain.then(() => true),
      new Promise<boolean>((r) => { grace = setTimeout(() => r(false), 1_500); }),
    ]);
    if (grace) clearTimeout(grace);
    if (!settled) {
      for (const [sink, c] of pendingCtxs) {
        if (c.part && ctxs.has(sink)) await keepOrLose(c, c.part, "停止后收尾超时", false).catch(() => {});
      }
    }
  };
  try {
  let drainLogged = false;
  for (;;) {
    if (await o.shouldStop?.()) break;
    if (maxSegments > 0 && partsOpened >= maxSegments) break;
    if (o.signal?.aborted) break;
    if (recoveryDeadline !== undefined && Date.now() >= recoveryDeadline) {
      recoveryTimedOut = true;
      log("[直播直传] 停滞恢复窗口结束,停止本次录制;下次运行会重新等待开播");
      break;
    }
    // Window-end drain. Checked between parts only: the broadcast is never cut here, so the
    // part in flight still completes and uploads in full. Note this is NOT `signal` — aborting
    // would kill the ffmpeg mid-part, which is the hard-stop semantics of SIGTERM.
    if (o.drainSignal?.aborted) {
      // Must be visible: a drained run can still take minutes (the part in flight, or a
      // preupload backoff), and "no new parts appearing" looks identical to a hang.
      if (!drainLogged) {
        drainLogged = true;
        log("[直播直传] 窗口结束已排空:不再开录下一场,当前分 P 传完后收尾");
      }
      break;
    }
    // With `waitForBroadcast` the waiting already happened before the session was opened, so the
    // room was just seen live: fetch a fresh URL with the normal backoff. If it is gone again,
    // ending here (exit 0) is safe — the next run waits in-process and re-decides the session.
    // Waiting again *here* would keep a session opened hours earlier for the next broadcast.
    let s: StreamAcquirer | null;
    // Every part of the previous connection has settled; we are waiting for a stream again. Parts that stayed
    // unconfirmed (kept spool, held gap) are still upload work this child owns → finalizing, not idle polling.
    phase(idlePhase(session));
    if (recoveryDeadline !== undefined) {
      s = await waitForBroadcast(recoveryDeadline);
      if (!s) {
        if (await stopRequested()) break;
        recoveryTimedOut = true;
        log("[直播直传] 停滞恢复窗口结束,停止本次录制;下次运行会重新等待开播");
        break;
      }
    } else {
      s = await acquireStreamWithBackoff({
        room: o.room,
        fetch: o.fetch,
        quality: o.quality,
        onRetry: (waitMs, attempt, max) => log(`[直播直传] 段${partSeq + 1} 取流失败,${waitMs / 1000}s 后重试(${attempt}/${max})`),
        onGiveUp: (attempts) => log(`[直播直传] 连续 ${attempts} 次取不到流,按收播收尾(已录分 P 不受影响)`),
        sleep,
      });
    }
    if (!s.living || !s.url) break;
    emit({ at: Date.now(), kind: "live" });
    await startDanmuOnce();
    if (s.title?.trim()) liveTitle = s.title.trim();
    if (o.titleForLive && s.title) {
      const nextTitle = o.titleForLive(s.title);
      if (session.setTitleIfFresh(nextTitle)) log(`[直播直传] 稿件标题已按直播标题渲染: ${nextTitle}`);
    } else if (o.titleForLive) {
      // No live title from this platform, but the anchor/start time may still have changed.
      const nextTitle = o.titleForLive("");
      if (session.setTitleIfFresh(nextTitle)) log(`[直播直传] 稿件标题已按取流信息重渲染: ${nextTitle}`);
    }
    phase("recording");
    log("[状态] 录制中");

    // ── One ffmpeg for this whole connection; parts are cut by TsCutter at video keyframes ────────
    // (plans/043). Everything a part needs after it is cut (complete → dts scan → submit) runs on
    // the background finalize chain below, so the pull never waits for it.
    const connAbort = new AbortController();
    currentConnAbort = connAbort;
    const connSignal = o.signal ? AbortSignal.any([o.signal, connAbort.signal]) : connAbort.signal;
    let prefetch: { promise: Promise<PreuploadResult>; abort: AbortController } | undefined;
    const startPreupload = (fileName: string, signal: AbortSignal): Promise<PreuploadResult> => {
      const p = preuploadWithBackoff({
        cookiesPath: o.cookiesPath, fileName, sizeCap: o.sizeCap, line: o.line ?? "txa",
        fetchImpl: o.fetchImpl, signal, log, sleep: o.sleep,
      });
      // The consumer (a part sink) handles the rejection; this only keeps an unconsumed prefetch
      // from surfacing as an unhandled rejection.
      p.catch(() => {});
      return p;
    };
    /** Allocate the part index and open its sink; the index is fixed here, not at submit time. */
    const openPart = (session: PreuploadResult | Promise<PreuploadResult>, fileName: string, sessionAbort?: AbortController): PartSink => {
      const seg = partSeq++;
      const index = nextIndex++;
      partsOpened++;
      const spoolPath = `${spoolDirClean}/${fileName}`;
      emit({ at: Date.now(), kind: "part_streaming", part: index });
      const onChunk = (b: number, n: number): void => {
        log(`[直播直传] 段${seg + 1} 第 ${n} 块完成,累计 ${(b / MiB).toFixed(1)}MiB`);
        progress({ part: index, uploadedBytes: b, chunks: n });
      };
      // Each part owns its cancellation. The connection-wide signal (stop / fatal failure) aborts
      // only the part still being recorded; a sealed part keeps uploading and finalizing.
      const ac = new AbortController();
      const sink = new PartSink({
        sizeCap: o.sizeCap, spoolPath, session, spoolMode,
        ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
        ...(o.queueCapacity !== undefined ? { queueCapacity: o.queueCapacity } : {}),
        signal: ac.signal,
        onChunk,
        onSessionLate: ({ lossy, bufferLimitBytes }) => {
          log(lossy
            ? `[直播直传] ⚠️ 段${seg + 1} 上传会话未及时就绪(预取 preupload 被限流/超时);零落盘仅能缓冲 ${(bufferLimitBytes / MiB).toFixed(0)}MiB,超出该分 P 将丢失`
            : `[直播直传] 段${seg + 1} 上传会话未及时就绪,继续写 spool;会话就绪后补传,否则整文件回退`);
        },
        onSessionAbandoned: () => {
          // Stop the pending preupload (and its 601 backoff): the whole-file fallback does its own.
          // No log here: the late-session degradation already reported via onDegrade, with the cause.
          ctx.sessionAbort?.abort();
        },
        onDegrade: (reason) => {
          // Say why the moment streaming degrades (chunk failure / backpressure / late session);
          // the reason also rides on the part result for the summary line.
          log(`[直播直传] ⚠️ 段${seg + 1} 流式上传降级: ${reason}`);
          try { o.onAlert?.(`段${seg + 1} 流式上传降级: ${reason}`); } catch { /* alert channel must not break the run */ }
        },
      });
      const ctx: PartCtx = { index, seg, fileName, spoolPath, openedAt: Date.now(), onChunk, ac, sealed: false, submitting: false, ...(sessionAbort ? { sessionAbort } : {}) };
      ctxs.set(sink, ctx);
      if (connSignal.aborted) ac.abort();
      else {
        const onConnAbort = (): void => { if (!ctx.sealed) ac.abort(); };
        connSignal.addEventListener("abort", onConnAbort, { once: true });
        void sink.finished.then(() => connSignal.removeEventListener("abort", onConnAbort));
      }
      return sink;
    };
    const openNext = (): PartSink => {
      const fileName = fileNameFor(partSeq);
      const pre = prefetch;
      prefetch = undefined;
      if (pre) return openPart(pre.promise, fileName, pre.abort);
      const own = new AbortController();
      return openPart(startPreupload(fileName, AbortSignal.any([connSignal, own.signal])), fileName, own);
    };
    /** At ~80% of the size/duration threshold: get the next part's session ready before the cut. */
    const onPrefetch = (): void => {
      if (prefetch || fatal || fatalThrown) return;
      if (o.drainSignal?.aborted || (maxSegments > 0 && partsOpened >= maxSegments)) return;
      const ac = new AbortController();
      prefetch = {
        promise: startPreupload(fileNameFor(partSeq), AbortSignal.any([connSignal, ac.signal])),
        abort: ac,
      };
    };
    const stopAtCut = async (): Promise<boolean> =>
      !!o.signal?.aborted || !!o.drainSignal?.aborted || (maxSegments > 0 && partsOpened >= maxSegments)
      || !!(await o.shouldStop?.());

    // The first part's preupload happens before ffmpeg starts (no bytes exist yet); a failure here
    // propagates exactly as it did when preupload lived inside the per-part call.
    const firstName = fileNameFor(partSeq);
    const firstSession = await preuploadWithBackoff({
      cookiesPath: o.cookiesPath, fileName: firstName, sizeCap: o.sizeCap, line: o.line ?? "txa",
      fetchImpl: o.fetchImpl, signal: connSignal, log, sleep: o.sleep,
    });
    const firstSink = openPart(firstSession, firstName);
    let stream: StreamRunResult;
    try {
      stream = await runStream({
        args: buildPipeFfmpegArgs({ url: s.url, headers: s.headers }),
        sizeCap: o.sizeCap,
        maxMs: o.maxMs,
        firstSink,
        openNext,
        onPrefetch,
        stopAtCut,
        onPartSealed: (part) => {
          const c = ctxs.get(part.sink)!;
          c.sealed = true;
          c.part = part;
          noteSealed(c, part);
          emit({ at: Date.now(), kind: "part_sealed", part: c.index, bytes: part.sink.spooledBytes });
          void enqueueFinalize(part);
        },
        onWarn: (m) => log(`[直播直传] ⚠️ ${m}`),
        signal: connSignal,
        stallTimeoutMs: o.stallTimeoutMs,
      });
    } finally {
      // A prefetched session nobody used (the stream ended first) is only a preupload with no
      // bytes; abort a pending backoff so it cannot outlive the connection.
      prefetch?.abort.abort();
      prefetch = undefined;
    }

    // The stream is no longer pulled; the tail parts are still sealing / uploading on the finalize chain.
    phase("finalizing");
    let finalDisposition: Disposition | undefined;
    let finalRun: Promise<Disposition> | undefined;
    if (stream.endedBy === "stalled") {
      const ctx = stream.finalPart ? ctxs.get(stream.finalPart.sink) : undefined;
      const silentSec = Math.max(1, Math.ceil((stream.stalledMs ?? 0) / 1000));
      emit({
        at: Date.now(), kind: "stalled",
        ...(ctx ? { part: ctx.index, bytes: stream.finalPart!.sink.spooledBytes } : {}),
        message: `${silentSec}s no data`,
      });
      log("[状态] 录制停滞");
      log(`[直播直传] 段${(ctx?.seg ?? partSeq - 1) + 1} 源流已 ${silentSec}s 无写入,自动封口并尝试追到当前稿件`);
    }
    if (stream.finalPart) {
      const fp = stream.finalPart;
      const fc = ctxs.get(fp.sink)!;
      fc.sealed = true;
      fc.part = fp;
      noteSealed(fc, fp);
      emit({ at: Date.now(), kind: "part_sealed", part: fc.index, bytes: fp.sink.spooledBytes });
      finalRun = enqueueFinalize(fp, stream.exit);
    } else if (stream.discardedTail) {
      // The dropped tail never became a part: give its numbers back so titles/indexes have no gap.
      partSeq--;
      nextIndex--;
      partsOpened--;
      fileNames.delete(partSeq);
      if (stream.discardedSink) ctxs.delete(stream.discardedSink);
    }
    // Every earlier part reaches a terminal state before the next step is decided (bounded after a stop).
    await settleFinalize();
    // After a stop cut-off the final part may still be unsettled; that ends the run.
    if (finalRun) finalDisposition = await Promise.race([finalRun, Promise.resolve<Disposition>({ kind: "ended" })]);
    if (fatalThrown) throw fatalThrown.error;
    if (fatal) return fatal;

    if (stream.endedBy === "stalled" && (stream.discardedTail || finalDisposition?.kind === "stall-empty")) {
      // Nothing recorded since the last cut/connection: keep the same deadline so repeated silent
      // stalls cannot extend the recovery window forever.
      recoveryDeadline ??= Date.now() + recoverWindowMs;
      continue;
    }
    if (finalDisposition?.kind === "ended") break;
  }

  if (recoveryTimedOut && segments.length === 0) {
    return {
      ok: false,
      error: `源流停滞且恢复窗口内没有重新开播(窗口 ${Math.round(recoverWindowMs / 60_000)} 分钟)`,
      bvid: session.bvid,
      aid: session.aid,
      title: session.archiveTitle,
      segments: [...segments],
      spoolDir: o.spoolDir,
      statePath: livePumpStatePath(o.spoolDir, o.room),
    };
  }
  // "Archive delivered" and "video lost" are separate signals. A run that put at least one part into
  // an archive stays `ok:true` with its `bvid` (the ledger / master receipt record it, exit code 0 as
  // before); the loss rides along as `lostParts` / `unknownParts` plus an alert. Only a run that
  // delivered nothing and lost video reports failure.
  // Parts confirmed by THIS run only: rows inherited from a resumed run must not make a run that
  // delivered nothing look delivered (it would be ledgered a second time).
  const delivered = !!session.bvid && segments.some((x) => x.stem && !x.uploadError);
  const lossNote = stopLost.length
    ? `停止时 ${stopLost.length} 个分 P 丢失(${stopLost.join(",")})${stopUnknown.length ? `;另有 ${stopUnknown.length} 个提交结果未知` : ""}`
    : undefined;
  if (lossNote) {
    log(`[直播直传] ⚠️ ${lossNote}${delivered ? "(其余分 P 已入稿,按已交付收尾)" : ""}`);
    try { o.onAlert?.(lossNote); } catch { /* alert channel must not break the return */ }
    if (!delivered) {
      return {
        ok: false, error: lossNote, bvid: session.bvid, aid: session.aid, title: session.archiveTitle,
        segments: [...segments], spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
        lostParts: stopLost.length, ...(stopUnknown.length ? { unknownParts: stopUnknown.length } : {}),
      };
    }
  }
  if (stopUnknown.length) {
    try { o.onAlert?.(`停止时 ${stopUnknown.length} 个分 P 的归档提交结果未知,下次启动将按状态文件核对`); } catch { /* alert channel */ }
  }
  return {
    ok: true,
    ...(stopLost.length ? { lostParts: stopLost.length } : {}),
    ...(stopUnknown.length ? { unknownParts: stopUnknown.length } : {}),
    // No part from this run. With `waitForBroadcast` that is a stop/drain while waiting, or a room
    // that dropped right after it was seen live; both are normal endings (the next run waits
    // in-process again). Without it, the stream could not be acquired and the run gave up.
    ...(segments.some((x) => x.stem) || (stopLost.length > 0 && delivered)
      ? { outcome: "uploaded" as const }
      : { outcome: o.waitForBroadcast ? "idle" as const : "no-stream" as const }),
    bvid: session.bvid,
    aid: session.aid,
    title: session.archiveTitle,
    segments: [...segments],
    spoolDir: o.spoolDir,
    statePath: livePumpStatePath(o.spoolDir, o.room),
  };
  } finally {
    // Whatever is still running on the chain must not touch the returned result any more.
    closed = true;
    for (const c of ctxs.values()) c.ac.abort();
    await session.drainSeason();
    await stopDanmu();
  }
}
