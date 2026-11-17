import { existsSync } from "node:fs";
import type { LivePumpDelivery } from "./live-pump-delivery.js";
import type { LivePumpPartContext as PartCtx, PartDisposition as Disposition } from "./live-pump-finalization.js";
import type { PartSinkResult } from "./live-pump-part-sink.js";
import type { SealedPart, SegmentExit, SegmentRunResult } from "./live-pump-types.js";
import { livePumpStatePath } from "./live-pump-state.js";
import { heldGapPath } from "./live-pump-spool-recovery.js";
import { finalizeRecordedPart } from "./live-pump-validation.js";
import { segmentResultOf } from "./live-pump-segment.js";
import { MiB, MIN_PART_BYTES, NO_EXIT, recoveryDeadlineAfterPart } from "./live-pump-policy.js";
export class SpoolPartDelivery {
  constructor(private readonly runState: LivePumpDelivery, private readonly ctx: PartCtx, private readonly part: SealedPart, private readonly exit: SegmentExit | undefined, private readonly sinkRes: PartSinkResult) {
  }
  private get spoolIncomplete(): boolean | undefined {
    return this.sinkRes.spoolIncomplete || this.part.sink.incomplete;
  }
  private get heldPath(): string {
    return heldGapPath(this.ctx.spoolPath);
  }
  private prepare(): Disposition | undefined {
    if (this.runState.spoolWalBroken) {
      return this.runState.finalization.fail({
        ok: false,
        error: `恢复状态写入失败,spool 失去状态保护,停止录制: ${this.runState.spoolWalBroken}`,
        bvid: this.runState.session.bvid,
        aid: this.runState.session.aid,
        title: this.runState.session.archiveTitle,
        segments: [...this.runState.segments],
        spoolDir: this.runState.o.spoolDir,
        statePath: livePumpStatePath(this.runState.o.spoolDir, this.runState.o.room),
      });
    }
    const spooled = this.sinkRes.spooledBytes;
    if (spooled === 0) {
      if (this.part.sealedBy === "stalled" && !this.spoolIncomplete) {
        this.runState.session.dropPart(this.ctx.index);
        return { kind: "stall-empty" };
      }
      if (!this.sinkRes.uploadError) {
        this.runState.events.log("[直播直传] 本段没有写入,判定已收播");
        this.runState.session.dropPart(this.ctx.index);
        return { kind: "ended" };
      }
      return this.runState.finalization.fail({
        ok: false,
        error: this.sinkRes.uploadError,
        bvid: this.runState.session.bvid,
        aid: this.runState.session.aid,
        title: this.runState.session.archiveTitle,
        segments: [...this.runState.segments],
        spoolDir: this.runState.o.spoolDir,
        statePath: livePumpStatePath(this.runState.o.spoolDir, this.runState.o.room),
      });
    }
  }
  private validate(): Promise<SegmentRunResult> {
    const heldPath = this.heldPath;
    return finalizeRecordedPart({
      rec: segmentResultOf(this.part, this.sinkRes, this.exit ?? NO_EXIT),
      session: undefined,
      cookiesPath: this.runState.o.cookiesPath,
      fileName: this.ctx.fileName,
      spoolPath: this.ctx.spoolPath,
      spoolMode: this.runState.spoolMode,
      line: this.runState.o.line ?? "txa",
      fetchImpl: this.runState.o.fetchImpl,
      signal: this.ctx.ac.signal,
      probeDuration: this.runState.o.probeDuration,
      scanDtsGap: this.runState.o.scanDtsGap,
      ...(this.runState.o.sleep ? { sleep: this.runState.o.sleep } : {}),
      submit: false,
      keepSpool: true,
      isClosed: () => this.runState.closed,
      onHold: () => {
        this.runState.session.noteUnconfirmedPart({
          index: this.ctx.index,
          spoolPath: heldPath,
          title: this.runState.o.partTitle?.(this.ctx.index + 1, this.runState.liveTitle) ?? this.ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
          bytes: this.sinkRes.spooledBytes,
          durationSec: 0,
          spoolIncomplete: true,
        });
      },
    });
  }
  private holdGap(r: SegmentRunResult): Disposition | undefined {
    const heldPath = this.heldPath;
    if (r.tsGap) {
      const gap = r.tsGap;
      const gapTitle = this.runState.o.partTitle?.(this.ctx.index + 1, this.runState.liveTitle) ?? this.ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, "");
      const gapNote = existsSync(heldPath) ? this.runState.session.noteUnconfirmedPart({ index: this.ctx.index, spoolPath: heldPath, title: gapTitle, bytes: r.spooledBytes, durationSec: r.spoolDurationSec ?? 0, spoolIncomplete: true }) : this.runState.session.noteUnconfirmedPart({ index: this.ctx.index, spoolPath: this.ctx.spoolPath, title: gapTitle, bytes: r.spooledBytes, durationSec: r.spoolDurationSec ?? 0, spoolIncomplete: true });
      if (!gapNote.ok) {
        return this.runState.finalization.fail({
          ok: false,
          error: `恢复状态写入失败,DTS 跳变分 P 无法标记需人工,停止录制: ${gapNote.error}`,
          bvid: this.runState.session.bvid,
          aid: this.runState.session.aid,
          title: this.runState.session.archiveTitle,
          segments: [...this.runState.segments],
          spoolDir: this.runState.o.spoolDir,
          statePath: livePumpStatePath(this.runState.o.spoolDir, this.runState.o.room),
        });
      }
      const msg = `段${this.ctx.seg + 1} 时间戳跳变(流${gap.streamIndex}: ${gap.fromSec.toFixed(1)}s → ${gap.toSec.toFixed(1)}s),不交队列,spool 保留需人工处理`;
      this.runState.events.log(`[直播直传] ⚠️ ${msg}`);
      try {
        this.runState.o.onAlert?.(msg);
      }
      catch {
      }
      this.runState.recoveryDeadline = this.part.final ? recoveryDeadlineAfterPart(this.part.sealedBy, Date.now(), this.runState.recoverWindowMs) : undefined;
      return this.part.final || this.part.sealedBy === "abort" ? { kind: "ended" } : { kind: "continue" };
    }
  }
  private invalid(r: SegmentRunResult): Disposition | undefined {
    if (r.localValidationFailed || r.uploadError || r.spoolIncomplete || !((r.spoolDurationSec ?? 0) > 0)) {
      if (!this.spoolIncomplete) {
        const note = this.runState.session.noteUnconfirmedPart({
          index: this.ctx.index,
          spoolPath: this.ctx.spoolPath,
          title: this.runState.o.partTitle?.(this.ctx.index + 1, this.runState.liveTitle) ?? this.ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
          bytes: r.spooledBytes,
          durationSec: r.spoolDurationSec ?? 0,
          spoolIncomplete: true,
        });
        if (!note.ok) {
          return this.runState.finalization.fail({
            ok: false,
            error: `恢复状态写入失败,自检未过分 P 无法标记需人工,停止录制: ${note.error}`,
            bvid: this.runState.session.bvid,
            aid: this.runState.session.aid,
            title: this.runState.session.archiveTitle,
            segments: [...this.runState.segments],
            spoolDir: this.runState.o.spoolDir,
            statePath: livePumpStatePath(this.runState.o.spoolDir, this.runState.o.room),
          });
        }
      }
      const msg = `段${this.ctx.seg + 1} 产物自检未过(${r.uploadError ?? "spool 截断/无有效时长"}),spool 保留需人工处理,录制继续`;
      this.runState.events.log(`[直播直传] ⚠️ ${msg}`);
      try {
        this.runState.o.onAlert?.(msg);
      }
      catch {
      }
      this.runState.recoveryDeadline = this.part.final ? recoveryDeadlineAfterPart(this.part.sealedBy, Date.now(), this.runState.recoverWindowMs) : undefined;
      return this.part.final || this.part.sealedBy === "abort" ? { kind: "ended" } : { kind: "continue" };
    }
  }
  private accept(r: SegmentRunResult): Disposition {
    const spooled = this.sinkRes.spooledBytes;
    const validated = this.runState.session.markValidated(this.ctx.index);
    if (!validated.ok) {
      return this.runState.finalization.fail({
        ok: false,
        error: `恢复状态写入失败,本地校验通过标记无法持久化,停止录制: ${validated.error}`,
        bvid: this.runState.session.bvid,
        aid: this.runState.session.aid,
        title: this.runState.session.archiveTitle,
        segments: [...this.runState.segments],
        spoolDir: this.runState.o.spoolDir,
        statePath: livePumpStatePath(this.runState.o.spoolDir, this.runState.o.room),
      });
    }
    this.runState.pushSegment({
      seg: this.ctx.seg + 1,
      chunks: 0,
      bytes: spooled,
      spooled,
      ms: Date.now() - this.ctx.openedAt,
      exit: this.exit?.code ?? null,
      backpressured: false,
      sessionLeaked: false,
      ...(r.spoolDurationSec ? { spoolDurationSec: r.spoolDurationSec } : {}),
    });
    this.runState.events.log(`[直播直传] 段${this.ctx.seg + 1} 已封口落盘(${(spooled / MiB).toFixed(1)}MiB),收播后由节点队列补传`);
    this.runState.events.emit({ at: Date.now(), kind: "part_deferred", part: this.ctx.index, bytes: spooled });
    this.runState.recoveryDeadline = this.part.final ? recoveryDeadlineAfterPart(this.part.sealedBy, Date.now(), this.runState.recoverWindowMs) : undefined;
    if (!this.part.final)
      return { kind: "continue" };
    if (this.part.sealedBy === "abort")
      return { kind: "ended" };
    if (spooled < MIN_PART_BYTES && this.part.sealedBy !== "stalled" && !this.part.stopped) {
      this.runState.events.log("[直播直传] 本段 < 1MiB,判定已收播");
      return { kind: "ended" };
    }
    return { kind: "continue" };
  }
  async run(): Promise<Disposition> {
    const early = this.prepare();
    if (early)
      return early;
    const r = await this.validate();
    if (this.runState.closed)
      return { kind: "ended" };
    return this.holdGap(r) ?? this.invalid(r) ?? this.accept(r);
  }
}
