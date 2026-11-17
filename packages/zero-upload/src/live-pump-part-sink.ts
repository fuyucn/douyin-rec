import { uploadChunks, type PreuploadResult } from "./upos-stream.js";
import { CHUNK_UNIT, PartBuffer } from "./live-pump-part-buffer.js";
import { PartSpool } from "./live-pump-part-spool.js";

const MiB = 1024 * 1024;

export interface PartSinkOpts {
  /** Declared upper bound, also passed to preupload. */
  sizeCap: number;
  spoolPath: string;
  /** Absent means spool only; an in-flight session uses a bounded waiting buffer. */
  session?: PreuploadResult | Promise<PreuploadResult>;
  chunkSize?: number;
  fetchImpl?: typeof fetch;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  /** Default 4; SPOOL_ONLY disables queueing. */
  queueCapacity?: number;
  /** Full mirrors every byte for recovery; none never creates a spool file. */
  spoolMode?: "full" | "none";
  /** Test seam honoring POSIX short-write counts. */
  writeSpool?: (fd: number, buf: Buffer) => number;
  onBackpressure?: (spooledBytes: number, queuedChunks: number) => void;
  /** Report truncation even after degradation; defaults to onDegrade when absent. */
  onSpoolWriteFailed?: (reason: string) => void;
  /** Immediate, once-per-part degradation notification. */
  onDegrade?: (reason: string) => void;
  onSessionLate?: (info: { lossy: boolean; bufferLimitBytes: number }) => void;
  onSessionAbandoned?: (info: { lossy: boolean }) => void;
  signal?: AbortSignal;
}

export interface PartSinkResult {
  session?: PreuploadResult;
  chunksUploaded: number;
  streamedBytes: number;
  spooledBytes: number;
  uploadError?: string;
  /** Truncated spools must never complete or whole-file fallback as a successful part. */
  spoolIncomplete: boolean;
  sizeOverflow?: boolean;
  degradedReason?: string;
  sessionLeaked: boolean;
  backpressured: boolean;
}

/**
 * One part's transfer lifecycle: session arrival, bounded buffering, spool and upload outcome.
 * Seal queues the tail before closing, so the uploader sees its exact size before reading again.
 * Upload errors retain fallback data; only a spool failure throws and marks that data truncated.
 */
export class PartSink {
  readonly finished: Promise<PartSinkResult>;
  readonly spoolPath: string;
  private readonly spool: PartSpool;
  private readonly buffer: PartBuffer;
  private readonly sessionPlanned: boolean;
  private readonly waitingLimit: number;
  private session: PreuploadResult | undefined;
  private ready = false;
  private waiting: Buffer[] = [];
  private waitingBytes = 0;
  private chunksUploaded = 0;
  private streamed = 0;
  private uploadError: string | undefined;
  private overflow = false;
  private lateDegraded = false;
  private lateNotified = false;
  private degradedReason: string | undefined;
  private degradedNotified = false;
  private nonUploadFail = false;
  private waitAbandoned = false;
  private sizeOverflow = false;
  private sealed = false;
  private uploadTask: Promise<void> = Promise.resolve();
  private markSettled!: () => void;
  private markSealed!: () => void;
  private readonly settledP: Promise<void>;
  private readonly sealedP: Promise<void>;

  constructor(private readonly o: PartSinkOpts) {
    this.spoolPath = o.spoolPath;
    this.spool = new PartSpool(o.spoolPath, o.spoolMode ?? "full", o.writeSpool ?? undefined);
    const capacity = o.queueCapacity ?? 4;
    this.buffer = new PartBuffer(capacity);
    this.waitingLimit = capacity * CHUNK_UNIT;
    this.settledP = new Promise<void>((r) => { this.markSettled = r; });
    this.sealedP = new Promise<void>((r) => { this.markSealed = r; });
    this.sessionPlanned = o.session !== undefined;
    const s = o.session;
    if (s === undefined) {
      this.markSettled();
    } else if (typeof (s as Promise<PreuploadResult>).then === "function") {
      (s as Promise<PreuploadResult>).then((v) => this.attach(v), (e: unknown) => this.sessionFailed(e));
    } else {
      this.attach(s as PreuploadResult);
    }
    this.finished = this.finish();
  }

  get spooledBytes(): number { return this.spool.bytes; }
  get incomplete(): boolean { return this.spool.incomplete; }

  /** A non-upload failure suppresses the uploader's expected end-of-queue degradation. */
  fail(message: string): void {
    this.nonUploadFail = true;
    this.uploadError ??= message;
  }

  private degrade(reason: string): void {
    this.degradedReason ??= reason;
    if (this.degradedNotified) return;
    this.degradedNotified = true;
    this.o.onDegrade?.(reason);
  }

  /** Spool first: neither a failed transfer nor a late session may lose recoverable bytes. */
  write(buf: Buffer): void {
    if (this.sealed) throw new Error("PartSink: write after seal");
    this.writeSpool(buf);
    if (this.spool.bytes > this.o.sizeCap) {
      this.sizeOverflow = true;
      const why = `分 P 超出声明大小 ${this.o.sizeCap}B(${this.spool.bytes}B)`;
      this.uploadError = this.uploadError ? `${this.uploadError};${why}` : why;
    }
    if (this.uploadError || this.overflow || !this.sessionPlanned) return;
    if (!this.ready) {
      this.holdForSession(buf);
      return;
    }
    this.feed(buf);
  }

  private writeSpool(buf: Buffer): void {
    try {
      this.spool.append(buf);
    } catch (e) {
      const why = (e as Error).message;
      // Never let an earlier degradation hide truncation or suppress its dedicated alert.
      this.uploadError = this.uploadError ? `${this.uploadError};${why}` : why;
      this.degradedReason ??= why;
      this.degradedNotified = true;
      (this.o.onSpoolWriteFailed ?? this.o.onDegrade)?.(why);
      throw e;
    }
  }

