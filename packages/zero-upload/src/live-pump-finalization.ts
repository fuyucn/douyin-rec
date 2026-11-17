import type { PartSink } from "./live-pump-part-sink.js";
import type { RunLivePumpOptions, RunLivePumpResult, SealedPart, SegmentExit } from "./live-pump.js";

export interface LivePumpPartContext {
  index: number;
  seg: number;
  fileName: string;
  spoolPath: string;
  openedAt: number;
  onChunk: (streamedBytes: number, chunksDone: number) => void;
  ac: AbortController;
  sealed: boolean;
  part?: SealedPart;
  submitting: boolean;
  sessionAbort?: AbortController;
}

export type PartDisposition = { kind: "continue" } | { kind: "ended" } | { kind: "stall-empty" };

interface FinalizationOptions {
  stop: Pick<RunLivePumpOptions, "signal" | "finalizeBudgetMs">;
  finalize: (part: SealedPart, exit?: SegmentExit) => Promise<PartDisposition>;
  preserve: (ctx: LivePumpPartContext, part: SealedPart, why: string, probe: boolean) => Promise<void>;
  log: (message: string) => void;
}

/** Owns serial delivery and its cancellation resources; archive writes stay with the caller. */
export class LivePumpFinalization {
  private readonly parts = new Map<PartSink, LivePumpPartContext>();
  private tail: Promise<void> = Promise.resolve();
  private fatal: RunLivePumpResult | undefined;
  private thrown: { error: unknown } | undefined;
  private connection: AbortController | undefined;
  private stopAt: number | undefined;

  constructor(private readonly o: FinalizationOptions) {
    this.stopAt = o.stop.signal?.aborted ? Date.now() : undefined;
    if (o.stop.signal && !o.stop.signal.aborted) {
      o.stop.signal.addEventListener("abort", () => { this.stopAt = Date.now(); }, { once: true });
    }
  }

  get failed(): boolean { return !!(this.fatal || this.thrown); }

  /** A thrown finalizer error takes precedence over a returned failure, as in the run loop. */
  get failure(): RunLivePumpResult | undefined {
    if (this.thrown) throw this.thrown.error;
    return this.fatal;
  }

  context(sink: PartSink): LivePumpPartContext | undefined { return this.parts.get(sink); }

  connect(): AbortSignal {
    this.connection = new AbortController();
    return this.o.stop.signal
      ? AbortSignal.any([this.o.stop.signal, this.connection.signal])
      : this.connection.signal;
  }

  register(sink: PartSink, ctx: LivePumpPartContext, signal: AbortSignal): void {
    this.parts.set(sink, ctx);
    if (signal.aborted) ctx.ac.abort();
    else {
      const onAbort = (): void => { if (!ctx.sealed) ctx.ac.abort(); };
      signal.addEventListener("abort", onAbort, { once: true });
      void sink.finished.then(() => signal.removeEventListener("abort", onAbort));
    }
  }

  seal(part: SealedPart): LivePumpPartContext {
    const ctx = this.parts.get(part.sink)!;
    ctx.sealed = true;
    ctx.part = part;
    return ctx;
  }

  discard(sink: PartSink): void { this.parts.delete(sink); }

  fail(result: RunLivePumpResult): PartDisposition {
    this.fatal ??= result;
    this.connection?.abort();
    return { kind: "ended" };
  }

  enqueue(part: SealedPart, exit?: SegmentExit): Promise<PartDisposition> {
    const run = this.tail.then(() => this.finalize(part, exit));
    this.tail = run.then(() => { this.parts.delete(part.sink); });
    return run;
  }

  private async finalize(part: SealedPart, exit?: SegmentExit): Promise<PartDisposition> {
    const ctx = this.parts.get(part.sink);
    if (!ctx) return { kind: "ended" };
    if (this.failed) {
      ctx.ac.abort();
      await this.o.preserve(ctx, part, "前序分 P 已失败,本分 P 未提交", true);
      return { kind: "ended" };
    }
    try {
      return await this.o.finalize(part, exit);
    } catch (e) {
      if (ctx.ac.signal.aborted || this.o.stop.signal?.aborted) {
        await this.o.preserve(ctx, part, "已停止,分 P 未传完", false).catch(() => {});
        return { kind: "ended" };
      }
      this.thrown ??= { error: e };
      this.connection?.abort();
      return { kind: "ended" };
    }
  }

  /** The budget starts at the original stop signal, including capture teardown time. */
  async settle(): Promise<void> {
    const chain = this.tail;
    const budgetMs = Math.max(0, this.o.stop.finalizeBudgetMs ?? 7_000);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const budget = new Promise<"budget">((resolve) => {
      const arm = (): void => {
        const left = Math.max(0, (this.stopAt ?? Date.now()) + budgetMs - Date.now());
        timer = setTimeout(() => resolve("budget"), left);
      };
      if (this.o.stop.signal?.aborted) arm();
      else if (this.o.stop.signal) {
        onAbort = arm;
        this.o.stop.signal.addEventListener("abort", arm, { once: true });
      }
    });
    const first = await Promise.race([chain.then(() => "done" as const), budget]);
    if (timer) clearTimeout(timer);
    if (onAbort) this.o.stop.signal?.removeEventListener("abort", onAbort);
    if (first === "done") return;
    this.o.log("[直播直传] ⚠️ 停止后 " + budgetMs + "ms 内仍有 " + this.parts.size
      + " 个分 P 未收尾,中止并记入恢复状态");
    const pending = [...this.parts.entries()];
    for (const [, ctx] of pending) ctx.ac.abort();
    let grace: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      chain.then(() => true),
      new Promise<boolean>((resolve) => { grace = setTimeout(() => resolve(false), 1_500); }),
    ]);
    if (grace) clearTimeout(grace);
    if (settled) return;
    for (const [sink, ctx] of pending) {
      if (ctx.part && this.parts.has(sink)) {
        await this.o.preserve(ctx, ctx.part, "停止后收尾超时", false).catch(() => {});
      }
    }
  }

  cancel(): void {
    for (const ctx of this.parts.values()) ctx.ac.abort();
  }
}
