import { existsSync, statSync } from "node:fs";
import { ffprobeDuration } from "@drec/post-process";
import { LivePumpSession } from "./live-pump-session.js";
import { LivePumpObserver } from "./live-pump-observer.js";
import { LivePumpSource } from "./live-pump-source.js";
import { hasUnobservedLivePumpWork, livePumpStatePath, readLivePumpState, requiresLivePumpProof, type LivePumpState } from "./live-pump-state.js";
import { livePumpHasUnconfirmed } from "./live-pump-confirmations.js";
import { defaultScanDtsGap, heldGapPath } from "./live-pump-spool-recovery.js";
import { MiB } from "./live-pump-policy.js";
import type { RunLivePumpOptions, RunLivePumpResult } from "./live-pump-run-options.js";
type OpenSession = {
  session: LivePumpSession;
  spoolOnlyRun: boolean;
} | {
  fail: RunLivePumpResult;
} | {
  pending: RunLivePumpResult;
};
/** Recover old work before waiting, then decide broadcast identity again once live. */
export class LivePumpStartup {
  constructor(private readonly o: RunLivePumpOptions, private readonly events: LivePumpObserver, private readonly source: LivePumpSource) {
  }
  private result(session: LivePumpSession, values: Partial<RunLivePumpResult>): RunLivePumpResult {
    return { ok: false, title: session.archiveTitle, segments: [], spoolDir: this.o.spoolDir, statePath: livePumpStatePath(this.o.spoolDir, this.o.room), ...values };
  }
  async open(): Promise<OpenSession> {
    const session = this.create();
    let spoolOnlyRun = this.o.submitMode === "spool";
    if (this.o.submit !== false) {
      const queued = this.queueOwnership(session);
      if (typeof queued === "object")
        return queued;
      spoolOnlyRun ||= queued === "protected-hold";
      if (queued !== "protected-hold" && spoolOnlyRun)
        await this.recoverSpool(session);
      else if (queued !== "protected-hold") {
        const failed = await this.recoverDirect(session);
        if (failed)
          return failed;
      }
    }
    if (spoolOnlyRun)
      this.handoff(session);
    return { session, spoolOnlyRun };
  }
  private queueOwnership(session: LivePumpSession): "protected-hold" | {
    fail: RunLivePumpResult;
  } | undefined {
    const path = livePumpStatePath(this.o.spoolDir, this.o.room);
    const queued = readLivePumpState(path);
    if (!queued || !hasUnobservedLivePumpWork(queued))
      return;
    if (requiresLivePumpProof(queued) && !(queued.queueManaged || queued.deliveryDeferred))
      return;
    const error = requiresLivePumpProof(queued)
      ? "Protected delivery observation paused; legacy queue markers do not transfer its UPOS ownership"
      : "Legacy delivery has no native per-part observation; queue ownership is unqualified and source is retained for manual review";
    this.events.log("[live-pump] " + error);
    if (this.o.spoolMode === "none")
      return { fail: this.result(session, { error, bvid: queued.bvid, aid: queued.aid }) };
    return "protected-hold";
  }
  private async recoverDirect(session: LivePumpSession): Promise<Exclude<OpenSession, {
    session: LivePumpSession;
  }> | undefined> {
    this.events.phase("finalizing");
    try {
      const recovered = await session.recover();
      if (!recovered.ok) {
        this.events.log(recovered.archiveExists ? "[直播直传] 稿件已存在但状态不确定,禁止新建稿件: " + recovered.reason : "[直播直传] 恢复失败,停止以避免重复建稿: " + recovered.reason);
        return { fail: this.result(session, {
            error: recovered.reason,
            archiveExists: !!recovered.archiveExists,
          }) };
      }
      session.dropUnrecoverableUnsealed();
      if (session.bvid || session.aid)
        await session.reconcileSeason(this.o.fetchImpl);
      return await this.recoverUnconfirmed(session);
    }
    finally {
      this.events.phase(this.idlePhase(session));
    }
  }
  private async recoverUnconfirmed(session: LivePumpSession): Promise<Exclude<OpenSession, {
    session: LivePumpSession;
  }> | undefined> {
    if (!session.hasUnconfirmed)
      return;
    const pending = session.parts.filter(part => !part.confirmed);
    if (pending.length < 1 || !pending.every(part => existsSync(part.spoolPath) || existsSync(heldGapPath(part.spoolPath)))) {
      this.events.log("[直播直传] 有 " + pending.length + " 个未确认分 P;为避免重复/空洞,拒绝继续录制上传");
      return { fail: this.result(session, { error: "unconfirmed parts: " + pending.map(p => p.index).join(","), bvid: session.bvid, aid: session.aid }) };
    }
    this.events.log("[直播直传] 有 " + pending.length + " 个未确认分 P(索引 " + pending.map(p => p.index).join(",") + "),按整文件重传补齐");
    const fixed = await session.resubmitAllUnconfirmed(this.o.signal);
    if (fixed.held?.length)
      this.events.log("[直播直传] ⚠️ 恢复时有 " + fixed.held.length + " 个分 P 因时间戳跳变被扣留(索引 " + fixed.held.join(",") + "),稿件缺这几 P,需人工处理");
    if (fixed.ok)
      return;
    if (!fixed.retryable)
      return { fail: this.result(session, {
          error: fixed.error,
          bvid: session.bvid,
          aid: session.aid,
        }) };
    const message = "直播直传上传待补: " + (fixed.error ?? "upload pending") + "；spool 已保留,稍后自动重试";
    this.events.log("[直播直传] ⚠️ " + message);
    this.events.alert(message);
    return { pending: this.result(session, {
        uploadPending: true,
        error: fixed.error,
        bvid: session.bvid,
        aid: session.aid,
      }) };
  }
  private idlePhase(session: LivePumpSession): "polling" | "finalizing" {
    return session.hasUnconfirmed ? "finalizing" : "polling";
  }
  private create(): LivePumpSession {
    const session = new LivePumpSession({
      cookiesPath: this.o.cookiesPath,
      room: this.o.room,
      spoolDir: this.o.spoolDir,
      title: this.o.title,
      tid: this.o.tid,
      tag: this.o.tag,
      ...(this.o.desc ? { desc: this.o.desc } : {}),
      ...(this.o.seasonSectionId ? { seasonSectionId: this.o.seasonSectionId } : {}),
      private: this.o.private !== false,
      log: this.events.log,
      ...(this.o.onAlert ? { onAlert: this.o.onAlert } : {}),
      ...(this.o.submitGate ? { submitGate: this.o.submitGate } : {}),
      ...(this.o.submitter ? { submitter: this.o.submitter } : {}),
      ...(this.o.submitterTargetId ? { submitterTargetId: this.o.submitterTargetId } : {}),
      fetchImpl: this.o.fetchImpl,
      ...(this.o.reporter ? { reporter: this.o.reporter } : {}),
      ...(this.o.probeDuration ? { probeDuration: this.o.probeDuration } : {}),
      ...(this.o.scanDtsGap ? { scanDtsGap: this.o.scanDtsGap } : {}),
      ...(this.o.sleep ? { sleep: this.o.sleep } : {}),
    });
    const info = session.sessionInfo;
    this.events.emit({
      at: Date.now(),
      kind: info.resumed ? "run_resume" : "run_start",
      session: info,
    });
    return session;
  }
  private async recoverSpool(session: LivePumpSession): Promise<boolean> {
    let pendingNeedsManual = false;
    if (session.hasUnconfirmed) {
      try {
        const recovered = await session.recover();
        if (!recovered.ok) {
          this.events.log(`[直播直传] ⚠️ 待决提交意图无法消歧(继续录制,该分 P 暂不入队): ${recovered.reason}`);
          pendingNeedsManual = recovered.needsManual === true;
        }
      }
      catch (e) {
        this.events.log(`[直播直传] ⚠️ 待决提交意图消歧失败(继续录制): ${String((e as Error)?.message ?? e)}`);
      }
    }
    session.dropUnrecoverableUnsealed();
    for (const row of session.parts.filter(x => !x.validated && !x.confirmed))
      await this.revalidate(session, row);
    return pendingNeedsManual;
  }
  private async revalidate(session: LivePumpSession, row: LivePumpState["parts"][number]): Promise<void> {
    let bytes = 0;
    try {
      bytes = statSync(row.spoolPath).size;
    }
    catch {
    }
    if (!(bytes > 0))
      return;
    const title = row.title || this.o.partTitle?.(row.index + 1) || `P${row.index + 1}`;
    if (row.spoolIncomplete) {
      session.noteUnconfirmedPart({ index: row.index, spoolPath: row.spoolPath, title, bytes, durationSec: row.durationSec, ...(row.stem ? { stem: row.stem } : {}), spoolIncomplete: true });
      return;
    }
    const probe = this.o.probeDuration ?? ffprobeDuration;
    let dur = 0;
    try {
      dur = await probe(row.spoolPath);
    }
    catch {
      dur = 0;
    }
    if (dur > 0) {
      try {
        const gap = await (this.o.scanDtsGap ?? defaultScanDtsGap)(row.spoolPath);
        if (gap !== null)
          dur = 0;
      }
      catch {
        dur = 0;
      }
    }
    if (dur > 0) {
      const note = session.noteUnconfirmedPart({
        index: row.index,
        spoolPath: row.spoolPath,
        title,
        bytes,
        durationSec: dur,
        ...(row.stem ? { stem: row.stem } : {}),
        validated: true,
      });
      if (note.ok)
        this.events.log(`[直播直传] 分 P ${row.index} 未过校验的存量分 P,本地校验通过(${(bytes / MiB).toFixed(1)}MiB),已转可交付,收播后由队列补传`);
      else
        this.events.log(`[直播直传] ⚠️ 分 P ${row.index} 未过校验转可交付失败: ${note.error ?? "?"}`);
    }
    else {
      session.noteUnconfirmedPart({ index: row.index, spoolPath: row.spoolPath, title, bytes, durationSec: 0, spoolIncomplete: true });
      const msg = `分 P ${row.index} 未过校验且本地校验未过,spool 保留需人工处理`;
      this.events.log(`[直播直传] ⚠️ ${msg}`);
      try {
        this.o.onAlert?.(msg);
      }
      catch {
      }
    }
  }
  private handoff(session: LivePumpSession): void {
    if (!this.o.onHandoff || !hasUnobservedLivePumpWork(session.snapshot()))
      return;
    const detail = requiresLivePumpProof(session.snapshot())
      ? "Protected UPOS delivery cannot transfer to an unqualified queue executor"
      : "Legacy live delivery has no native per-part observation";
    const message = "Live delivery handoff blocked; manual review required: " + detail;
    this.events.log("[live-pump] " + message);
    try {
      this.o.onAlert?.(message);
    }
    catch {
    }
  }
  async prepare(): Promise<RunLivePumpResult | undefined> {
    let preRecoveryOpened = false;
    let preRecoverySpoolOnlyRun = false;
    if (this.o.waitForBroadcast) {
      const st = existsSync(livePumpStatePath(this.o.spoolDir, this.o.room)) ? readLivePumpState(livePumpStatePath(this.o.spoolDir, this.o.room)) : undefined;
      if (this.o.submit !== false && st !== undefined && (!st || st.room !== this.o.room || hasUnobservedLivePumpWork(st))) {
        this.events.log("[直播直传] 上次运行留有未确认分 P,等待开播前先恢复");
        const pre = await this.open();
        if ("pending" in pre)
          return pre.pending;
        if ("fail" in pre)
          return pre.fail;
        preRecoveryOpened = true;
        preRecoverySpoolOnlyRun = pre.spoolOnlyRun === true;
      }
      if (preRecoveryOpened)
        this.events.emit({ at: Date.now(), kind: "waiting" });
      const first = await this.source.waitForBroadcast();
      if (!first) {
        const idleStatePath = livePumpStatePath(this.o.spoolDir, this.o.room);
        if (preRecoveryOpened && preRecoverySpoolOnlyRun && livePumpHasUnconfirmed(idleStatePath)) {
          const idleState = readLivePumpState(idleStatePath);
          return {
            ok: false,
            error: "Live delivery observation paused; source and queue history require manual review",
            ...(idleState?.bvid ? { bvid: idleState.bvid } : {}),
            ...(idleState?.aid ? { aid: idleState.aid } : {}),
            title: this.o.title,
            segments: [],
            spoolDir: this.o.spoolDir,
            statePath: idleStatePath,
          };
        }
        return {
          ok: true,
          outcome: "idle",
          title: this.o.title,
          segments: [],
          spoolDir: this.o.spoolDir,
          statePath: idleStatePath,
        };
      }
    }
  }
}
