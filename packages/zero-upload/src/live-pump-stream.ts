import { TsCutter, type CutterEvent, type PartTiming } from "./ts-cutter.js";
import { LivePumpProcess } from "./live-pump-process.js";
import { DEFAULT_STALL_TIMEOUT_MS } from "./live-pump-policy.js";
import type { PartSink } from "./live-pump-part-sink.js";
import type { RunStreamOpts, SealedBy, SealedPart, StreamRunResult } from "./live-pump-types.js";

/** One connection keeps pulling while sealed parts finalize on the caller's ordered chain. */
class StreamCapture {
  private readonly cutter: TsCutter;
  private readonly process: LivePumpProcess;
  private current: PartSink;
  private currentStartedAt: number;
  private lastDataAt: number;
  private discBase = 0;
  private prefetched = false;
  private stalled = false;
  private stalledAt = 0;
  private stoppedAtCut = false;
  private readError: string | undefined;
  private finalPart: SealedPart | undefined;
  private readonly onAbort = (): void => { this.process.stop(); };

  constructor(private readonly o: RunStreamOpts) {
    this.cutter = new TsCutter({
      maxPartBytes: o.sizeCap,
      ...(o.maxMs && o.maxMs > 0 ? { maxDurationMs: o.maxMs } : {}),
      onPtsJump: (jump) => o.onWarn?.("视频时间戳跳变 " + jump.fromSec.toFixed(1)
        + "s → " + jump.toSec.toFixed(1) + "s,按不连续处理(不计入分 P 时长)"),
    });
    this.currentStartedAt = this.lastDataAt = Date.now();
    this.process = new LivePumpProcess(o.args, o.destroyGraceMs);
    this.current = o.firstSink;
    if (o.signal?.aborted) this.onAbort();
    else o.signal?.addEventListener("abort", this.onAbort, { once: true });
  }

  private armStallWatch(): NodeJS.Timeout | undefined {
    const timeout = this.o.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    if (timeout <= 0) return undefined;
    return setInterval(() => {
      if (this.process.closed || this.o.signal?.aborted || this.stalled) return;
      if (Date.now() - this.lastDataAt < timeout) return;
      this.stalled = true;
      this.stalledAt = Date.now();
      this.process.stop();
    }, Math.max(25, Math.min(5_000, Math.floor(timeout / 4))));
  }

  private seal(reason: SealedBy, final: boolean, timing: PartTiming | null, bytes: number): SealedPart {
    this.current.seal();
    const part: SealedPart = {
      sink: this.current, sealedBy: reason, bytes, timing, final,
      ...(final && this.stoppedAtCut ? { stopped: true } : {}),
      tsDiscontinuities: this.process.discontinuities - this.discBase,
      sealedMs: (this.stalled ? this.lastDataAt : Date.now()) - this.currentStartedAt,
      ...(final && this.stalled ? { stalledMs: this.stalledAt - this.lastDataAt } : {}),
      ...(timing?.ptsJumpSec ? {
        ptsJumpSec: timing.ptsJumpSec, ptsJumpCount: timing.ptsJumpCount,
      } : {}),
    };
    this.discBase = this.process.discontinuities;
    return part;
  }

  private async apply(events: CutterEvent[], finalizing: boolean): Promise<void> {
    for (const event of events) {
      if (event.kind === "data") { this.current.write(event.bytes); continue; }
      const stop = finalizing ? false : !!(await this.o.stopAtCut?.());
      if (stop) this.stoppedAtCut = true;
      const reason = event.reason === "requested" || event.reason === "duration" ? "duration" : "cap";
      const part = this.seal(reason, stop, event.timing, event.partBytes);
      if (stop) {
        this.finalPart = part;
        this.process.stop();
        return;
      }
      this.o.onPartSealed(part);
      this.current = this.o.openNext();
      this.currentStartedAt = Date.now();
      this.prefetched = false;
    }
  }

  private afterPush(): void {
    const timing = this.cutter.currentTiming();
    const durationMs = timing ? timing.durationSec * 1000 : 0;
    // No PTS clock: request a keyframe cut from elapsed wall time.
    if (!timing && this.o.maxMs && this.o.maxMs > 0
      && Date.now() - this.currentStartedAt >= this.o.maxMs) this.cutter.requestCut();
    if (this.prefetched || !this.o.onPrefetch) return;
    const ratio = this.o.prefetchRatio ?? 0.8;
    if (this.cutter.currentPartBytes >= this.cutter.sizeTriggerBytes * ratio
      || (this.o.maxMs && this.o.maxMs > 0 && durationMs >= this.o.maxMs * ratio)) {
      this.prefetched = true;
      this.o.onPrefetch();
    }
  }

  private async read(): Promise<void> {
    try {
      for await (const data of this.process.child.stdout!) {
        if (this.o.signal?.aborted) break;
        if (!this.stalled) this.lastDataAt = Date.now();
        const buffer = Buffer.isBuffer(data) ? data
          : typeof data === "string" ? Buffer.from(data) : Buffer.from(data as Uint8Array);
        await this.apply(this.cutter.push(buffer), false);
        if (this.stoppedAtCut || this.stalled) break;
        this.afterPush();
      }
    } catch (error) {
      if (!this.stalled && !this.o.signal?.aborted && !this.process.killed && !this.process.closed) {
        this.readError = String((error as Error)?.message ?? error).slice(0, 300);
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.stoppedAtCut) return;
    try { await this.apply(this.cutter.flush(), true); }
    catch (error) { this.readError ??= String((error as Error)?.message ?? error).slice(0, 300); }
  }

  private finishTail(): Pick<StreamRunResult, "endedBy" | "discardedTail" | "discardedSink"> {
    if (this.stoppedAtCut) return { endedBy: "stopped", discardedTail: false };
    const endedBy = this.o.signal?.aborted ? "abort" : this.stalled ? "stalled"
      : this.cutter.currentPartBytes >= this.o.sizeCap ? "cap" : "eof";
    if (this.readError) this.current.fail(this.readError);
    if (this.current !== this.o.firstSink && this.cutter.currentMediaBytes === 0 && !this.readError) {
      this.current.discard();
      return { endedBy, discardedTail: true, discardedSink: this.current };
    }
    this.finalPart = this.seal(endedBy, true, this.cutter.currentTiming(), this.cutter.currentPartBytes);
    return { endedBy, discardedTail: false };
  }

  async run(): Promise<StreamRunResult> {
    const timer = this.armStallWatch();
    try { await this.read(); }
    finally {
      await this.flush();
      this.o.signal?.removeEventListener("abort", this.onAbort);
      if (timer) clearInterval(timer);
      this.process.clearDestroyTimer();
    }
    const tail = this.finishTail();
    const exit = await this.process.exit(tail.endedBy === "abort", this.o.exitGraceMs);
    if (this.finalPart) this.finalPart.tsDiscontinuities = this.process.discontinuities - this.discBase;
    return {
      exit, ...tail,
      ...(this.finalPart ? { finalPart: this.finalPart } : {}),
      ...(this.stalled ? { stalledMs: this.stalledAt - this.lastDataAt } : {}),
    };
  }
}

export async function runStream(o: RunStreamOpts): Promise<StreamRunResult> {
  return new StreamCapture(o).run();
}
