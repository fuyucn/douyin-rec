type RetryResult = {
  ok: boolean;
  stem?: string;
  bvid?: string;
  aid?: number;
  error?: string;
  retryable?: boolean;
};
import { existsSync } from "node:fs";
import type { LivePumpDelivery } from "./live-pump-delivery.js";
import type { LivePumpPartContext as PartCtx, PartDisposition as Disposition } from "./live-pump-finalization.js";
import type { PartSinkResult } from "./live-pump-part-sink.js";
import type { SealedPart, SegmentExit, SegmentRunResult } from "./live-pump-types.js";
import type { LivePumpSegmentReport } from "./live-pump-run-options.js";
import { livePumpStatePath } from "./live-pump-state.js";
import { finalizeRecordedPart } from "./live-pump-validation.js";
import { segmentResultOf } from "./live-pump-segment.js";
import { sleepUnlessAborted } from "./live-pump-wait.js";
import { MiB, MIN_PART_BYTES, NO_EXIT, ZERO_DISK_PART_LOST, recoveryDeadlineAfterPart } from "./live-pump-policy.js";
export class DirectPartDelivery {
  private r!: SegmentRunResult;
  private base!: LivePumpSegmentReport;
  private retryableUploadFailure = false;
  constructor(private readonly owner: LivePumpDelivery, private readonly ctx: PartCtx, private readonly part: SealedPart, private readonly exit: SegmentExit | undefined, private readonly sinkRes: PartSinkResult) {
  }
  private checkArchivePartsWarn(): void {
    this.owner.events.checkArchivePartsWarn(this.owner.session);
  }
  private async validate(): Promise<void> {
    this.r = await finalizeRecordedPart({
      rec: segmentResultOf(this.part, this.sinkRes, this.exit ?? NO_EXIT),
      session: this.sinkRes.session,
      cookiesPath: this.owner.o.cookiesPath,
      fileName: this.ctx.fileName,
      spoolPath: this.ctx.spoolPath,
      spoolMode: this.owner.spoolMode,
      line: this.owner.o.line ?? "txa",
      fetchImpl: this.owner.o.fetchImpl,
      signal: this.ctx.ac.signal,
      onChunk: this.ctx.onChunk,
      log: this.owner.events.log,
      isClosed: () => this.owner.closed,
      onFallback: (p, b) => this.owner.events.log(`[直播直传] ↺ 段${this.ctx.seg + 1} 走整文件回退重传: ${(b / MiB).toFixed(1)}MiB (${p})`),
      probeDuration: this.owner.o.probeDuration,
      scanDtsGap: this.owner.o.scanDtsGap,
      ...(this.owner.o.sleep ? { sleep: this.owner.o.sleep } : {}),
      onHold: () => this.owner.session.dropPart(this.ctx.index),
      onHoldFailed: detail => {
        const msg = `段${this.ctx.seg + 1} 时间戳跳变的 spool 无法改名扣留,保留在恢复状态,需人工处理(${detail})`;
        this.owner.events.log(`[直播直传] ⚠️ ${msg}`);
        try {
          this.owner.o.onAlert?.(msg);
        }
        catch {
        }
      },
      keepSpool: true,
    });
  }
  private reportBase(): void {
    this.base = {
      seg: this.ctx.seg + 1,
      chunks: this.r.chunksUploaded,
      bytes: this.r.streamedBytes,
      spooled: this.r.spooledBytes,
      ms: Date.now() - this.ctx.openedAt,
      exit: this.r.exit.code,
      backpressured: this.r.backpressured,
      ...(this.r.degradedReason ? { degradedReason: this.r.degradedReason } : {}),
      sessionLeaked: this.r.sessionLeaked,
      usedFileFallback: this.r.usedFileFallback,
      ...(this.r.spoolIncomplete ? { spoolIncomplete: true } : {}),
    };
  }
  private empty(): Disposition | undefined {
    if (this.r.spooledBytes === 0) {
      if (this.r.sealedBy === "stalled" && !this.r.spoolIncomplete) {
        this.owner.session.dropPart(this.ctx.index);
        return { kind: "stall-empty" };
      }
      if (!this.r.uploadError) {
        this.owner.events.log("[直播直传] 本段没有写入,判定已收播");
        this.owner.session.dropPart(this.ctx.index);
        return { kind: "ended" };
      }
    }
  }
  fail(error: string, extra: Partial<LivePumpSegmentReport> = {}, uploadPending = false): Disposition {
    return this.owner.finalization.fail({
      ok: false,
      error,
      uploadPending,
      bvid: this.owner.session.bvid,
      aid: this.owner.session.aid,
      title: this.owner.session.archiveTitle,
      segments: [...this.owner.segments, { ...this.base, ...extra, uploadError: error }],
      spoolDir: this.owner.o.spoolDir,
      statePath: livePumpStatePath(this.owner.o.spoolDir, this.owner.o.room),
    });
  }
  persistUnconfirmed(): string | undefined {
    if (this.r.tsGap || this.owner.spoolMode !== "full" || this.owner.o.submit === false || this.r.spooledBytes <= 0) {
      return undefined;
    }
    const note = this.owner.session.noteUnconfirmedPart({
      index: this.ctx.index,
      spoolPath: this.ctx.spoolPath,
      title: this.owner.o.partTitle?.(this.ctx.index + 1, this.owner.liveTitle) ?? this.ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
      bytes: this.r.spooledBytes,
      durationSec: this.r.spoolDurationSec ?? 0,
      ...(this.r.stemOfCompleted ? { stem: this.r.stemOfCompleted } : {}),
      ...(this.r.spoolIncomplete ? { spoolIncomplete: true } : {}),
      ...(!this.r.localValidationFailed && !this.r.spoolIncomplete && (this.r.spoolDurationSec ?? 0) > 0 ? { validated: true } : {}),
    });
    if (note.ok)
      this.owner.events.emit({ at: Date.now(), kind: "part_unconfirmed", part: this.ctx.index, bytes: this.r.spooledBytes });
    return note.ok ? undefined : (note.error ?? "无法记录未确认分 P");
  }
  private async retryUpload(): Promise<{
    done: true;
    result: RetryResult;
  } | {
    done: false;
    error: string;
    retryable: boolean;
  }> {
    const submitted: RetryResult = await this.owner.session.resubmitUnconfirmedPart(this.ctx.ac.signal).catch((error: unknown) => ({ ok: false, error: String((error as Error)?.message ?? error).slice(0, 200), retryable: false }));
    if (!submitted.ok)
      return { done: false, error: submitted.error ?? "未确认分 P 重试失败", retryable: submitted.retryable === true };
    const confirmedPart = this.owner.session.parts.find(p => p.index === this.ctx.index && p.confirmed);
    if (!confirmedPart)
      return { done: true, result: { ok: false, error: "自动重试未确认目标分 P(索引 " + this.ctx.index + ")" } };
    this.owner.events.emit({ at: Date.now(), kind: "part_confirmed", part: this.ctx.index, ...(submitted.bvid ? { bvid: submitted.bvid } : {}) });
    return { done: true, result: { ok: true, ...(confirmedPart.stem ? { stem: confirmedPart.stem } : {}), ...(submitted.bvid ? { bvid: submitted.bvid } : {}), ...(submitted.aid ? { aid: submitted.aid } : {}) } };
  }
  private async retryUnconfirmed(): Promise<RetryResult> {
    this.owner.events.emit({ at: Date.now(), kind: "part_retry", part: this.ctx.index });
    const deadline = Date.now() + this.owner.recoverWindowMs;
    let waitMs = Math.min(5000, this.owner.recoverWindowMs);
    let lastError = "";
    let lastRetryable = false;
    for (;;) {
      if (this.ctx.ac.signal.aborted)
        return { ok: false, error: "stopped" };
      const recovered = await this.owner.session.recover().catch((error: unknown) => ({ ok: false, reason: String((error as Error)?.message ?? error).slice(0, 200) }));
      if (!recovered.ok)
        lastError = recovered.reason ?? "状态恢复失败";
      else {
        const attempt = await this.retryUpload();
        if (attempt.done)
          return attempt.result;
        lastError = attempt.error;
        lastRetryable = attempt.retryable;
      }
      if (Date.now() >= deadline)
        return { ok: false, error: lastError || "自动重试窗口耗尽", retryable: lastRetryable };
      const sleepMs = Math.max(0, Math.min(waitMs, deadline - Date.now()));
      this.owner.events.log("[直播直传] 段" + (this.ctx.seg + 1) + " 自动重试上传," + Math.max(1, Math.ceil(sleepMs / 1000)) + "s 后继续: " + lastError);
      await sleepUnlessAborted(sleepMs, [this.ctx.ac.signal], this.owner.o.sleep);
      waitMs = Math.min(60000, Math.max(1000, waitMs * 2));
    }
  }
  private recoveredRetry(retried: {
    bvid?: string;
    aid?: number;
  }): Disposition {
    const recovered = this.owner.session.parts.find(p => p.index === this.ctx.index && p.confirmed);
    this.owner.pushSegment({
      ...this.base,
      ...(recovered?.stem ? { stem: recovered.stem } : {}),
      spooled: this.r.spooledBytes,
      bytes: this.r.spooledBytes,
      spoolDurationSec: this.r.spoolDurationSec ?? 0,
    });
    this.owner.events.log(`[直播直传] 段${this.ctx.seg + 1} 自动重试成功,已追到稿件 ${retried.bvid ?? this.owner.session.bvid ?? retried.aid ?? "当前稿件"}`);
    this.owner.events.log("[状态] 分P已确认");
    try {
      const bv = retried.bvid ?? this.owner.session.bvid;
      this.owner.o.onPartConfirmed?.({
        count: this.owner.session.parts.filter(p => p.confirmed).length,
        ...(bv ? { bvid: bv } : {}),
      });
    }
    catch {
    }
    this.checkArchivePartsWarn();
    this.owner.recoveryDeadline = Date.now() + this.owner.recoverWindowMs;
    return { kind: "continue" };
  }
  private async invalid(): Promise<Disposition | undefined> {
    if (!this.r.uploadError && this.r.spoolDurationSec)
      return;
    let error = this.r.uploadError ?? "缺 duration(产物不可投)";
    const where = this.owner.spoolMode === "none" ? "无本地副本" : `spool ${(this.r.spooledBytes / MiB).toFixed(1)}MiB`;
    this.owner.events.log(`[直播直传] ⚠️ 段${this.ctx.seg + 1} 未可投,不进入稿件: ${error}(${where})`);
    const persistError = this.persistUnconfirmed();
    if (persistError)
      error = `${error};${persistError}`;
    const persisted = persistError === undefined;
    if (this.r.sealedBy === "stalled" && this.owner.o.autoRetryUpload !== false && persisted && this.owner.spoolMode === "full" && !this.r.tsGap && this.r.spooledBytes > 0 && !this.ctx.ac.signal.aborted && !this.owner.o.drainSignal?.aborted) {
      const retried = await this.retryUnconfirmed();
      if (retried.ok)
        return this.recoveredRetry(retried);
      error = `${error};自动重试失败: ${retried.error ?? "窗口耗尽"}`;
      this.retryableUploadFailure = retried.retryable === true;
    }
    if (this.r.sealedBy === "abort" && this.owner.segments.some(x => x.stem)) {
      if (this.owner.spoolMode === "none" && this.r.spooledBytes > 0) {
        this.owner.stopLost.push(`段${this.ctx.seg + 1}`);
        this.owner.events.log(`[直播直传] ⚠️ 段${this.ctx.seg + 1} 停止时正在录制,零落盘无本地副本,该分 P 已丢失`);
      }
      this.owner.events.log("[直播直传] 已停止,此前分 P 均已入稿:按成功收尾");
      this.owner.pushSegment({ ...this.base, uploadError: error });
      return { kind: "ended" };
    }
    if (this.owner.o.signal?.aborted && this.owner.session.parts.some(x => x.index === this.ctx.index && !x.confirmed)) {
      this.owner.events.log(`[直播直传] 已停止:段${this.ctx.seg + 1} 未传完,已记入恢复状态,下次运行按整文件补传`);
      this.owner.pushSegment({ ...this.base, uploadError: error });
      return { kind: "ended" };
    }
    this.owner.events.emit({ at: Date.now(), kind: "part_failed", part: this.ctx.index, message: error });
    return this.fail(error, {}, this.retryableUploadFailure && this.owner.spoolMode !== "none" && existsSync(this.ctx.spoolPath));
  }
  private async failedSubmission(report: LivePumpSegmentReport, submitted: Awaited<ReturnType<LivePumpDelivery["session"]["submitPart"]>>): Promise<Disposition> {
    this.owner.events.log(`[直播直传] 段${this.ctx.seg + 1} 稿件提交失败${this.owner.spoolMode === "none" ? "(无本地副本)" : ",保留 spool"}: ${submitted.error}`);
    this.owner.events.emit({ at: Date.now(), kind: "part_failed", part: this.ctx.index, message: submitted.error });
    if (!(this.owner.spoolMode !== "none" && existsSync(this.ctx.spoolPath) && submitted.retryable === true)) {
      return this.owner.finalization.fail({
        ok: false,
        error: submitted.error,
        bvid: this.owner.session.bvid,
        aid: this.owner.session.aid,
        uploadPending: submitted.retryable === true && this.owner.spoolMode !== "none" && existsSync(this.ctx.spoolPath),
        title: this.owner.session.archiveTitle,
        segments: [...this.owner.segments, { ...report, uploadError: submitted.error }],
        spoolDir: this.owner.o.spoolDir,
        statePath: livePumpStatePath(this.owner.o.spoolDir, this.owner.o.room),
      });
    }
    try {
      const rec = await this.owner.session.recover();
      if (!rec.ok)
        this.owner.events.log(`[直播直传] ⚠️ 提交意图无法消歧(该分 P 收播后由队列补传或下次运行消歧): ${rec.reason}`);
    }
    catch (e) {
      this.owner.events.log(`[直播直传] ⚠️ 提交意图消歧失败(继续录制): ${String((e as Error)?.message ?? e)}`);
    }
    if (this.owner.session.parts.find(p => p.index === this.ctx.index)?.confirmed) {
      this.owner.pushSegment(report);
      this.owner.events.log(`[直播直传] 段${this.ctx.seg + 1} 实际已入稿(消歧确认)`);
      this.owner.events.emit({ at: Date.now(), kind: "part_confirmed", part: this.ctx.index, ...(this.owner.session.bvid ? { bvid: this.owner.session.bvid } : {}) });
      try {
        this.owner.o.onPartConfirmed?.({ count: this.owner.session.parts.filter(p => p.confirmed).length, ...(this.owner.session.bvid ? { bvid: this.owner.session.bvid } : {}) });
      }
      catch {
      }
      this.owner.recoveryDeadline = this.part.final ? recoveryDeadlineAfterPart(this.part.sealedBy, Date.now(), this.owner.recoverWindowMs) : undefined;
      return this.part.final ? { kind: "ended" } : { kind: "continue" };
    }
    if (!this.owner.spoolOnlyRun) {
      this.owner.spoolOnlyRun = true;
      const handoffMsg = `段${this.ctx.seg + 1} 提交失败,本场剩余分 P 改为落盘,收播后由节点队列补传;录制继续`;
      this.owner.events.log(`[直播直传] ⚠️ ${handoffMsg}`);
      try {
        this.owner.o.onAlert?.(handoffMsg);
      }
      catch {
      }
      this.owner.session.markDeliveryDeferred();
    }
    this.owner.pushSegment({ ...report, uploadError: submitted.error });
    return this.part.final || this.ctx.ac.signal.aborted ? { kind: "ended" } : { kind: "continue" };
  }
  private async submit(report: LivePumpSegmentReport): Promise<Disposition | undefined> {
    const stem = this.r.stemOfCompleted!;
    this.owner.events.emit({ at: Date.now(), kind: "part_submit", part: this.ctx.index });
    this.ctx.submitting = true;
    const submitted = await this.owner.session.submitPart({
      index: this.ctx.index,
      spoolPath: this.ctx.spoolPath,
      stem,
      title: this.owner.o.partTitle?.(this.ctx.index + 1, this.owner.liveTitle) ?? this.ctx.fileName.replace(/\.live(?=\.[^.]+$)/, "").replace(/\.[^.]+$/, ""),
      bytes: this.base.bytes,
      durationSec: this.r.spoolDurationSec!,
    }, this.ctx.ac.signal);
    this.ctx.submitting = false;
    if (!submitted.ok)
      return this.failedSubmission(report, submitted);
    this.owner.events.log(`[直播直传] 段${this.ctx.seg + 1} 已确认到稿件 ${submitted.bvid ?? submitted.aid}` + `${this.r.usedFileFallback ? " (整文件回退)" : ""}`);
    this.owner.events.emit({ at: Date.now(), kind: "part_confirmed", part: this.ctx.index, ...(submitted.bvid ? { bvid: submitted.bvid } : {}) });
    this.owner.events.log("[状态] 分P已确认");
    try {
      const bv = submitted.bvid ?? this.owner.session.bvid;
      this.owner.o.onPartConfirmed?.({ count: this.owner.session.parts.filter(p => p.confirmed).length, ...(bv ? { bvid: bv } : {}) });
    }
    catch {
    }
    this.checkArchivePartsWarn();
    return undefined;
  }
  private async finish(): Promise<Disposition> {
    const stem = this.r.stemOfCompleted;
    if (!stem) {
      let error = "complete 未返回 UPOS stem";
      const persistError = this.persistUnconfirmed();
      if (persistError)
        error = `${error};${persistError}`;
      this.owner.events.emit({ at: Date.now(), kind: "part_failed", part: this.ctx.index, message: error });
      return this.fail(error, { spoolDurationSec: this.r.spoolDurationSec });
    }
    const report: LivePumpSegmentReport = { ...this.base, stem, spoolDurationSec: this.r.spoolDurationSec };
    if (this.owner.o.submit !== false) {
      const disposition = await this.submit(report);
      if (disposition)
        return disposition;
    }
    this.owner.pushSegment(report);
    this.owner.recoveryDeadline = this.part.final ? recoveryDeadlineAfterPart(this.r.sealedBy, Date.now(), this.owner.recoverWindowMs) : undefined;
    const disk = this.owner.spoolMode === "none" ? "无本地回退文件(真直播直传)" : `spool ${(this.r.spooledBytes / MiB).toFixed(1)}MiB`;
    this.owner.events.log(`[直播直传] 段${this.ctx.seg + 1} 结束: ${this.r.chunksUploaded} 块 / ${(this.r.streamedBytes / MiB).toFixed(1)}MiB,` + `${disk},ffmpeg exit=${this.r.exit.code}` + `${this.r.degradedReason ? `,降级: ${this.r.degradedReason}` : ""}` + `${this.r.usedFileFallback ? ",整文件回退成功" : ""}`);
    this.owner.events.reportMedia(this.part, this.r, this.ctx.seg);
    if (this.r.sessionLeaked)
      this.owner.events.log("[直播直传] ⚠️ UPOS 会话半截泄漏:协议无 abort,须按原文件重传覆盖");
    if (!this.part.final)
      return { kind: "continue" };
    if (this.r.sealedBy === "abort")
      return { kind: "ended" };
    if (this.r.spooledBytes < MIN_PART_BYTES && this.r.sealedBy !== "stalled" && !this.part.stopped) {
      this.owner.events.log("[直播直传] 本段 < 1MiB,判定已收播");
      return { kind: "ended" };
    }
    return { kind: "continue" };
  }
  async run(): Promise<Disposition> {
    await this.validate();
    if (this.owner.closed)
      return { kind: "ended" };
    this.reportBase();
    const empty = this.empty();
    if (empty)
      return empty;
    if (this.owner.spoolMode === "none" && this.r.backpressured) {
      const error = ZERO_DISK_PART_LOST;
      this.owner.events.log(`[直播直传] ⚠️ 段${this.ctx.seg + 1} ${error}`);
      this.owner.events.emit({ at: Date.now(), kind: "part_failed", part: this.ctx.index, message: error });
      return this.fail(error);
    }
    const invalid = await this.invalid();
    return invalid ?? this.finish();
  }
}
