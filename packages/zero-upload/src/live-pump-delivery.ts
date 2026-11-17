import { rmSync } from "node:fs";
import { ffprobeDuration } from "@drec/post-process";
import { LivePumpFinalization, type LivePumpPartContext as PartCtx, type PartDisposition as Disposition } from "./live-pump-finalization.js";
import { LivePumpObserver } from "./live-pump-observer.js";
import { SpoolPartDelivery } from "./live-pump-spool-delivery.js";
import { DirectPartDelivery } from "./live-pump-direct-delivery.js";
import { livePumpStatePath } from "./live-pump-state.js";
import { livePumpHasUnconfirmed } from "./live-pump-confirmations.js";
import { DEFAULT_RECOVERY_WINDOW_MS, negligibleTail, estimateDuration } from "./live-pump-policy.js";
import type { LivePumpSession } from "./live-pump-session.js";
import type { RunLivePumpOptions, RunLivePumpResult, LivePumpSegmentReport } from "./live-pump-run-options.js";
import type { SealedPart, SegmentExit } from "./live-pump-types.js";
/** Owns ordered delivery, run closure, and accounting for deferred, lost or unknown parts. */
export class LivePumpDelivery {
  readonly finalization: LivePumpFinalization;
  readonly segments: LivePumpSegmentReport[] = [];
  readonly stopLost: string[] = [];
  readonly stopUnknown: string[] = [];
  readonly recoverWindowMs: number;
  recoveryDeadline: number | undefined;
  liveTitle: string | undefined;
  spoolWalBroken: string | undefined;
  closed = false;
  constructor(readonly o: RunLivePumpOptions, readonly session: LivePumpSession, readonly events: LivePumpObserver, public spoolOnlyRun: boolean) {
    this.recoverWindowMs = Math.max(1000, o.recoverWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS);
    this.finalization = new LivePumpFinalization({ stop: o, log: events.log, finalize: (part, exit) => this.finalizeOne(part, exit), preserve: (ctx, part, why, probe) => this.keepOrLose(ctx, part, why, probe), });
  }
  get spoolMode(): "full" | "none" {
    return this.o.spoolMode ?? "full";
  }
  pushSegment(x: LivePumpSegmentReport): void {
    if (!this.closed)
      this.segments.push(x);
  }
  titleOf(ctx: PartCtx): string {
    return this.o.partTitle?.(ctx.index + 1, this.liveTitle) ?? ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, "");
  }
  noteSealed(ctx: PartCtx, part: SealedPart): void {
    if (this.spoolMode !== "full" || this.o.submit === false)
      return;
    const bytes = part.sink.spooledBytes;
    if (bytes <= 0 || (negligibleTail(part) && !part.sink.incomplete) || this.session.parts.some(p => p.index === ctx.index && p.confirmed))
      return;
    const note = this.session.noteUnconfirmedPart({
      index: ctx.index,
      spoolPath: ctx.spoolPath,
      title: this.titleOf(ctx),
      bytes,
      durationSec: estimateDuration(part),
      ...(part.sink.incomplete ? { spoolIncomplete: true } : {}),
    });
    if (!note.ok) {
      this.events.log(`[直播直传] ⚠️ 段${ctx.seg + 1} 无法提前记入恢复状态: ${note.error}`);
      if (this.spoolOnlyRun)
        this.spoolWalBroken = note.error;
    }
  }
  async keepOrLose(ctx: PartCtx, part: SealedPart, why: string, probe: boolean): Promise<void> {
    if (this.closed)
      return;
    const label = `段${ctx.seg + 1}`;
    const row = this.session.parts.find(p => p.index === ctx.index);
    if (row?.confirmed)
      return;
    if (this.spoolMode === "none") {
      if (ctx.submitting) {
        this.stopUnknown.push(label);
        this.events.log(`[直播直传] ⚠️ ${label} ${why};归档提交请求进行中,结果未知(下次启动按状态文件核对),不是已丢失`);
        return;
      }
      this.stopLost.push(label);
      this.events.log(`[直播直传] ⚠️ ${label} ${why};零落盘无本地副本,该分 P 已丢失`);
      this.events.emit({ at: Date.now(), kind: "part_failed", part: ctx.index, message: `${why};无本地副本,已丢失` });
      return;
    }
    const bytes = part.sink.spooledBytes;
    const sinkIncomplete = part.sink.incomplete;
    if (negligibleTail(part) && !sinkIncomplete) {
      this.events.log(`[直播直传] ${label} ${why};只有不足两帧的尾巴,不值得保留`);
      this.session.dropPart(ctx.index);
      return;
    }
    if (this.o.submit === false || bytes <= 0) {
      this.events.log(`[直播直传] ${label} ${why}(spool 保留: ${ctx.spoolPath})`);
      return;
    }
    let durationSec = estimateDuration(part);
    if (probe) {
      try {
        const d = await (this.o.probeDuration ?? ffprobeDuration)(ctx.spoolPath);
        if (Number.isFinite(d) && d > 0)
          durationSec = d;
      }
      catch {
      }
    }
    if (this.closed)
      return;
    const note = this.session.noteUnconfirmedPart({
      index: ctx.index,
      spoolPath: ctx.spoolPath,
      title: this.titleOf(ctx),
      bytes,
      durationSec,
      ...(row?.stem ? { stem: row.stem } : {}),
      ...(sinkIncomplete ? { spoolIncomplete: true } : {}),
    });
    if (note.ok) {
      if (!row)
        this.events.emit({ at: Date.now(), kind: "part_unconfirmed", part: ctx.index, bytes });
      this.events.log(`[直播直传] ⚠️ ${label} ${why};已记入恢复状态,下次运行${sinkIncomplete ? "不自动重传(截断段需人工处理)," : "按整文件补传,"}spool: ${ctx.spoolPath}`);
    }
    else {
      this.stopLost.push(`${label}(恢复状态写入失败)`);
      this.events.log(`[直播直传] ⚠️ ${label} ${why};且无法记入恢复状态(${note.error}),spool 保留: ${ctx.spoolPath}`);
    }
  }
  private async finalizeOne(part: SealedPart, exit?: SegmentExit): Promise<Disposition> {
    const ctx = this.finalization.context(part.sink)!;
    const { index, seg, fileName, spoolPath } = ctx;
    const sig = ctx.ac.signal;
    const sinkRes = await part.sink.finished;
    if (this.closed)
      return { kind: "ended" };
    const spoolIncomplete = sinkRes.spoolIncomplete || part.sink.incomplete;
    if (negligibleTail(part) && sinkRes.spooledBytes > 0 && !spoolIncomplete) {
      this.events.log(`[直播直传] 段${seg + 1} 只有不足两帧(${sinkRes.spooledBytes}B),判定为切点后的尾巴,丢弃`);
      if (this.spoolMode === "full") {
        try {
          rmSync(spoolPath, { force: true });
        }
        catch {
        }
        this.session.dropPart(index);
      }
      return part.sealedBy === "stalled" ? { kind: "stall-empty" } : { kind: "ended" };
    }
    return this.spoolOnlyRun ? new SpoolPartDelivery(this, ctx, part, exit, sinkRes).run() : new DirectPartDelivery(this, ctx, part, exit, sinkRes).run();
  }
  finish(recoveryTimedOut: boolean): RunLivePumpResult {
    this.events.logSuppressedRatioAlerts();
    if (this.spoolOnlyRun && livePumpHasUnconfirmed(livePumpStatePath(this.o.spoolDir, this.o.room))) {
      return {
        ok: false,
        uploadPending: true,
        error: "queued uploads pending",
        bvid: this.session.bvid,
        aid: this.session.aid,
        title: this.session.archiveTitle,
        segments: [...this.segments],
        spoolDir: this.o.spoolDir,
        statePath: livePumpStatePath(this.o.spoolDir, this.o.room),
        ...(this.stopLost.length ? { lostParts: this.stopLost.length } : {}),
        ...(this.stopUnknown.length ? { unknownParts: this.stopUnknown.length } : {}),
      };
    }
    if (recoveryTimedOut && this.segments.length === 0) {
      return {
        ok: false,
        error: `源流停滞且恢复窗口内没有重新开播(窗口 ${Math.round(this.recoverWindowMs / 60000)} 分钟)`,
        bvid: this.session.bvid,
        aid: this.session.aid,
        title: this.session.archiveTitle,
        segments: [...this.segments],
        spoolDir: this.o.spoolDir,
        statePath: livePumpStatePath(this.o.spoolDir, this.o.room),
      };
    }
    return this.finishRecorded();
  }
  private finishRecorded(): RunLivePumpResult {
    const delivered = !!this.session.bvid && this.segments.some(x => x.stem && !x.uploadError);
    const lossNote = this.stopLost.length ? `停止时 ${this.stopLost.length} 个分 P 丢失(${this.stopLost.join(",")})${this.stopUnknown.length ? `;另有 ${this.stopUnknown.length} 个提交结果未知` : ""}` : undefined;
    if (lossNote) {
      this.events.log(`[直播直传] ⚠️ ${lossNote}${delivered ? "(其余分 P 已入稿,按已交付收尾)" : ""}`);
      try {
        this.o.onAlert?.(lossNote);
      }
      catch {
      }
      if (!delivered) {
        return {
          ok: false,
          error: lossNote,
          bvid: this.session.bvid,
          aid: this.session.aid,
          title: this.session.archiveTitle,
          segments: [...this.segments],
          spoolDir: this.o.spoolDir,
          statePath: livePumpStatePath(this.o.spoolDir, this.o.room),
          lostParts: this.stopLost.length,
          ...(this.stopUnknown.length ? { unknownParts: this.stopUnknown.length } : {}),
        };
      }
    }
    if (this.stopUnknown.length) {
      try {
        this.o.onAlert?.(`停止时 ${this.stopUnknown.length} 个分 P 的归档提交结果未知,下次启动将按状态文件核对`);
      }
      catch {
      }
    }
    return {
      ok: true,
      ...(this.stopLost.length ? { lostParts: this.stopLost.length } : {}),
      ...(this.stopUnknown.length ? { unknownParts: this.stopUnknown.length } : {}),
      ...(this.segments.some(x => x.stem) || (this.stopLost.length > 0 && delivered) ? { outcome: "uploaded" as const } : { outcome: this.o.waitForBroadcast ? "idle" as const : "no-stream" as const }),
      bvid: this.session.bvid,
      aid: this.session.aid,
      title: this.session.archiveTitle,
      segments: [...this.segments],
      spoolDir: this.o.spoolDir,
      statePath: livePumpStatePath(this.o.spoolDir, this.o.room),
    };
  }
  close(): void {
    this.closed = true;
    this.events.logSuppressedRatioAlerts();
    this.finalization.cancel();
  }
}