  private holdForSession(buf: Buffer): void {
    if (!this.lateNotified) {
      this.lateNotified = true;
      this.o.onSessionLate?.({ lossy: (this.o.spoolMode ?? "full") === "none",
        bufferLimitBytes: this.waitingLimit });
    }
    this.waiting.push(buf);
    this.waitingBytes += buf.length;
    if (!(this.waitingBytes > this.waitingLimit)) return;
    if (this.spool.enabled) this.degradeLate();
    else {
      this.overflowNow(`下一分 P 的上传会话未及时就绪,零落盘等待缓冲已满(${Math.round(this.waitingLimit / MiB)}MiB),该分 P 丢失`);
      this.waitAbandoned = true;
    }
  }

  /** Idempotent; the tail must become visible before the queue wakes its remaining reader. */
  seal(): void {
    if (this.sealed) return;
    this.sealed = true;
    this.spool.close();
    if (this.ready) this.closeQueue();
    this.markSealed();
  }

  discard(): void {
    this.nonUploadFail = true;
    this.uploadError ??= "discarded";
    this.seal();
    this.buffer.close();
    this.spool.discard();
  }

  private closeQueue(): void {
    if (!this.uploadError && !this.overflow && !this.buffer.pushTail()) this.overflowNow();
    this.buffer.close();
  }

  private attach(session: PreuploadResult): void {
    this.session = session;
    this.buffer.configure(this.o.chunkSize ?? session.bucket.chunkSize);
    this.ready = true;
    if (this.lateDegraded) {
      this.markSettled();
      return;
    }
    if (!this.buffer.disabled) this.uploadTask = this.startUpload(session);
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
    this.degrade(`下一分 P 的上传会话未及时就绪,等待缓冲已满(${Math.round(this.waitingLimit / MiB)}MiB),按整文件回退上传`);
  }

  private overflowNow(reason?: string): void {
    this.overflow = true;
    this.waiting = [];
    this.waitingBytes = 0;
    this.buffer.clearCarry();
    const why = reason ?? (this.spool.enabled
      ? `上传跟不上录制,队列已满(${this.buffer.queuedChunks} 块),本段降级为纯落盘`
      : `上传跟不上录制,队列已满(${this.buffer.queuedChunks} 块),零落盘无本地副本,该分 P 丢失`);
    // A truncated transfer in full mode must take the whole-file fallback, never complete.
    if (this.spool.enabled) this.uploadError ??= why;
    this.o.onBackpressure?.(this.spool.bytes, this.buffer.queuedChunks);
    this.degrade(why);
  }

  private feed(buf: Buffer): void {
    if (this.uploadError || this.overflow || !this.sessionPlanned) return;
    if (!this.buffer.append(buf)) this.overflowNow();
  }

  private startUpload(session: PreuploadResult): Promise<void> {
    const o = this.o;
    return uploadChunks({
      session,
      totalSize: o.sizeCap,
      totalSizeOf: () => this.buffer.totalSize(this.sealed, o.sizeCap),
      fetchImpl: o.fetchImpl ?? fetch,
      retries: 3,
      signal: o.signal,
      maxChunks: () => Math.ceil(this.buffer.totalSize(this.sealed, o.sizeCap) / this.buffer.chunkSize),
      onProgress: (p) => {
        this.chunksUploaded = p.chunksDone;
        this.streamed = p.uploadedBytes;
        o.onChunk?.(p.uploadedBytes, p.chunksDone);
      },
      readChunk: async (index, size) => {
        const chunk = await this.buffer.shift();
        if (!chunk) throw new Error(`流比声明的 ${o.sizeCap}B 短:第 ${index} 块(${size}B)没有数据`);
        return chunk;
      },
    }).then(() => undefined, (e: unknown) => {
      const msg = String((e as Error)?.message ?? e).slice(0, 300);
      // An exact-boundary EOF after a sealed, intact part is not a failed upload.
      if (this.sealed && !this.overflow && this.buffer.hasData && /没有数据|流比声明的/.test(msg)) return;
      this.uploadError ??= msg;
      if (this.nonUploadFail || o.signal?.aborted || (e as Error)?.name === "AbortError") return;
      if (this.spool.bytes === 0) return;
      this.degrade(o.spoolMode === "none" ? `${msg};零落盘无本地副本,该分 P 丢失` : msg);
    });
  }

  private async finish(): Promise<PartSinkResult> {
    await this.sealedP;
    if (this.lateDegraded || this.waitAbandoned) {
      // Abandoned sessions must not delay a complete spool or a known zero-disk loss.
      if (this.lateDegraded) this.uploadError ??= "下一分 P 的上传会话未及时就绪,按整文件回退上传";
      this.o.onSessionAbandoned?.({ lossy: this.waitAbandoned });
      this.buffer.close();
    } else {
      await this.settledP;
      await this.uploadTask;
    }
    return {
      ...(this.session ? { session: this.session } : {}),
      chunksUploaded: this.chunksUploaded,
      streamedBytes: this.streamed,
      spooledBytes: this.spool.bytes,
      spoolIncomplete: this.spool.incomplete,
      ...(this.sizeOverflow ? { sizeOverflow: true } : {}),
      uploadError: this.uploadError,
      ...(this.degradedReason ? { degradedReason: this.degradedReason } : {}),
      sessionLeaked: this.uploadError != null && this.chunksUploaded > 0,
      backpressured: this.overflow && !this.lateDegraded,
    };
  }
}
