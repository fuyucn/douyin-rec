import { renameSync } from "node:fs";
import { basename } from "node:path";
import type { DtsGap } from "@drec/post-process";
import type { LivePumpCheckpoint } from "./live-pump-checkpoint.js";
import { isLivePumpPartObserved, type LivePumpState } from "./live-pump-state.js";
import type { LivePumpSessionOpts, PartSubmitInput, SpoolResubmitResult } from "./live-pump-session-options.js";
import { resolveInterruptedPublication, type RecoveryResult } from "./live-pump-recovery.js";
import { heldGapPath, prepareRecoveredSpool, type RecoverySpool, type SpoolRecoveryDisposition } from "./live-pump-spool-recovery.js";
/** Merge recovery into the current checkpoint, never a snapshot captured before an await. */
export class LivePumpSessionRecovery {
  private readonly log: (message: string) => void;
  constructor(private readonly o: LivePumpSessionOpts, private readonly checkpoint: LivePumpCheckpoint, private readonly publish: (input: PartSubmitInput, signal?: AbortSignal) => Promise<SpoolResubmitResult>, private readonly cleanup: () => void) {
    this.log = o.log ?? (message => process.stderr.write(message + "\n"));
  }
  async resubmitAllUnconfirmed(signal?: AbortSignal): Promise<{
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
    held?: number[];
    retryable?: boolean;
  }> {
    let last: {
      ok: boolean;
      bvid?: string;
      aid?: number;
      error?: string;
      retryable?: boolean;
    } = { ok: true, bvid: this.checkpoint.state.bvid, aid: this.checkpoint.state.aid };
    const held: number[] = [];
    while (this.checkpoint.lowestUnconfirmed()) {
      if (signal?.aborted)
        return { ok: false, bvid: this.checkpoint.state.bvid, aid: this.checkpoint.state.aid, error: "resubmit aborted" };
      const before = this.checkpoint.lowestUnconfirmed()!.index;
      const r = await this.resubmitUnconfirmedPart(signal);
      if (r.held) {
        held.push(before);
        continue;
      }
      last = { ok: r.ok, bvid: r.bvid, aid: r.aid, error: r.error, ...(r.retryable ? { retryable: true } : {}) };
      if (!r.ok)
        return { ...last, ...(held.length ? { held } : {}) };
      if (this.checkpoint.lowestUnconfirmed()?.index === before)
        return { ok: false, error: "recovery made no durable progress; source retained", ...(held.length ? { held } : {}) };
    }
    return { ...last, ...(held.length ? { held } : {}) };
  }
  async resubmitUnconfirmedPart(signal?: AbortSignal): Promise<SpoolResubmitResult> {
    if (this.checkpoint.stateUntrusted)
      return { ok: false, error: "state sidecar is untrusted" };
    if (this.checkpoint.state.pending)
      return { ok: false, error: "another submit is pending" };
    const target = this.checkpoint.lowestUnconfirmed();
    if (!target)
      return { ok: true, bvid: this.checkpoint.state.bvid, aid: this.checkpoint.state.aid };
    if (target.proof === "accepted" || target.confirmed) {
      const result = await this.recover();
      return { ok: result.ok, bvid: this.checkpoint.state.bvid, aid: this.checkpoint.state.aid,
        ...(result.ok ? {} : { error: result.reason ?? "accepted part requires native observation" }) };
    }
    const recovered = await prepareRecoveredSpool({
      target,
      cookiesPath: this.o.cookiesPath,
      line: this.o.line,
      fetchImpl: this.o.fetchImpl,
      signal,
      sleep: this.o.sleep,
      probeDuration: this.o.probeDuration,
      scanDtsGap: this.o.scanDtsGap,
      log: this.log,
      onActivity: () => this.checkpoint.noteActivity(),
      onChunk: (uploaded, chunks) => this.o.onChunk?.(uploaded, chunks),
    });
    if (recovered.kind !== "ready")
      return this.applyRecoveryDisposition(target, recovered);
    if (signal?.aborted)
      return { ok: false, error: "resubmit aborted" };
    const submitted = await this.publish({
      index: target.index,
      spoolPath: target.spoolPath,
      title: target.title,
      stem: recovered.stem,
      bytes: recovered.bytes,
      durationSec: recovered.durationSec,
    }, signal);
    if (!submitted.ok) {
      return { ok: false, ...(submitted.retryable ? { retryable: true } : {}), error: submitted.error };
    }
    return { ok: true, bvid: submitted.bvid, aid: submitted.aid };
  }
  private applyRecoveryDisposition(target: RecoverySpool, recovery: SpoolRecoveryDisposition): SpoolResubmitResult {
    if (recovery.kind === "discard") {
      this.log(`[直播直传] 分 P ${target.index} 在封口前被中断且无可读字节,丢弃 open 占位行(不阻断后续启动)`);
      this.checkpoint.dropPart(target.index);
      return { ok: true, bvid: this.checkpoint.state.bvid, aid: this.checkpoint.state.aid };
    }
    if (recovery.kind === "gap")
      return this.holdRecoveredSpool(target, recovery.gap);
    if (recovery.kind === "held" || recovery.alert)
      this.reportRecoveryAlert(recovery.error);
    if (recovery.kind === "held") {
      this.checkpoint.dropPart(target.index);
      return { ok: false, held: true, error: recovery.error };
    }
    return { ok: false, error: recovery.error, ...(recovery.retryable ? { retryable: true } : {}) };
  }
  private holdRecoveredSpool(target: RecoverySpool, gap: DtsGap): SpoolResubmitResult {
    const heldPath = heldGapPath(target.spoolPath);
    const why = `分 P ${target.index} 时间戳跳变(流${gap.streamIndex}: ${gap.fromSec.toFixed(1)}s → ${gap.toSec.toFixed(1)}s),不投稿`;
    const row = this.checkpoint.state.parts.find(x => x.index === target.index)!;
    this.checkpoint.dropPart(target.index);
    try {
      renameSync(target.spoolPath, heldPath);
    }
    catch (e) {
      this.checkpoint.state = { ...this.checkpoint.state, parts: [...this.checkpoint.state.parts, row].sort((a, b) => a.index - b.index) };
      try {
        this.checkpoint.persist();
      }
      catch {
      }
      const msg = `${why},但 spool 无法改名扣留(${String((e as Error)?.message ?? e).slice(0, 120)}),保留在恢复状态,需人工处理: ${target.spoolPath}`;
      this.reportRecoveryAlert(msg);
      return { ok: false, error: msg };
    }
    const msg = `${why},spool 保留为 ${heldPath};稿件缺少这一 P,需人工处理`;
    this.reportRecoveryAlert(msg);
    return { ok: false, held: true, error: msg };
  }
  private reportRecoveryAlert(message: string): void {
    this.log(`[直播直传] ⚠️ ${message}`);
    try {
      this.o.onAlert?.(message);
    }
    catch {
    }
  }
  async recover(): Promise<RecoveryResult> {
    if (this.checkpoint.stateUntrusted)
      return { ok: false, needsManual: true, reason: "state sidecar is untrusted; source retained" };
    if (!this.checkpoint.state.pending) {
      const accepted = this.checkpoint.state.parts.find(part => part.proof === "accepted");
      if (accepted) {
        if (!accepted.nativeKey || accepted.nativeKey !== accepted.stem)
          return { ok: false, needsManual: true, reason: "accepted part has no bound native key; source retained" };
        this.checkpoint.state = { ...this.checkpoint.state, pending: {
          kind: this.checkpoint.state.bvid || this.checkpoint.state.aid ? "append" : "create",
          submissionState: "accepted", partIndex: accepted.index, stem: accepted.nativeKey,
          title: accepted.title, bytes: accepted.bytes, durationSec: accepted.durationSec,
          spoolPath: accepted.spoolPath, acceptedAt: accepted.acceptedAt,
          sourceFp: accepted.sourceFp,
        } };
        try { this.checkpoint.persist(); }
        catch (error) { return { ok: false, reason: "cannot restore accepted intent: " + String(error) }; }
      }
    }
    const p = this.checkpoint.state.pending;
    if (!p) {
      try {
        for (const part of this.checkpoint.state.parts) {
          if (!part.confirmed || part.proof !== "observed" || !part.nativeKey) continue;
          this.o.submitter?.observeStreamedPart({
            ref: { targetId: this.o.submitterTargetId ?? "bilibili-upos", id: this.checkpoint.state.bvid ?? String(this.checkpoint.state.aid) },
            name: part.nativeKey,
          });
        }
      } catch (e) {
        return { ok: false, reason: "cannot restore observed upload checkpoint: " + String((e as Error)?.message ?? e).slice(0, 200) };
      }
      this.cleanup();
      if (this.checkpoint.hasUnconfirmed && this.checkpoint.parts.some(part => part.confirmed && !isLivePumpPartObserved(part)))
        return { ok: false, needsManual: true, reason: "legacy confirmation is not native part proof; source retained" };
      return { ok: true };
    }
    const resolution = await resolveInterruptedPublication({
      pending: p,
      cookiesPath: this.o.cookiesPath,
      fetchImpl: this.o.fetchImpl,
      archive: { title: this.checkpoint.state.title, bvid: this.checkpoint.state.bvid, aid: this.checkpoint.state.aid },
    });
    if (resolution.kind === "blocked")
      return resolution.result;
    if (resolution.kind === "existing" && this.checkpoint.state.aid !== undefined && resolution.aid !== this.checkpoint.state.aid) {
      return { ok: false, needsManual: true, reason: "archive identity mismatch during recovery" };
    }
    const prior = this.checkpoint.state;
    this.checkpoint.state = resolution.kind === "created"
      ? { ...this.checkpoint.state, ...(resolution.bvid ? { bvid: resolution.bvid } : {}), ...(resolution.aid !== undefined ? { aid: resolution.aid } : {}) }
      : { ...this.checkpoint.state, bvid: resolution.bvid ?? this.checkpoint.state.bvid, aid: resolution.aid };
    this.markRecoveredPending(p, true);
    try {
      this.checkpoint.persist();
    }
    catch (e) {
      this.checkpoint.state = prior;
      const reason = resolution.kind === "created" ? "recovered archive but cannot persist state" : "recovered append but cannot persist state";
      return { ok: false, archiveExists: true, reason: reason + ": " + String((e as Error)?.message ?? e).slice(0, 200) };
    }
    if (this.o.submitter) {
      try {
        this.o.submitter.observeStreamedPart({
          ref: { targetId: this.o.submitterTargetId ?? "bilibili-upos", id: resolution.bvid ?? String(resolution.aid ?? this.checkpoint.state.aid) },
          name: p.stem,
        });
      } catch (e) {
        return { ok: false, archiveExists: true, reason: "cannot persist observed upload checkpoint: " + String((e as Error)?.message ?? e).slice(0, 200) };
      }
    }
    this.cleanup();
    try {
      this.o.reporter?.event({ at: Date.now(), kind: "recovered", part: p.partIndex });
    }
    catch {
    }
    return { ok: true };
  }
  private markRecoveredPending(p: NonNullable<LivePumpState["pending"]>, confirmed: boolean): void {
    const existing = this.checkpoint.state.parts.find(x => x.index === p.partIndex);
    const proof: NonNullable<LivePumpState["parts"][number]["proof"]> = confirmed ? "observed" : "accepted";
    const part = {
      index: p.partIndex,
      spoolPath: p.spoolPath,
      filename: basename(p.spoolPath),
      stem: p.stem,
      title: p.title,
      bytes: p.bytes,
      durationSec: p.durationSec,
      confirmed,
      proof,
      nativeKey: p.stem,
      sourceFp: p.sourceFp,
      ...(confirmed ? { observedAt: Date.now() } : {}),
    };
    this.checkpoint.state = {
      ...this.checkpoint.state,
      parts: existing ? this.checkpoint.state.parts.map(x => x.index === p.partIndex ? {
        ...x,
        confirmed,
        proof,
        nativeKey: p.stem,
        sourceFp: p.sourceFp,
        ...(confirmed ? { observedAt: Date.now() } : {}),
        ...(p.stem ? { stem: p.stem } : {}),
      } : x) : [...this.checkpoint.state.parts, part],
      pending: undefined,
    };
  }
}
