import { rmSync, renameSync } from "node:fs";
import { ffprobeDuration, type DtsGap } from "@drec/post-process";
import { complete, type PreuploadResult } from "./upos-stream.js";
import { defaultScanDtsGap, heldGapPath, reuploadSpoolFile } from "./live-pump-spool-recovery.js";
import { MiB } from "./live-pump-policy.js";
import type { SegmentRunResult } from "./live-pump-types.js";
type ValidatedPart = SegmentRunResult & { session?: PreuploadResult };
export type RecordedPartOptions = {
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
    sleep?: (ms: number) => Promise<void>;
    onHold?: () => void;
    onHoldFailed?: (detail: string) => void;
    /** Run closure, not signal abortion: active tails may validate during stop grace. */
    isClosed?: () => boolean;
    keepSpool?: boolean;
    submit?: boolean;
};

/** Validation may finish during stop grace, but cannot mutate anything after run closure. */
class RecordedPartFinalizer {
  private durationSec = 0;
  private probeFailed = false;
  private scanFailed = false;
  private stem: string | undefined;
  private usedFallback = false;

  constructor(private readonly o: RecordedPartOptions) {}

  private result(extra: Partial<SegmentRunResult> = {}): ValidatedPart {
    return { ...this.o.rec, ...extra, ...(this.o.session ? { session: this.o.session } : {}) };
  }

  private emptyStall(): boolean {
    const { rec, spoolMode, spoolPath } = this.o;
    if (rec.sealedBy !== "stalled" || rec.spooledBytes !== 0 || rec.spoolIncomplete) return false;
    if (spoolMode === "full") {
      try { rmSync(spoolPath, { force: true }); } catch { /* Best-effort empty-file cleanup. */ }
    }
    return true;
  }

  private async probe(): Promise<void> {
    const { rec, spoolMode, spoolPath } = this.o;
    const pts = rec.ptsDurationSec ?? 0;
    const wallSec = (rec.sealedMs ?? 0) / 1000;
    let trusted = pts > 0;
    if (pts > 0 && wallSec > 60 && (pts > 1.5 * wallSec + 60 || pts < 0.5 * wallSec)) {
      trusted = false;
      this.o.log?.("[直播直传] ⚠️ " + this.o.fileName + ": PTS 时长 " + pts.toFixed(1)
        + "s 与墙钟 " + wallSec.toFixed(1) + "s 不符,PTS 不可信");
    }
    if (spoolMode !== "full") {
      this.durationSec = trusted ? pts : Math.max(0.001, wallSec);
      return;
    }
    try { this.durationSec = await (this.o.probeDuration ?? ffprobeDuration)(spoolPath); }
    catch { this.durationSec = 0; this.probeFailed = true; }
    if (this.o.isClosed?.()) return;
    if (!(this.durationSec > 0)) {
      this.durationSec = 0;
      this.probeFailed = true;
      this.addError("产物自检失败(TS 读不出 duration,不可投): " + spoolPath);
    }
  }

  private addError(why: string): void {
    const rec = this.o.rec;
    rec.uploadError = rec.uploadError ? rec.uploadError + ";" + why : why;
  }

  private holdGap(gap: DtsGap): void {
    const { rec, spoolPath } = this.o;
    rec.tsGap = gap;
    let kept = spoolPath;
    const heldPath = heldGapPath(spoolPath);
    let renamed = false;
    // Rename before dropping the recovery row; a failed rename must keep its only copy protected.
    try { renameSync(spoolPath, heldPath); kept = heldPath; renamed = true; }
    catch (error) {
      this.o.onHoldFailed?.(spoolPath + ": " + String((error as Error)?.message ?? error).slice(0, 120));
    }
    if (renamed) this.o.onHold?.();
    this.addError("时间戳跳变(流" + gap.streamIndex + ": " + gap.fromSec.toFixed(1)
      + "s → " + gap.toSec.toFixed(1) + "s),不投稿,spool 保留为 " + kept);
    if (rec.chunksUploaded > 0) rec.sessionLeaked = true;
  }

