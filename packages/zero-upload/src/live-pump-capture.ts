import { statfsSync } from "node:fs";
import { freeGBOf, resolveDiskMinGB } from "@drec/core";
import { PartSink } from "./live-pump-part-sink.js";
import { buildPipeFfmpegArgs } from "./live-pump-process.js";
import { runStream } from "./live-pump-stream.js";
import { preuploadWithBackoff } from "./live-pump-spool-recovery.js";
import { livePumpStatePath, readLivePumpState } from "./live-pump-state.js";
import { livePumpHasUnconfirmed } from "./live-pump-confirmations.js";
import { MiB } from "./live-pump-policy.js";
import type { LivePumpDelivery } from "./live-pump-delivery.js";
import type { LivePumpObserver } from "./live-pump-observer.js";
import type { LivePumpPartContext as PartCtx, PartDisposition as Disposition } from "./live-pump-finalization.js";
import type { PreuploadResult } from "./upos-stream.js";
import type { StreamRunResult } from "./live-pump-types.js";
import type { StreamAcquirer } from "./live-pump-source.js";
import type { RunLivePumpOptions, RunLivePumpResult } from "./live-pump-run-options.js";
/** Owns connection resources and index allocation; sealed parts keep independent cancellation. */
export class LivePumpCapture {
  partSeq = 0;
  partsOpened = 0;
  spoolDiskStopReason: string | undefined;
  private nextIndex: number;
  private readonly maxSegments: number;
  private readonly spoolDirClean: string;
  private readonly fileNames = new Map<number, string>();
  private connSignal!: AbortSignal;
  private prefetch: {
    promise: Promise<PreuploadResult>;
    abort: AbortController;
  } | undefined;
  constructor(private readonly o: RunLivePumpOptions, private readonly delivery: LivePumpDelivery, private readonly events: LivePumpObserver) {
    this.nextIndex = delivery.session.nextPartIndex;
    this.maxSegments = Math.max(0, o.maxSegments ?? 0);
    this.spoolDirClean = o.spoolDir.replace(/\/$/, "");
  }
  defaultFileName(seg: number): string {
    return `${Date.now()}_${String(seg).padStart(3, "0")}.live.ts`;
  }
  fileNameFor(seg: number): string {
    let n = this.fileNames.get(seg);
    if (n === undefined) {
      n = this.o.spoolName ? this.o.spoolName(seg) : this.defaultFileName(seg);
      this.fileNames.set(seg, n);
    }
    return n;
  }
  startPreupload(fileName: string, signal: AbortSignal): Promise<PreuploadResult> {
    const p = preuploadWithBackoff({
      cookiesPath: this.o.cookiesPath,
      fileName,
      sizeCap: this.o.sizeCap,
      line: this.o.line ?? "txa",
      fetchImpl: this.o.fetchImpl,
      signal,
      log: this.events.log,
      sleep: this.o.sleep,
    });
    p.catch(() => {
    });
    return p;
  }
  private noteOpen(index: number, seg: number, fileName: string, spoolPath: string): void {
    if (this.delivery.spoolMode === "full" && this.o.submit !== false) {
      const note = this.delivery.session.noteUnconfirmedPart({
        index,
        spoolPath,
        title: this.o.partTitle?.(index + 1, this.delivery.liveTitle) ?? fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
        bytes: 0,
        durationSec: 0,
        sealed: false,
      });
      if (!note.ok) {
        this.events.log(`[直播直传] ⚠️ 段${seg + 1} 无法在 open 时写 WAL: ${note.error}`);
        if (this.delivery.spoolOnlyRun)
          this.delivery.spoolWalBroken = note.error;
      }
    }
  }
  openPart(preupload: PreuploadResult | Promise<PreuploadResult> | undefined, fileName: string, sessionAbort?: AbortController): PartSink {
    const seg = this.partSeq++;
    const index = this.nextIndex++;
    this.partsOpened++;
    const spoolPath = `${this.spoolDirClean}/${fileName}`;
    this.noteOpen(index, seg, fileName, spoolPath);
    this.events.emit({ at: Date.now(), kind: "part_streaming", part: index });
    const onChunk = (b: number, n: number): void => {
      this.events.log(`[直播直传] 段${seg + 1} 第 ${n} 块完成,累计 ${(b / MiB).toFixed(1)}MiB`);
      this.events.progress({ part: index, uploadedBytes: b, chunks: n });
    };
    const ac = new AbortController();
    const sink = new PartSink({
      sizeCap: this.o.sizeCap,
      spoolPath,
      session: preupload,
      spoolMode: this.delivery.spoolMode,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
      ...(this.o.queueCapacity !== undefined ? { queueCapacity: this.o.queueCapacity } : {}),
      signal: ac.signal,
      onChunk,
      onSessionLate: ({ lossy, bufferLimitBytes }) => {
        this.events.log(lossy ? `[直播直传] ⚠️ 段${seg + 1} 上传会话未及时就绪(预取 preupload 被限流/超时);零落盘仅能缓冲 ${(bufferLimitBytes / MiB).toFixed(0)}MiB,超出该分 P 将丢失` : `[直播直传] 段${seg + 1} 上传会话未及时就绪,继续写 spool;会话就绪后补传,否则整文件回退`);
      },
      onSessionAbandoned: () => {
        ctx.sessionAbort?.abort();
      },
      onDegrade: reason => {
        this.events.log(`[直播直传] ⚠️ 段${seg + 1} 流式上传降级: ${reason}`);
        try {
          this.o.onAlert?.(`段${seg + 1} 流式上传降级: ${reason}`);
        }
        catch {
        }
      },
      onSpoolWriteFailed: reason => {
        this.delivery.session.markSpoolIncomplete(index);
        this.events.log(`[直播直传] ⚠️ 段${seg + 1} ${reason}`);
        try {
          this.o.onAlert?.(`段${seg + 1} ${reason}`);
        }
        catch {
        }
      },
      ...(this.o.writeSpool ? { writeSpool: this.o.writeSpool } : {}),
    });
    const ctx: PartCtx = { index, seg, fileName, spoolPath, openedAt: Date.now(), onChunk, ac, sealed: false, submitting: false, ...(sessionAbort ? { sessionAbort } : {}) };
    this.delivery.finalization.register(sink, ctx, this.connSignal);
    return sink;
  }
  openNext(): PartSink {
    const fileName = this.fileNameFor(this.partSeq);
    if (this.delivery.spoolOnlyRun)
      return this.openPart(undefined, fileName);
    const pre = this.prefetch;
    this.prefetch = undefined;
    if (pre)
      return this.openPart(pre.promise, fileName, pre.abort);
    const own = new AbortController();
    return this.openPart(this.startPreupload(fileName, AbortSignal.any([this.connSignal, own.signal])), fileName, own);
  }
  onPrefetch(): void {
    if (this.prefetch || this.delivery.finalization.failed || this.delivery.spoolOnlyRun)
      return;
    if (this.o.drainSignal?.aborted || (this.maxSegments > 0 && this.partsOpened >= this.maxSegments))
      return;
    const ac = new AbortController();
    this.prefetch = {
      promise: this.startPreupload(this.fileNameFor(this.partSeq), AbortSignal.any([this.connSignal, ac.signal])),
      abort: ac,
    };
  }
  spoolDiskGate(): boolean {
    if (this.spoolDiskStopReason)
      return true;
    if (!this.delivery.spoolOnlyRun)
      return false;
    const minGB = resolveDiskMinGB(this.o.diskMinGB).gb;
    if (minGB <= 0)
      return false;
    try {
      const free = freeGBOf((this.o.statfsImpl ?? statfsSync)(this.o.spoolDir));
      if (free >= minGB)
        return false;
      this.spoolDiskStopReason = `spool 盘剩余 ${free.toFixed(1)}GB,低于水位 ${minGB}GB`;
      this.events.log(`[直播直传] ⚠️ ${this.spoolDiskStopReason},停止开新分 P(已封口分 P 收播后仍入队)`);
      try {
        this.o.onAlert?.(this.spoolDiskStopReason);
      }
      catch {
      }
      return true;
    }
    catch {
    }
    return false;
  }
  async stopAtCut(): Promise<boolean> {
    return !!this.o.signal?.aborted || !!this.o.drainSignal?.aborted || (this.maxSegments > 0 && this.partsOpened >= this.maxSegments) || this.spoolDiskGate() || !!(await this.o.shouldStop?.());
  }
  private async first(): Promise<PartSink | RunLivePumpResult> {
    const firstName = this.fileNameFor(this.partSeq);
    if (this.delivery.spoolOnlyRun && this.spoolDiskGate()) {
      const pendingStatePath = livePumpStatePath(this.o.spoolDir, this.o.room);
      if (livePumpHasUnconfirmed(pendingStatePath)) {
        const qs = readLivePumpState(pendingStatePath);
        return {
          ok: false,
          uploadPending: true,
          error: "queued uploads pending",
          title: this.delivery.session.archiveTitle,
          segments: [...this.delivery.segments],
          spoolDir: this.o.spoolDir,
          statePath: pendingStatePath,
          ...(qs?.bvid ? { bvid: qs.bvid } : {}),
          ...(qs?.aid ? { aid: qs.aid } : {}),
        };
      }
      return {
        ok: false,
        error: this.spoolDiskStopReason,
        bvid: this.delivery.session.bvid,
        aid: this.delivery.session.aid,
        title: this.delivery.session.archiveTitle,
        segments: [...this.delivery.segments],
        spoolDir: this.o.spoolDir,
        statePath: livePumpStatePath(this.o.spoolDir, this.o.room),
      };
    }
    const firstSession = this.delivery.spoolOnlyRun ? undefined : await preuploadWithBackoff({
      cookiesPath: this.o.cookiesPath,
      fileName: firstName,
      sizeCap: this.o.sizeCap,
      line: this.o.line ?? "txa",
      fetchImpl: this.o.fetchImpl,
      signal: this.connSignal,
      log: this.events.log,
      sleep: this.o.sleep,
    });
    return this.openPart(firstSession, firstName);
  }
  private async record(s: StreamAcquirer, firstSink: PartSink): Promise<StreamRunResult> {
    let stream: StreamRunResult;
    try {
      stream = await runStream({
        args: buildPipeFfmpegArgs({ url: s.url!, headers: s.headers }),
        sizeCap: this.o.sizeCap,
        maxMs: this.o.maxMs,
        firstSink,
        openNext: () => this.openNext(),
        onPrefetch: () => this.onPrefetch(),
        stopAtCut: () => this.stopAtCut(),
        onPartSealed: part => {
          const c = this.delivery.finalization.seal(part);
          this.delivery.noteSealed(c, part);
          this.events.emit({ at: Date.now(), kind: "part_sealed", part: c.index, bytes: part.sink.spooledBytes });
          void this.delivery.finalization.enqueue(part);
        },
        onWarn: m => this.events.log(`[直播直传] ⚠️ ${m}`),
        signal: this.connSignal,
        stallTimeoutMs: this.o.stallTimeoutMs,
      });
    }
    finally {
      this.prefetch?.abort.abort();
      this.prefetch = undefined;
    }
    return stream;
  }
  private async finish(stream: StreamRunResult): Promise<{
    ended: boolean;
  } | RunLivePumpResult> {
    this.events.phase("finalizing");
    let finalDisposition: Disposition | undefined;
    let finalRun: Promise<Disposition> | undefined;
    if (stream.endedBy === "stalled") {
      const ctx = stream.finalPart ? this.delivery.finalization.context(stream.finalPart.sink) : undefined;
      const silentSec = Math.max(1, Math.ceil((stream.stalledMs ?? 0) / 1000));
      this.events.emit({
        at: Date.now(),
        kind: "stalled",
        ...(ctx ? { part: ctx.index, bytes: stream.finalPart!.sink.spooledBytes } : {}),
        message: `${silentSec}s no data`,
      });
      this.events.log("[状态] 录制停滞");
      this.events.log(`[直播直传] 段${(ctx?.seg ?? this.partSeq - 1) + 1} 源流已 ${silentSec}s 无写入,自动封口并尝试追到当前稿件`);
    }
    if (stream.finalPart) {
      const fp = stream.finalPart;
      const fc = this.delivery.finalization.seal(fp);
      this.delivery.noteSealed(fc, fp);
      this.events.emit({ at: Date.now(), kind: "part_sealed", part: fc.index, bytes: fp.sink.spooledBytes });
      finalRun = this.delivery.finalization.enqueue(fp, stream.exit);
    }
    else if (stream.discardedTail) {
      const droppedCtx = stream.discardedSink ? this.delivery.finalization.context(stream.discardedSink) : undefined;
      if (droppedCtx)
        this.delivery.session.dropPart(droppedCtx.index);
      this.partSeq--;
      this.nextIndex--;
      this.partsOpened--;
      this.fileNames.delete(this.partSeq);
      if (stream.discardedSink)
        this.delivery.finalization.discard(stream.discardedSink);
    }
    await this.delivery.finalization.settle();
    if (finalRun)
      finalDisposition = await Promise.race([finalRun, Promise.resolve<Disposition>({ kind: "ended" })]);
    const failure = this.delivery.finalization.failure;
    if (failure)
      return failure;
    if (stream.endedBy === "stalled" && (stream.discardedTail || finalDisposition?.kind === "stall-empty")) {
      this.delivery.recoveryDeadline ??= Date.now() + this.delivery.recoverWindowMs;
      return { ended: false };
    }
    return { ended: finalDisposition?.kind === "ended" };
  }
  async connect(stream: StreamAcquirer): Promise<{
    ended: boolean;
  } | RunLivePumpResult> {
    this.connSignal = this.delivery.finalization.connect();
    const first = await this.first();
    if (!(first instanceof PartSink))
      return first;
    return this.finish(await this.record(stream, first));
  }
}
