/**
 * live-pump.ts — 「每段一个 ffmpeg 进程」的边录边传最小实现 (T-63 阶段 2)。
 *
 * 为什么必须「一段一进程」而不是一个 ffmpeg 常驻滚动分段:录制进程还活着时,没有任何权威信号
 * 告诉上传层「这一段写完了」。`RollingUploader` 因此只能用「出现后继段」当封口代理信号 ——
 * 上传永远落后一个分 P。分 P 是 30s 时无所谓,分 P 是 1 GiB(约 20 分钟)时上传就永久落后 20 分钟。
 * **ffmpeg 进程退出 = stdout EOF = 本段封口**,这是唯一不依赖后继段的权威信号。
 *
 * 数据流(对齐 biliup `sync_downloader.rs` 的 pump_chunks,但上传走自研 upos-stream):
 *
 *   ffmpeg -fs <cap> -f mpegts pipe:1
 *     |- stdout --> spool 文件(始终写)
 *     \- 失败   --> 按整文件重传(reuploadSpoolFile;spool 是唯一可回退的源)
 *     \- exit   --> 本段封口 --> complete --> append 追 P(不等下一个分 P)
 *
 * spool 文件在分 P 确认前是回退安全网；LivePumpSession 在稿件确认该分 P 后删除它。
 * 这样进程/网络故障不丢内容，正常路径也不会把整场直播长期留在盘上。
 *
 * 调用方:隐藏命令 `_live-pump`(手动/测试)与生产任务开关 `record --stream-upload`
 * (任务字段 streamUpload,plans/039)。
 */
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
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
import { isUploadRateLimited, type DanmuMessage } from "@drec/core";
import { ffprobeDuration } from "@drec/post-process";

export const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";

/** spawn 接缝(测试注入假 ffmpeg);默认 {@link FFMPEG}。 */
export type SpawnFn = (cmd: string, args: readonly string[], opts: Record<string, unknown>) => ChildProcessLike;