  private async scan(): Promise<void> {
    const { rec, spoolMode, spoolPath } = this.o;
    if (rec.tsDiscontinuities) {
      this.o.log?.("[直播直传] ⚠️ " + this.o.fileName + ": ffmpeg 报告 "
        + rec.tsDiscontinuities + " 次时间戳不连续(流内跳变或被复用器钳平)");
    }
    if (spoolMode !== "full" || rec.spooledBytes <= 0 || this.durationSec <= 0) return;
    let gap: DtsGap | null | undefined;
    try { gap = await (this.o.scanDtsGap ?? defaultScanDtsGap)(spoolPath); }
    catch { gap = undefined; this.scanFailed = true; }
    if (this.o.isClosed?.()) return;
    if (gap === undefined) this.scanFailed = true;
    if (gap) this.holdGap(gap);
    else if (gap === undefined) {
      this.o.log?.("[直播直传] ⚠️ " + this.o.fileName + ": 时间戳扫描无法判定,"
        + (this.o.submit === false ? "本地校验按未通过处理" : "按原流程继续"));
    }
  }

  private markLocalValidation(): void {
    const rec = this.o.rec;
    rec.localValidationFailed = (rec.spoolIncomplete === true || rec.tsGap !== undefined
      || rec.sizeOverflow === true || this.probeFailed || this.scanFailed) || undefined;
  }

  private validateOnly(): ValidatedPart {
    const rec = this.o.rec;
    if (!rec.localValidationFailed) rec.uploadError = undefined;
    else if (!rec.uploadError) rec.uploadError = "本地产物校验未通过(不可投)";
    return this.result({ spoolDurationSec: this.durationSec });
  }

  private async complete(): Promise<void> {
    const { rec, session } = this.o;
    if (rec.spoolIncomplete) {
      this.o.log?.("[直播直传] ⚠️ " + this.o.fileName + ": spool 写失败,本段被截断(已写 "
        + (rec.spooledBytes / MiB).toFixed(1) + "MiB),不投稿、不整文件回退,spool 保留供人工处理");
    }
    if (rec.uploadError || rec.chunksUploaded <= 0 || !session) return;
    const parts = Array.from({ length: rec.chunksUploaded }, (_, i) => ({ partNumber: i + 1, eTag: "etag" }));
    const done = await complete({ session, parts, fetchImpl: this.o.fetchImpl, signal: this.o.signal });
    if (this.o.isClosed?.()) return;
    if (done.ok) this.stem = done.stem;
    else rec.uploadError = "complete 失败: " + JSON.stringify(done.raw).slice(0, 200);
  }

  private async fallback(): Promise<void> {
    const { rec, spoolMode, spoolPath } = this.o;
    if (spoolMode !== "full" || !rec.uploadError || rec.tsGap || rec.spoolIncomplete
      || rec.spooledBytes <= 0 || this.durationSec <= 0) return;
    const fb = await reuploadSpoolFile({
      cookiesPath: this.o.cookiesPath, fileName: this.o.fileName, spoolPath,
      line: this.o.line, fetchImpl: this.o.fetchImpl, signal: this.o.signal,
      onChunk: this.o.onChunk, log: this.o.log, sleep: this.o.sleep,
    });
    if (this.o.isClosed?.()) return;
    if (!fb.ok) { this.addError("整文件回退也失败: " + fb.error); return; }
    this.stem = fb.stem;
    rec.uploadError = undefined;
    rec.chunksUploaded = fb.chunks;
    rec.streamedBytes = fb.bytes;
    this.usedFallback = true;
    this.o.onFallback?.(spoolPath, fb.bytes);
  }

  async run(): Promise<ValidatedPart> {
    if (this.o.isClosed?.()) return this.result();
    if (this.emptyStall()) return this.result({ spoolDurationSec: 0, usedFileFallback: false });
    await this.probe();
    if (this.o.isClosed?.()) return this.result();
    await this.scan();
    if (this.o.isClosed?.()) return this.result();
    this.markLocalValidation();
    if (this.o.submit === false) return this.validateOnly();
    await this.complete();
    if (this.o.isClosed?.()) return this.result();
    await this.fallback();
    if (this.o.isClosed?.()) return this.result();
    if (!this.o.keepSpool && this.stem) {
      try { rmSync(this.o.spoolPath, { force: true }); } catch { /* Caller owns confirmed cleanup. */ }
    }
    return this.result({ spoolDurationSec: this.durationSec,
      stemOfCompleted: this.stem, usedFileFallback: this.usedFallback });
  }
}

export async function finalizeRecordedPart(o: RecordedPartOptions): Promise<ValidatedPart> {
  return new RecordedPartFinalizer(o).run();
}