/** 本模块用到的 ChildProcess 最小投影(便于测试用 stream 拼)。 */
export interface ChildProcessLike {
  stdout: NodeJS.ReadableStream | null;
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
 * 默认分段上界(用户拍板:生产默认 1GiB;测试用 100MiB 显式传入)。
 *
 * 这只是**兜底上界**(防爆盘/防爆内存),不是分 P 的期望大小 —— 分 P 大小由
 * {@link SealPolicy} 的两个阈值谁先到决定。
 *
 * 仍然走 {@link alignFileSize}:块边界对齐 10MiB 时,尾块更可能刚好凑满一个整块,
 * 少一次「不足一块」的收尾。1 GiB 本身不是 10MiB 整数倍(102.4),直接写 `1024**3`
 * 会让每次分 P 都多出一个 4 MiB 碎尾块。
 */
export const DEFAULT_SEGMENT_CAP = alignFileSize(1024 * 1024 * 1024);

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
  /** 本段字节上界(= UPOS 预声明的 size)。 */
  sizeCap: number;
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
  // 所以只在 `isHttp` 时加。注意 `-fs` 到点时 ffmpeg 的退出码是 **1 而非 0**
  // —— 那是「输出已满」的正常收尾,不是故障(真实直播段段如此,别被 exit=1 骗)。
  const reconnect = isHttp
    ? ["-reconnect", "1", "-reconnect_at_eof", "1", "-reconnect_streamed", "1", "-reconnect_delay_max", "30"]
    : [];
  return [
    "-loglevel", "error", "-y",
    ...hdrs,
    "-fflags", "+genpts",
    ...reconnect,
    "-i", a.url,
    "-fs", String(a.sizeCap),
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

export interface SegmentRunResult {
  exit: SegmentExit;
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
  /** Wall-clock recording duration of this part (ms). In zero-disk mode this is the only
   *  duration source, since there is no local file to probe. */
  sealedMs?: number;
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
   *   - `abort` :被 signal 取消。
   */
  sealedBy?: "cap" | "duration" | "eof" | "abort";
}

/** Durable state for a single live archive. Written before/after every irreversible step. */
export interface LivePumpState {
  schemaVersion: 1;
  room: string;
  createdAt: number;
  title: string;
  tid: number;
  tag: string;
  private: boolean;
  /** Archive identity; absent until the first part is submitted. */
  bvid?: string;
  aid?: number;
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

export interface LivePumpSessionOpts {
  cookiesPath: string;
  room: string;
  spoolDir: string;
  title: string;
  tid: number;
  tag: string;
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

  constructor(private readonly o: LivePumpSessionOpts) {
    mkdirSync(o.spoolDir, { recursive: true });
    this.log = o.log ?? ((m) => process.stderr.write(`${m}\n`));
    this.statePath = livePumpStatePath(o.spoolDir, o.room);
    const loaded = readLivePumpState(this.statePath);
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
      private: o.private !== false,
      parts: [],
      updatedAt: Date.now(),
    };
    if (loaded) {
      // A resumed session belongs to the archive created by the original title. Keep that
      // identity, but record the caller's current options for diagnostics.
      this.log(`[live-pump] resumed state ${this.statePath} (${loaded.parts.length} parts, title=${loaded.title})`);
    }
  }

  get bvid(): string | undefined { return this.state.bvid; }
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

  /** Persisted state snapshot (diagnostics and tests). */
  snapshot(): LivePumpState { return JSON.parse(JSON.stringify(this.state)) as LivePumpState; }

  /**
   * Re-submit an unconfirmed part whose bytes are still on disk.
   *
   * Recovery deliberately refuses to guess: a part that is not on the archive may have failed
   * before `complete()`, after `complete()` (only `edit` failed, e.g. submission throttling), or
   * never reached the archive at all. The first two cases are safe and recoverable here because
   * the spool file is still intact: upload it as a whole file, then append it with the same stem
   * check. Callers must only invoke this when the archive identity is known and no other part is
   * pending — otherwise it could create a gap or a duplicate archive.
   */
  async resubmitUnconfirmedPart(): Promise<{ ok: boolean; bvid?: string; aid?: number; error?: string }> {
    if (this.stateUntrusted) return { ok: false, error: "state sidecar is untrusted" };
    if (this.state.pending) return { ok: false, error: "another submit is pending" };
    const target = this.state.parts.find((p) => !p.confirmed);
    if (!target) return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
    if (!this.state.bvid && !this.state.aid) {
      return { ok: false, error: "archive identity unknown; refusing to resubmit" };
    }
    const doFetch = this.o.fetchImpl ?? fetch;
    let bytes = 0;
    try { bytes = statSync(target.spoolPath).size; } catch {
      return { ok: false, error: `spool missing for unconfirmed part ${target.index}: ${target.spoolPath}` };
    }
    if (bytes <= 0) return { ok: false, error: `spool empty for unconfirmed part ${target.index}` };
    this.log(`[live-pump] 分 P ${target.index} 未确认,按整文件重传补齐(${target.spoolPath})`);
    const fb = await reuploadSpoolFile({
      cookiesPath: this.o.cookiesPath,
      fileName: target.filename,
      spoolPath: target.spoolPath,
      line: this.o.line ?? "txa",
      fetchImpl: doFetch,
      onChunk: this.o.onChunk,
    });
    if (!fb.ok || !fb.stem) {
      return { ok: false, error: `resubmit upload failed: ${fb.error ?? "no stem"}` };
    }
    const submitted = await this.submitPart({
      index: target.index,
      spoolPath: target.spoolPath,
      stem: fb.stem,
      title: target.title,
      bytes: fb.bytes,
      durationSec: target.durationSec,
    });
    if (!submitted.ok) return { ok: false, error: submitted.error };
    return { ok: true, bvid: submitted.bvid, aid: submitted.aid };
  }

  private persist(): void {
    try {
      writeLivePumpState(this.statePath, this.state);
    } catch (e) {
      this.stateUntrusted = true;
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
          ? this.state.parts.map((x) => x.index === p.partIndex ? { ...x, confirmed } : x)
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
  }): Promise<{ ok: boolean; bvid?: string; aid?: number; error?: string }> {
    if (this.stateUntrusted) {
      return { ok: false, error: "state sidecar is untrusted; refusing to submit (manual recovery required)" };
    }
    // Head-of-line blocking: an unconfirmed part (or a pending irreversible request) must be
    // reconciled before any later part is submitted. Otherwise a failed P1 could be misread as
    // "archive exists" and the next part would become P1 of a different archive.
    if (this.state.pending) {
      return { ok: false, error: "previous part outcome is pending; run recover() before submitting more parts" };
    }
    const unconfirmed = this.state.parts.find((p) => !p.confirmed);
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

    const result = await this.submitWithRateLimitRetry(pending, video, doFetch);
    if (!result.ok) return { ok: false, error: result.error };
    this.state = {
      ...this.state,
      bvid: result.bvid ?? this.state.bvid,
      aid: result.aid ?? this.state.aid,
      parts: existing
        ? this.state.parts.map((p) => p.index === input.index ? { ...p, confirmed: true } : p)
        : [...this.state.parts, {
          index: input.index, spoolPath: input.spoolPath, filename: basename(input.spoolPath),
          stem: input.stem, title: input.title, bytes: input.bytes,
          durationSec: input.durationSec, confirmed: true,
        }],
      pending: undefined,
    };
    try {
      this.persist();
    } catch (e) {
      return { ok: false, error: `cannot persist confirmation: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    this.cleanupConfirmed();
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
  ): Promise<{ ok: true; bvid?: string; aid?: number } | { ok: false; error: string }> {
    const sleep = this.o.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    const baseMs = this.o.rateLimitBaseMs ?? 60_000;
    const maxAttempts = this.o.rateLimitAttempts ?? 5;
    let lastError = "";
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
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
      if (ok) return { ok: true, ...(bvid ? { bvid } : {}), ...(aid ? { aid } : {}) };
      const detail = `${pending.kind} failed: ${JSON.stringify(raw).slice(0, 300)}`;
      lastError = detail;
      if (!isUploadRateLimited(detail)) return { ok: false, error: detail };
      const waitMs = Math.min(baseMs * 2 ** attempt, 300_000);
      this.log(
        `[live-pump] ${pending.kind} 命中投稿限流(${JSON.stringify(raw).slice(0, 120)}),` +
        `${waitMs / 1000}s 后重试(${attempt + 2}/${maxAttempts})`,
      );
      await sleep(waitMs);
    }
    return { ok: false, error: `${lastError}(限流重试 ${maxAttempts} 次后仍失败)` };
  }

  private cleanupConfirmed(): void {
    if (this.o.cleanupConfirmedSpool === false) return;
    for (const p of this.state.parts) {
      if (!p.confirmed) continue;
      // Zero-disk parts have no spool; do not claim to have removed one.
      if (!existsSync(p.spoolPath)) continue;
      try {
        rmSync(p.spoolPath, { force: true });
        this.log(`[live-pump] confirmed part ${p.index}, removed spool ${p.spoolPath}`);
      } catch (e) {
        this.log(`[live-pump] confirmed part ${p.index}, spool cleanup failed: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }
}

/** 有界 FIFO:满时 `push` 丢弃并返回 false(背压),`shift` 空且已 close 时返回 undefined。 */
class BoundedQueue<T> {
  private readonly items: T[] = [];
  private closed = false;
  private readonly capacity: number;
  constructor(capacity: number) { this.capacity = capacity; }
  /** spool-only 模式:永不入队(只落盘),`push` 恒 false。见 {@link SPOOL_ONLY}。 */
  get disabled(): boolean { return this.capacity === SPOOL_ONLY; }
  push(v: T): boolean {
    if (this.disabled) return false; // spool-only:块不入队(调用方据此停止切块)
    if (this.closed || this.items.length >= this.capacity) return false;
    this.items.push(v);
    return true;
  }
  close(): void { this.closed = true; }
  get depth(): number { return this.items.length; }
  async shift(): Promise<T | undefined> {
    while (true) {
      if (this.items.length > 0) return this.items.shift();
      if (this.closed) return undefined;
      await new Promise((r) => setImmediate(r));
    }
  }
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
   * 传了 `maxMs` 时,**时长先到也结算**:用已累积的满块 + 尾块 complete(UPOS 允许少传)。
   */
  seal?: SealPolicy;
  /**
   * 背压回调:上传跟不上录制、已降级为纯落盘时调用一次。
   * **不是可选观测** —— 调用方必须据此告知用户/记日志,否则降级完全静默。
   */
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  signal?: AbortSignal;
}

/**
 * 跑一段:ffmpeg stdout 同步落 spool,同时按 chunk 切块**在 ffmpeg 还在录的时候就**上传。
 *
 * 块的上传与 ffmpeg 并行:`uploadChunks` 在后台跑,主循环只负责喂块。这就是
 * 「P1 不必等 P2 开录」—— ffmpeg 进程退出(stdout EOF)本身就是本段封口的权威信号。
 *
 * 失败路径一个都不抛:
 *  - 上传块失败 → 停止预传,spool 仍完整 → 调用方按 `spooledBytes` 回退文件上传;
 *  - 流比声明短 → `uploadChunks` 抛「长度不符」,同样回退;
 *  - 取消 → ffmpeg 被杀,已写字节留在 spool。
 * 三种情况都**不补零、不伪造媒体长度**(B 站会先收下再在转码阶段拒,比本地报错更糟)。
 */
export async function runSegment(o: RunSegmentOpts): Promise<SegmentRunResult> {
  const spoolMode = o.spoolMode ?? "full";
  mkdirSync(dirname(o.spoolPath), { recursive: true });
  // spoolMode "none" = true zero-disk: no file at all (not even a zero-length placeholder).
  const fd = spoolMode === "full" ? openSync(o.spoolPath, "w") : undefined;
  const chunkSize = o.chunkSize ?? o.session.bucket.chunkSize;
  const doFetch = o.fetchImpl ?? fetch;
  const queue = new BoundedQueue<Uint8Array>(o.queueCapacity ?? 4);
  const spoolOnly = queue.disabled;

  let chunksUploaded = 0;
  let streamedBytes = 0;
  let uploadError: string | undefined;

  // 上传侧:`readChunk` 从队列取块,与录制并行。进度回调是本模块唯一可信的「已成功块数」——
  // `uploadChunks` 失败时会把内部进度一起丢掉,所以必须在这里记账。
  // 时长先到时,后续块不再入队 → 已入队的满块就是这一 P 的全部。
  // 用 maxChunks 让上传侧**干净地停在前 N 块**(而不是 readChunk 取不到块而抛错):
  // 时长结算不该长得像「流断了」,调用方必须能区分两者。
  let sealedEarly = false;
  /** 时长阈值是否已到(上传侧据此把「没有数据」识别为收尾信号而非故障)。 */
  let durationHit = false;
  /** 尾块实际长度:真实总量 = 满块字节 + 尾块(上传侧 `totalSizeOfNow` 靠它收敛尾块 size)。 */
  let tailLen = 0;
  /** 已入队的**满块**数(不含尾块;`queuedChunks` 的定义见切块处)。 */
  let fullChunks = 0;
  /**
   * 本 P **真实**要传的字节数(满块合计 + 尾块),实时求值。
   * 结算前 = 声明的上界 o.sizeCap;尾块入队后 = 精确值。
   * 上传侧的 `totalSize` 与 `maxChunks` 都以它为准 —— 尾块长度算错的代价是
   * 分 P 尾部丢失(实测每段丢 5.5MB ≈ 3 秒视频,而日志只看块数毫无异常)。
   */
  // 真实总量:**尾块入队后**即冻结(那一刻满块数 + 尾块长度都确定了)。
  // 判据用 tailLen>0 而非 sealedEarly —— eof(流比声明短)同样要走这条。
  // 未结算前返回声明的上界;上传侧会随着尾块入队收敛到精确值。
  const totalSizeOfNow = (): number =>
    tailLen > 0 ? fullChunks * chunkSize + tailLen : o.sizeCap;

  /**
   * 把当前残余收成尾块并入队(**必须在上传侧读它之前调用**)。
   *
   * 顺序即正确性:上传侧 readChunk 先问「真实总量」再决定这一块该多大。若尾块尚未
   * 入队,它按 sizeCap 算出满块长度,而尾块只有几百 KB → 「长度不符」抛错;或更糟:
   * 尾块被静默丢弃(实测 3 段各丢 5.5MB ≈ 3 秒视频,日志只看块数毫无异常)。
   * 幂等:第二次调用是 no-op(tailLen 已 >0)。
   */
  const pushTail = (): void => {
    if (uploadError || queueOverflow || carry.length === 0 || tailLen > 0) return;
    queue.push(Buffer.from(carry));
    queuedChunks++;
    fullChunks = queuedChunks - 1;
    tailLen = carry.length;
    carry = Buffer.alloc(0);
  };
  // spool-only:根本没有上传会话,不启动上传器(块在 push 处就被丢弃)。
  const uploadTask = spoolOnly
    ? Promise.resolve()
    : uploadChunks({
    session: o.session,
    // `totalSize` 仍是 preupload 声明的**上界**(300MiB 之类);
    // `totalSizeOf` 给上传器真实要传的量,尾块长度由它算出,而不是永远按满块算。
    totalSize: o.sizeCap,
    totalSizeOf: totalSizeOfNow,
    fetchImpl: doFetch,
    retries: 3,
    signal: o.signal,
    // 结算后允许的块数 = 已入队满块 + 尾块。**不能用 queuedChunks+1**:
    // 尾块是在 finally 才 push 的,那一刻 queuedChunks 已含它,而 +1 会让上传侧
    // 多读一次 → `size` 算成负数 → 假故障。用「满块 + 尾块」表达真实总量即可。
    maxChunks: () => Math.ceil(totalSizeOfNow() / chunkSize),
    onProgress: (p) => {
      chunksUploaded = p.chunksDone;
      streamedBytes = p.uploadedBytes;
      o.onChunk?.(p.uploadedBytes, p.chunksDone);
    },
    readChunk: async (index, size) => {
      const chunk = await queue.shift();
      if (!chunk) {
        throw new Error(`流比声明的 ${o.sizeCap}B 短:第 ${index} 块(${size}B)没有数据`);
      }
      // 长度校验交给 uploadChunks:它已支持「尾块短于本块声明」并按实际长度收尾。
      // 这里再判一次会把合法尾块当成故障(实测:`第 3 块长度不符: 期望 1024, 实际 528`)。
      return chunk;
    },
  }).then(
    () => undefined,
    (e: unknown) => {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      // 时长/容量结算时队列被主动 close,readChunk 会抛「没有数据」—— 这是**收尾信号**,
      // 不是失败。留成 uploadError 会让调用方看到一条假故障(且 sessionLeaked 被误判)。
      if (durationHit && /没有数据|流比声明的/.test(msg)) return;
      uploadError = msg;
    },
  );

  const recordStartedAt = Date.now();
  const spawnNow: SpawnFn = spawnOverride ?? ((cmd, args, opts) => spawn(cmd, args as string[], opts as never) as unknown as ChildProcessLike);
  const proc = spawnNow(FFMPEG, o.args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderrTail = "";
  if (proc.stderr) {
    (proc.stderr as NodeJS.ReadableStream & { setEncoding(e: string): void }).setEncoding("utf-8");
    proc.stderr.on("data", (c: unknown) => { stderrTail = (stderrTail + String(c)).slice(-4000); });
  }
  const exited = new Promise<SegmentExit>((resolve) => {
    proc.on("close", (...a: unknown[]) => {
      resolve({ code: (a[0] as number | null) ?? null, signal: (a[1] as NodeJS.Signals | null) ?? null, stderrTail });
    });
  });
  const onAbort = (): void => { proc.kill("SIGKILL"); };
  if (o.signal) {
    // An already-aborted signal never fires "abort", so check it explicitly — otherwise the
    // ffmpeg spawned below is never killed and outlives the run.
    if (o.signal.aborted) onAbort();
    else o.signal.addEventListener("abort", onAbort, { once: true });
  }

  let spooledBytes = 0;
  let carry = Buffer.alloc(0);
  let queueOverflow = false;
  /** 已入队的块数(**本地**计数,不信 onProgress —— 它滞后于 push,尾块判定必须精确)。 */
  let queuedChunks = 0;
  let sealedBy: "cap" | "duration" | "eof" | "abort" = "cap";
  // 时长到点时**立即 close 队列**(durationHit 在上方声明,上传侧的拒绝回调要读它):上传侧的 readChunk 正在等下一块,close 让它
  // 拿到 `undefined` 从而抛「没有数据」——那是收尾信号,不是失败。
  // 必须在这里 close(而不是等 finally):finally 要等读循环退出才执行,而读循环
  // 只在 durationHit 后结束,但 uploadChunks 已经卡在 readChunk 上等下一块了。
  const sealTimer = o.seal?.maxMs && o.seal.maxMs > 0
    ? setTimeout(() => { durationHit = true; sealedEarly = true; }, o.seal.maxMs)
    : undefined;
  try {
    for await (const data of proc.stdout!) {
      // 结算点:**立刻**收尾块 + 停止读。不能等循环自然退出 ——
      // 上传侧此刻就卡在 readChunk 上等这一块,晚一步它就会按 sizeCap 算错长度。
      if (o.signal?.aborted) { sealedBy = "abort"; pushTail(); break; }
      if (durationHit) { sealedBy = "duration"; pushTail(); break; }
      // stdout 可能是 Buffer / Uint8Array / string(测试用 PassThrough 推的都算)。
      const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
      // `-fs` 是「到点停止」,实测略微超出 → 超出的部分既不入盘也不能成为合法尾块。
      const room = o.sizeCap - spooledBytes;
      const keep = buf.length <= room ? buf : buf.subarray(0, room);
      if (fd !== undefined) writeSync(fd, keep);
      spooledBytes += keep.length;
      if (uploadError || queueOverflow) continue;
      carry = carry.length ? Buffer.concat([carry, keep]) : Buffer.from(keep);
      while (carry.length >= chunkSize) {
        const chunk = Buffer.from(carry.subarray(0, chunkSize));
        carry = carry.subarray(chunkSize);
        if (!queue.push(chunk)) {
          // 背压:上传跟不上录制。**必须显式告知** —— 静默降级会让「以为边录边传成功了」
          // 变成「其实全程只落盘」,而调用方只看到块数停止增长。
          queueOverflow = true;
          o.onBackpressure?.(spooledBytes, queuedChunks);
          break;
        }
        queuedChunks++;
        fullChunks++;
      }
      // `-fs` 到点后 ffmpeg 仍可能多吐几 KB;已写满声明值就没必要继续读了。
      if (spooledBytes >= o.sizeCap) break;
    }
  } finally {
    // 尾块按**结算方式**分别处理(两种都合法,少传都能 complete):
    //  · 时长结算:当前残余 carry 就是尾块,**不论多大** —— 分 P 大小 = 实际流出字节;
    //  · 字节兜底:`-fs` 到点,残余通常不足一块,同样照发(它就是这个 P 的尾块);
    //  · 流比声明短(eof):残余也照发 —— 已上传的和尾块合起来 = spool 实际长度,
    //    sizeCap 只是上界,UPOS 接受「声明 N 块、实传 M<N 个连续 part」。
    // ⚠️ 唯一不发的情形:出错或已背压降级(此时必须整体回退文件上传)。
    // 其它结算(cap / eof / 异常)走这里;pushTail 幂等,时长路径已收过不会重复。
    pushTail();
    sealedEarly = true;
    // An abort that lands before any data (or right at EOF) never reaches the in-loop check,
    // so classify it here. Callers rely on "abort" to tell "stopped on purpose" from "stream
    // ended" — mislabelling it makes a stopped run with delivered parts look like a failure.
    if (o.signal?.aborted) sealedBy = "abort";
    else if (sealedBy === "cap" && spooledBytes < o.sizeCap) sealedBy = "eof"; // 流比声明短
    queue.close();
    o.signal?.removeEventListener("abort", onAbort);
    if (sealTimer) clearTimeout(sealTimer);
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
  await uploadTask;
  const exit = await exited;
  return {
    exit, chunksUploaded, streamedBytes, spooledBytes, uploadError,
    // 「半截会话」= 有字节已 PUT、但调用方**无法 complete** 的情形:
    //   ① 真上传失败(网络/5xx)—— parts 可能不连续,不能 complete;
    //   ② 零块成功(从没传出去过,也没有会话可泄漏)。
    // ⚠️ 时长/字节结算导致的「块数 < ceil(sizeCap/chunkSize)」**不是泄漏** ——
    // UPOS 接受少传,调用方照常 complete 即可。这里不能拿 sizeCap 反推,否则每次
    // 时长结算都会被误判成泄漏。
    sessionLeaked: uploadError != null && chunksUploaded > 0,
    backpressured: queueOverflow,
    sealedMs: Date.now() - recordStartedAt,
    sealedBy,
  };
}

/**
 * 单段闭环(边录边传版,TS 容器):
 *
 *   1. preupload(size = 结算上界)  —— 字节还没产生就先申请会话;
 *   2. ffmpeg 边录,stdout 切块**当场** PUT(录制与上传并行);
 *   3. 结算点(字节兜底 / 时长阈值谁先到)→ complete 已传出的连续 parts。
 *
 * 为什么可以这样:UPOS 的 `complete` 接受「声明 chunks=N、实际只传 M<N 个连续 part」
 * (实测:声明 20MiB、只传 1 个 10MiB 块 → `OK:1`)。所以 `size` 是**上界**而非精确值,
 * 分 P 的真实大小就是实际流出的字节数 —— 不需要预知总长。
 *
 * 对比上一版(必须先录完再传):那次卡在 matroska 需要 remux 补 trailer,而 remux 会改变
 * 字节数,所以上传前不可能知道大小。TS 无此问题,峰值占用从「一个分段」降到「队列缓冲」。
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
  /** 时长阈值(毫秒);与 sizeCap 谁先到算一 P。 */
  maxMs?: number;
  fetchImpl?: typeof fetch;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  /** Progress/diagnostic log (preupload backoff). Without it a long backoff looks like a hang. */
  log?: (msg: string) => void;
  /** 回退整文件重传成功时回调一次(调用方须告知用户:这一段不是流式传上去的)。 */
  onFallback?: (spoolPath: string, bytes: number) => void;
  /** 时长自检接缝(测试注入;缺省 {@link ffprobeDuration})。 */
  probeDuration?: (path: string) => Promise<number>;
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

  // preupload 带 601 限流退避(只在建新会话时发生;实测多段连续传 10 块零退避)。
  let session!: PreuploadResult;
  for (let attempt = 0; ; attempt++) {
    try {
      session = await preupload({
        cookiesPath: o.cookiesPath, fileName: o.fileName, totalSize: o.sizeCap,
        line: o.line, fetchImpl: o.fetchImpl,
      });
      break;
    } catch (e) {
      if (!(e instanceof UposRateLimited) || attempt >= 8) throw e;
      // Must log: this backoff can total ~48 minutes (30s doubling, capped at 300s, 8 tries).
      // Silent, it looks exactly like a hang — no ffmpeg output, no log, no error.
      const waitMs = Math.min(30_000 * 2 ** attempt, 300_000);
      o.log?.(`[live-pump] preupload 命中限流,${waitMs / 1000}s 后重试(${attempt + 2}/9): ${o.fileName}`);
      await new Promise((res) => setTimeout(res, waitMs));
    }
  }

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
    onChunk: o.onChunk,
    onBackpressure: o.onBackpressure,
  });

  // TS 不需要补 trailer 就能读出时长;这一步只是**自检**(T-53:读不出即拒投)。
  const probe = o.probeDuration ?? ffprobeDuration;
  let durationSec = 0;
  if (spoolMode === "full") {
    try { durationSec = await probe(spoolPath); } catch { durationSec = 0; }
    if (durationSec <= 0) rec.uploadError = rec.uploadError ?? `产物自检失败(TS 读不出 duration,不可投): ${spoolPath}`;
  } else {
    // Zero-disk: there is no local file to probe. The uploaded bytes are still validated by
    // UPOS `complete`; a bad container surfaces there instead of being caught locally.
    // Keep sub-second precision: a short part must not round down to 0 seconds and be
    // rejected as "no duration" (real bug: a 67ms slice became an unsubmittable part).
    // NOTE: `sealedMs` is **wall-clock**, not media duration. A live pull can spend real time
    // waiting for source segments, so wall-clock may be far below the media duration
    // (measured 2026-10-18: 60s wall clock for a 603s part). Only ever used as a "> 0" gate
    // below — never show it to users as the part's duration.
    durationSec = Math.max(0.001, Math.round((rec.sealedMs ?? 0) / 100) / 100);
  }

  let stem: string | undefined;
  let usedFallback = false;

  if (!rec.uploadError && rec.chunksUploaded > 0) {
    const parts = Array.from({ length: rec.chunksUploaded }, (_, i) => ({ partNumber: i + 1, eTag: "etag" }));
    const done = await complete({ session, parts, fetchImpl: o.fetchImpl });
    if (done.ok) stem = done.stem;
    else rec.uploadError = `complete 失败: ${JSON.stringify(done.raw).slice(0, 200)}`;
  }

  // ── 失败回退:按**整文件**重传(文档承诺过,此前没有实现) ──────────────────
  // 边录边传失败的每种情形(块失败 / 背压降级 / complete 失败 / 自检不过但内容可读)
  // 都不能让已录的字节白白躺在盘上。这里新开一个会话、用**精确文件大小**整体上传,
  // 与生产的 biliup 文件上传等价。UPOS 没有 abort,旧会话只能留着(见 sessionLeaked)。
  if (spoolMode === "full" && rec.uploadError && rec.spooledBytes > 0 && durationSec > 0) {
    const fb = await reuploadSpoolFile({
      cookiesPath: o.cookiesPath, fileName: o.fileName, spoolPath,
      line: o.line, fetchImpl: o.fetchImpl, signal: o.signal,
      onChunk: o.onChunk,
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
  const result = { ...rec, session, spoolDurationSec: durationSec, stemOfCompleted: stem, usedFileFallback: usedFallback };
  return result;
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
}): Promise<{ ok: boolean; stem?: string; chunks: number; bytes: number; error?: string }> {
  const { readFileSync, statSync } = await import("node:fs");
  let totalSize: number;
  let body: Buffer;
  try {
    totalSize = statSync(o.spoolPath).size;
    if (totalSize <= 0) return { ok: false, chunks: 0, bytes: 0, error: "spool 为空" };
    body = readFileSync(o.spoolPath);
  } catch (e) {
    return { ok: false, chunks: 0, bytes: 0, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }

  let session!: PreuploadResult;
  for (let attempt = 0; ; attempt++) {
    try {
      session = await preupload({
        cookiesPath: o.cookiesPath, fileName: o.fileName, totalSize,
        line: o.line, fetchImpl: o.fetchImpl,
      });
      break;
    } catch (e) {
      if (!(e instanceof UposRateLimited) || attempt >= 8) throw e;
      await new Promise((res) => setTimeout(res, Math.min(30_000 * 2 ** attempt, 300_000)));
    }
  }

  try {
    const parts = await uploadChunks({
      session, totalSize,
      fetchImpl: o.fetchImpl ?? fetch,
      retries: 3,
      signal: o.signal,
      onProgress: (p) => o.onChunk?.(p.uploadedBytes, p.chunksDone),
      readChunk: async (i, size) => body.subarray(i * session.bucket.chunkSize, i * session.bucket.chunkSize + size),
    });
    const done = await complete({ session, parts, fetchImpl: o.fetchImpl });
    if (!done.ok) return { ok: false, chunks: parts.length, bytes: body.length, error: `complete: ${JSON.stringify(done.raw).slice(0, 200)}` };
    return { ok: true, stem: done.stem, chunks: parts.length, bytes: body.length };
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
  spoolDurationSec?: number;
  sessionLeaked?: boolean;
  uploadError?: string;
  usedFileFallback?: boolean;
}

export interface RunLivePumpOptions {
  cookiesPath: string;
  room: string;
  /** Stream fetcher (production passes `platform.getStream` through a projection). */
  fetch: (room: string, quality: string) => Promise<StreamAcquirer>;
  quality: string;
  spoolDir: string;
  title: string;
  tid: number;
  tag: string;
  private?: boolean;
  /** Byte cap per part (also the UPOS preupload declaration). */
  sizeCap: number;
  /** Duration cap per part; whichever fires first seals the part. */
  maxMs?: number;
  /** Max parts to record in this run (0/undefined = keep going until offline). */
  maxSegments?: number;
  line?: string;
  /** Submit every completed part to the archive. Default true. */
  submit?: boolean;
  log?: (msg: string) => void;
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
  /** Sleep seam for stream-acquisition backoff (tests). */
  sleep?: (ms: number) => Promise<void>;
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
   * Why the run ended. Distinguishes "the archive holds what was recorded" from "nothing was
   * ever recorded", which `ok` alone cannot do: a pump that never acquires a stream also
   * returns ok with zero segments (found by review #280 — the caller then exited 0, and
   * TaskManager read that as a clean stop, so a room that recorded nothing looked finished).
   *
   * `uploaded` — at least one part reached the archive.
   * `no-stream` — the stream could not be acquired (give-up path), so no part exists.
   * `stopped` — a stop signal cut the run (already-delivered parts are unaffected).
   */
  outcome?: "uploaded" | "no-stream" | "stopped";
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
  const session = new LivePumpSession({
    cookiesPath: o.cookiesPath,
    room: o.room,
    spoolDir: o.spoolDir,
    title: o.title,
    tid: o.tid,
    tag: o.tag,
    private: o.private !== false,
    log,
    // The session performs the archive create/append requests; it must use the same fetch
    // override as the segment uploader, or a fake transport would silently fall back to the
    // real network (real bug: a fake-UPOS run hit live Bilibili and got -400).
    fetchImpl: o.fetchImpl,
  });

  if (o.submit !== false) {
    const recovered = await session.recover();
    if (!recovered.ok) {
      log(
        recovered.archiveExists
          ? `[live-pump] 稿件已存在但状态不确定,禁止新建稿件: ${recovered.reason}`
          : `[live-pump] 恢复失败,停止以避免重复建稿: ${recovered.reason}`,
      );
      return {
        ok: false, error: recovered.reason, archiveExists: !!recovered.archiveExists,
        title: session.archiveTitle, segments: [], spoolDir: o.spoolDir,
        statePath: livePumpStatePath(o.spoolDir, o.room),
      };
    }
    if (session.hasUnconfirmed) {
      const pending = session.parts.filter((p) => !p.confirmed);
      // One unconfirmed part whose spool survived is recoverable: re-upload the whole file and
      // append it. More than one (or a missing spool) means a real gap, so stop for a human.
      if (pending.length === 1 && existsSync(pending[0]!.spoolPath)) {
        log(`[live-pump] 有 1 个未确认分 P(索引 ${pending[0]!.index}),按整文件重传补齐`);
        const fixed = await session.resubmitUnconfirmedPart();
        if (!fixed.ok) {
          return {
            ok: false, error: fixed.error, bvid: session.bvid, aid: session.aid,
            title: session.archiveTitle, segments: [], spoolDir: o.spoolDir,
            statePath: livePumpStatePath(o.spoolDir, o.room),
          };
        }
      } else {
        const error = `unconfirmed parts: ${pending.map((p) => p.index).join(",")}`;
        log(`[live-pump] 有 ${pending.length} 个未确认分 P;为避免重复/空洞,拒绝继续录制上传`);
        return {
          ok: false, error, bvid: session.bvid, aid: session.aid,
          title: session.archiveTitle, segments: [], spoolDir: o.spoolDir,
          statePath: livePumpStatePath(o.spoolDir, o.room),
        };
      }
    }
  }

  // Danmu is the one artifact that still hits disk on the zero-disk path. Start it only after
  // recovery succeeded (an archive in an uncertain state must not collect more parts), and stop
  // it on every exit path below. Failure is non-fatal: video upload must not be blocked by WS.
  let danmuStarted = false;
  if (o.danmu) {
    try {
      await o.danmu.start((m) => { /* writer is owned by the caller's start() */ });
      danmuStarted = true;
      log(`[live-pump] 弹幕已连接 → ${o.danmu.xmlPath}`);
    } catch (e) {
      log(`[live-pump] ⚠️ 弹幕连接失败(不影响视频上传): ${(e as Error).message}`);
    }
  }
  const stopDanmu = async (): Promise<void> => {
    if (!danmuStarted || !o.danmu) return;
    danmuStarted = false;
    await o.danmu.stop().catch((e: unknown) => log(`[live-pump] ⚠️ 弹幕停止失败: ${(e as Error).message}`));
  };

  const segments: LivePumpSegmentReport[] = [];
  try {
  // TaskManager derives the task's recording phase from these exact markers
  // (`[状态] 录制中` / `[状态] 等待开播`). Without them a zero-disk task shows as "running"
  // but never "recording", so the UI cannot tell waiting-for-stream from actually recording.
  log("[状态] 等待开播");
  let drainLogged = false;
  for (let seg = 0; maxSegments === 0 || seg < maxSegments; seg++) {
    if (await o.shouldStop?.()) break;
    // Window-end drain. Checked between parts only: the broadcast is never cut here, so the
    // part in flight still completes and uploads in full. Note this is NOT `signal` — aborting
    // would kill the ffmpeg mid-part, which is the hard-stop semantics of SIGTERM.
    if (o.drainSignal?.aborted) {
      // Must be visible: a drained run can still take minutes (the part in flight, or a
      // preupload backoff), and "no new parts appearing" looks identical to a hang.
      if (!drainLogged) {
        drainLogged = true;
        log("[live-pump] 窗口结束已排空:不再开录下一场,当前分 P 传完后收尾");
      }
      break;
    }
    const s = await acquireStreamWithBackoff({
      room: o.room,
      fetch: o.fetch,
      quality: o.quality,
      onRetry: (waitMs, attempt, max) => log(`[live-pump] 段${seg + 1} 取流失败,${waitMs / 1000}s 后重试(${attempt}/${max})`),
      onGiveUp: (attempts) => log(`[live-pump] 连续 ${attempts} 次取不到流,按收播收尾(已录分 P 不受影响)`),
      sleep,
    });
    if (!s.living || !s.url) break;
    if (seg === 0) log("[状态] 录制中");

    const fileName = `live-pump-${Date.now()}-${seg}.ts`;
    const t0 = Date.now();
    const r = await pumpSegment({
      cookiesPath: o.cookiesPath,
      args: buildPipeFfmpegArgs({ url: s.url, headers: s.headers, sizeCap: o.sizeCap }),
      fileName,
      sizeCap: o.sizeCap,
      spoolDir: o.spoolDir,
      line: o.line ?? "txa",
      keepSpool: true,
      fetchImpl: o.fetchImpl,
      signal: o.signal,
      spoolMode: o.spoolMode ?? "full",
      queueCapacity: o.queueCapacity,
      log,
      onFallback: (p, b) => log(`[live-pump] ↺ 段${seg + 1} 走整文件回退重传: ${(b / MiB).toFixed(1)}MiB (${p})`),
      maxMs: o.maxMs,
      onChunk: (b, n) => log(`[live-pump] 段${seg + 1} 第 ${n} 块完成,累计 ${(b / MiB).toFixed(1)}MiB`),
    });
    const base: LivePumpSegmentReport = {
      seg: seg + 1,
      chunks: r.chunksUploaded,
      bytes: r.streamedBytes,
      spooled: r.spooledBytes,
      ms: Date.now() - t0,
      exit: r.exit.code,
      backpressured: r.backpressured,
      sessionLeaked: r.sessionLeaked,
      usedFileFallback: r.usedFileFallback,
    };

    // Zero-disk: backpressure means bytes were produced but not uploaded, and there is no file
    // to fall back to. Treating it as a warning would silently lose video — it is a hard error.
    if ((o.spoolMode ?? "full") === "none" && r.backpressured) {
      const error = "上传跟不上录制且未保留本地 spool:该分 P 已丢失";
      log(`[live-pump] ⚠️ 段${seg + 1} ${error}`);
      return {
        ok: false, error, bvid: session.bvid, aid: session.aid, title: session.archiveTitle,
        segments: [...segments, { ...base, uploadError: error }],
        spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
      };
    }
    // A part that fails self-check or upload never enters the archive (T-53).
    if (r.uploadError || !r.spoolDurationSec) {
      const error = r.uploadError ?? "缺 duration(产物不可投)";
      const where = (o.spoolMode ?? "full") === "none" ? "无本地副本" : `spool ${(r.spooledBytes / MiB).toFixed(1)}MiB`;
      log(`[live-pump] ⚠️ 段${seg + 1} 未可投,不进入稿件: ${error}(${where})`);
      // A cancelled run that already delivered parts is still a success: the archive holds
      // everything recorded so far. Reporting failure would make callers (ledger writeback,
      // exit code) discard real uploaded parts just because the *last* segment was cut short
      // by the stop signal.
      if (r.sealedBy === "abort" && segments.some((x) => x.stem)) {
        log("[live-pump] 已停止,此前分 P 均已入稿:按成功收尾");
        segments.push({ ...base, uploadError: error });
        break;
      }
      return {
        ok: false, error, bvid: session.bvid, aid: session.aid, title: session.archiveTitle,
        segments: [...segments, { ...base, uploadError: error }],
        spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
      };
    }

    const stem = r.stemOfCompleted;
    if (!stem) {
      const error = "complete 未返回 UPOS stem";
      return {
        ok: false, error, bvid: session.bvid, aid: session.aid, title: session.archiveTitle,
        segments: [...segments, { ...base, spoolDurationSec: r.spoolDurationSec, uploadError: error }],
        spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
      };
    }

    let report: LivePumpSegmentReport = {
      ...base, stem, spoolDurationSec: r.spoolDurationSec,
    };
    if (o.submit !== false) {
      // Resume from the last known part: a restarted run must not reuse an index that is
      // already confirmed, or the new part overwrites the record and its spool leaks.
      const nextIndex = session.parts.reduce((m, p) => Math.max(m, p.index + 1), 0);
      const submitted = await session.submitPart({
        index: nextIndex,
        spoolPath: `${o.spoolDir.replace(/\/$/, "")}/${fileName}`,
        stem,
        title: fileName.replace(/\.[^.]+$/, ""),
        bytes: r.spooledBytes,
        durationSec: r.spoolDurationSec,
      });
      if (!submitted.ok) {
        log(`[live-pump] 段${seg + 1} 稿件提交失败${(o.spoolMode ?? "full") === "none" ? "(无本地副本)" : ",保留 spool"}: ${submitted.error}`);
        return {
          ok: false, error: submitted.error, bvid: session.bvid, aid: session.aid,
          title: session.archiveTitle, segments: [...segments, { ...report, uploadError: submitted.error }],
          spoolDir: o.spoolDir, statePath: livePumpStatePath(o.spoolDir, o.room),
        };
      }
      log(
        `[live-pump] 段${seg + 1} 已确认到稿件 ${submitted.bvid ?? submitted.aid}` +
        `${r.usedFileFallback ? " (整文件回退)" : ""}`,
      );
    }
    segments.push(report);
    const disk = (o.spoolMode ?? "full") === "none"
      ? "无本地 spool(真 0 落盘)"
      : `spool ${(r.spooledBytes / MiB).toFixed(1)}MiB`;
    log(
      `[live-pump] 段${seg + 1} 结束: ${r.chunksUploaded} 块 / ${(r.streamedBytes / MiB).toFixed(1)}MiB,` +
      `${disk},ffmpeg exit=${r.exit.code}`,
    );
    // Degradation must be explicit: silent backpressure turns streaming upload into "disk only".
    if (r.backpressured) {
      log(`[live-pump] ⚠️ 上传跟不上录制,本段已降级为纯落盘(${(r.streamedBytes / MiB).toFixed(1)}/${(r.spooledBytes / MiB).toFixed(1)}MiB 流出)`);
    }
    if (r.sessionLeaked) log("[live-pump] ⚠️ UPOS 会话半截泄漏:协议无 abort,须按原文件重传覆盖");
    // Stream ended right away: stop instead of spinning.
    if (r.spooledBytes < MIN_PART_BYTES) {
      log("[live-pump] 本段 < 1MiB,判定已收播");
      break;
    }
  }

  return {
    ok: true,
    // No part in the archive and ok:true is only reachable through the "could not acquire the
    // stream" break below, so it is unambiguous: an abort/signal cut returns ok:false instead.
    ...(segments.some((x) => x.stem) ? { outcome: "uploaded" as const } : { outcome: "no-stream" as const }),
    bvid: session.bvid,
    aid: session.aid,
    title: session.archiveTitle,
    segments,
    spoolDir: o.spoolDir,
    statePath: livePumpStatePath(o.spoolDir, o.room),
  };
  } finally {
    await stopDanmu();
  }
}
