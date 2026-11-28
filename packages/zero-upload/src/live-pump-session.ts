import { LivePumpSessionRecovery } from "./live-pump-session-recovery.js";
import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { noteRecorderProgress } from "@drec/core";
import { lookupArchive, type StudioVideo } from "./upos-stream.js";
import { isLivePumpPartObserved, readLivePumpState, type LivePumpState } from "./live-pump-state.js";
import { LivePumpSeason } from "./live-pump-season.js";
import { publishLivePumpPart } from "./live-pump-publication.js";
import { publishLegacyLivePumpPart } from "./live-pump-legacy-publication.js";
import { resolveInterruptedPublication, type RecoveryResult } from "./live-pump-recovery.js";
import type { LivePumpSessionOpts, PartSubmitInput, SpoolResubmitResult } from "./live-pump-session-options.js";
import { LivePumpCheckpoint } from "./live-pump-checkpoint.js";
/** Stable session interface; remote publication and local checkpoint writes share one owner. */
export class LivePumpSession {
  private readonly recovery: LivePumpSessionRecovery;
  private readonly checkpoint: LivePumpCheckpoint;
  private readonly season: LivePumpSeason;
  private readonly log: (message: string) => void;
  private submitTail: Promise<void> = Promise.resolve();
  constructor(private readonly o: LivePumpSessionOpts) {
    this.log = o.log ?? (message => process.stderr.write(message + "\n"));
    this.checkpoint = new LivePumpCheckpoint(o);
    this.recovery = new LivePumpSessionRecovery(o, this.checkpoint, (input, signal) => this.submitPart(input, signal), () => this.cleanupConfirmed());
    this.season = new LivePumpSeason(o, {
      read: () => this.state,
      apply: seasonState => {
        this.state = { ...this.state, seasonState, updatedAt: Date.now() };
      },
      persist: () => this.persist({ seasonOnly: true }),
    }, this.log);
  }
  private get state(): LivePumpState {
    return this.checkpoint.state;
  }
  private set state(value: LivePumpState) {
    this.checkpoint.state = value;
  }
  private get stateUntrusted(): boolean {
    return this.checkpoint.stateUntrusted;
  }
  private persist(opts?: {
    seasonOnly?: boolean;
  }): void {
    this.checkpoint.persist(opts);
  }
  get bvid(): string | undefined {
    return this.checkpoint.bvid;
  }
  get sessionInfo(): {
    sessionId: string;
    createdAt: number;
    resumed: boolean;
  } {
    return this.checkpoint.sessionInfo;
  }
  get aid(): number | undefined {
    return this.checkpoint.aid;
  }
  get parts(): LivePumpState["parts"] {
    return this.checkpoint.parts;
  }
  get hasUnconfirmed(): boolean {
    return this.checkpoint.hasUnconfirmed;
  }
  get roomKey(): string {
    return this.checkpoint.roomKey;
  }
  get archiveTitle(): string {
    return this.checkpoint.archiveTitle;
  }
  get nextPartIndex(): number {
    return this.checkpoint.nextPartIndex;
  }
  get hasArchiveIdentity(): boolean {
    return this.checkpoint.hasArchiveIdentity;
  }
  setTitleIfFresh(title: string): boolean {
    return this.checkpoint.setTitleIfFresh(title);
  }
  snapshot(): LivePumpState {
    return this.checkpoint.snapshot();
  }
  dropPart(index: number): void {
    return this.checkpoint.dropPart(index);
  }
  noteUnconfirmedPart(input: {
    index: number;
    spoolPath: string;
    title: string;
    bytes: number;
    durationSec: number;
    stem?: string;
    spoolIncomplete?: boolean;
    sealed?: boolean;
    validated?: boolean;
    needsValidation?: boolean;
  }): {
    ok: boolean;
    error?: string;
  } {
    return this.checkpoint.noteUnconfirmedPart(input);
  }
  markSpoolIncomplete(index: number): void {
    return this.checkpoint.markSpoolIncomplete(index);
  }
  markValidated(index: number): {
    ok: boolean;
    error?: string;
  } {
    return this.checkpoint.markValidated(index);
  }
  dropUnrecoverableUnsealed(): number[] {
    return this.checkpoint.dropUnrecoverableUnsealed();
  }
  markDeliveryDeferred(): void {
    return this.checkpoint.markDeliveryDeferred();
  }
  adoptQueueManaged(): void {
    return this.checkpoint.adoptQueueManaged();
  }
  reconcileConfirmedJournal(): {
    changed: boolean;
    unconfirmedRemain: boolean;
  } {
    return this.checkpoint.reconcileConfirmedJournal();
  }
  submitPart(input: {
    index: number;
    spoolPath: string;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
  }, signal?: AbortSignal): Promise<{
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
    needsManual?: boolean;
    retryable?: boolean;
  }> {
    // The pending check and the intent write are separated by awaits; concurrent callers could
    // otherwise both publish a fresh archive. Serialize submissions so the second caller observes
    // the first caller's pending or confirmed part.
    const run = this.submitTail.then(() => this.submitPartExclusive(input, signal));
    this.submitTail = run.then(() => undefined, () => undefined);
    return run;
  }
  private async submitPartExclusive(input: {
    index: number;
    spoolPath: string;
    stem: string;
    title: string;
    bytes: number;
    durationSec: number;
  }, signal?: AbortSignal): Promise<{
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
    needsManual?: boolean;
    retryable?: boolean;
  }> {
    if (this.stateUntrusted) {
      return { ok: false, error: "state sidecar is untrusted; refusing to submit (manual recovery required)" };
    }
    if (this.state.pending) {
      return { ok: false, error: "previous part outcome is pending; run recover() before submitting more parts" };
    }
    const unconfirmed = this.checkpoint.lowestUnconfirmed();
    if (unconfirmed && unconfirmed.index !== input.index) {
      return { ok: false, error: `part ${unconfirmed.index} is not confirmed; refusing to submit part ${input.index}` };
    }
    const existing = this.state.parts.find(p => p.index === input.index);
    if (existing?.proof === "accepted")
      return { ok: false, needsManual: true, error: "accepted part requires observation, never resubmission" };
    if (existing && (existing.confirmed || existing.proof === "observed") && !isLivePumpPartObserved(existing))
      return { ok: false, needsManual: true, error: "unqualified prior confirmation cannot authorize resubmission" };
    if (existing && isLivePumpPartObserved(existing)) {
      if (this.o.submitter && existing.nativeKey) {
        try {
          this.o.submitter.observeStreamedPart({
            ref: { targetId: this.o.submitterTargetId ?? "bilibili-upos", id: this.state.bvid ?? String(this.state.aid) },
            name: existing.nativeKey,
          });
        } catch (e) {
          return { ok: false, error: "cannot restore observed upload checkpoint: " + String((e as Error)?.message ?? e).slice(0, 200) };
        }
      }
      this.cleanupConfirmed();
      return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
    }
    if (existing?.confirmed)
      return { ok: false, needsManual: true, error: "legacy confirmation has no per-part observation proof; source retained" };
    if (this.o.submitter)
      return this.submitPartViaSubmitter(input, existing, signal);
    return this.submitLegacy(input, existing, signal);
  }
  private async submitLegacy(input: PartSubmitInput, existing: LivePumpState["parts"][number] | undefined, signal?: AbortSignal): Promise<{
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
    retryable?: boolean;
  }> {
    const doFetch = this.o.fetchImpl ?? fetch;
    const video: StudioVideo = { filename: input.stem, title: input.title.slice(0, 80) };
    const pending: LivePumpState["pending"] = {
      kind: this.state.bvid || this.state.aid ? "append" : "create",
      submissionState: "intent",
      partIndex: input.index,
      stem: input.stem,
      title: input.title,
      bytes: input.bytes,
      durationSec: input.durationSec,
      spoolPath: input.spoolPath,
    };
    this.state = { ...this.state, pending };
    try {
      this.persist();
    }
    catch (e) {
      return { ok: false, error: `cannot persist upload intent: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    const result = await publishLegacyLivePumpPart({
      kind: pending.kind,
      video,
      cookiesPath: this.o.cookiesPath,
      fetchImpl: doFetch,
      readArchive: () => {
        const { title, tid, tag, desc, private: isPrivate, bvid, aid } = this.state;
        return { title, tid, tag, desc, private: isPrivate, bvid, aid };
      },
      log: this.log,
      submitGate: this.o.submitGate,
      sleep: this.o.sleep,
      rateLimitBaseMs: this.o.rateLimitBaseMs,
      rateLimitAttempts: this.o.rateLimitAttempts,
      signal,
    });
    if (!result.ok)
      return { ok: false, ...(result.retryable ? { retryable: true } : {}), error: result.error };
    if (result.proof === "accepted") {
      return this.recordAcceptedAndObserve(input, existing, pending.kind, result.bvid, result.aid, signal);
    }
    return this.recordConfirmed(input, existing, pending.kind, result.bvid, result.aid);
  }
  private recordConfirmed(input: PartSubmitInput, existing: LivePumpState["parts"][number] | undefined, kind: "create" | "append", bvid?: string, aid?: number): {
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
  } {
    const prior = this.state;
    this.state = {
      ...this.state,
      bvid: bvid ?? this.state.bvid,
      aid: aid ?? this.state.aid,
      ...(kind === "create" && this.o.seasonSectionId ? { seasonState: "pending" as const } : {}),
      parts: existing ? this.state.parts.map(p => p.index === input.index ? {
        ...p,
        spoolPath: input.spoolPath,
        filename: basename(input.spoolPath),
        stem: input.stem,
        title: input.title,
        bytes: input.bytes,
        durationSec: input.durationSec,
        confirmed: true,
        proof: "observed",
        nativeKey: input.stem,
        observedAt: Date.now(),
      } : p) : [...this.state.parts, {
          index: input.index,
          spoolPath: input.spoolPath,
          filename: basename(input.spoolPath),
          stem: input.stem,
          title: input.title,
          bytes: input.bytes,
          durationSec: input.durationSec,
          confirmed: true,
          proof: "observed",
          nativeKey: input.stem,
          observedAt: Date.now(),
        }],
      pending: undefined,
    };
    if (kind === "create" && this.o.seasonSectionId) {
      try {
        this.o.reporter?.event({ at: Date.now(), kind: "season_pending", part: input.index });
      }
      catch {
      }
    }
    try {
      this.persist();
    }
    catch (e) {
      this.state = prior;
      return { ok: false, error: "cannot persist confirmation: " + String((e as Error)?.message ?? e).slice(0, 200) };
    }
    if (this.o.submitter) {
      try {
        this.o.submitter.observeStreamedPart({
          ref: { targetId: this.o.submitterTargetId ?? "bilibili-upos", id: this.state.bvid ?? String(this.state.aid) },
          name: input.stem,
        });
      } catch (e) {
        return { ok: false, error: "cannot persist observed upload checkpoint: " + String((e as Error)?.message ?? e).slice(0, 200) };
      }
    }
    noteRecorderProgress();
    this.cleanupConfirmed();
    if (kind === "create" && this.o.seasonSectionId) {
      this.season.queue(this.o.fetchImpl ?? fetch, false);
    }
    return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
  }
  private async resolveSubmitterIdentity(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.state.bvid || this.state.aid === undefined)
      return;
    const aid = this.state.aid;
    if (!Number.isSafeInteger(aid) || aid <= 0)
      throw new Error("invalid legacy archive aid");
    const found = await lookupArchive({
      cookiesPath: this.o.cookiesPath,
      aid,
      fetchImpl: this.o.fetchImpl,
      signal,
    });
    signal?.throwIfAborted();
    const bvid = found.archive?.bvid?.trim();
    if (!found.ok || found.archive?.aid !== aid || !bvid) {
      throw new Error("cannot verify legacy archive identity; manual recovery required");
    }
    this.state = { ...this.state, bvid };
    this.persist();
  }
  private async submitPartViaSubmitter(input: PartSubmitInput, existing: LivePumpState["parts"][number] | undefined, signal?: AbortSignal): Promise<{
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
    needsManual?: boolean;
    retryable?: boolean;
  }> {
    const submitter = this.o.submitter;
    if (!submitter)
      return { ok: false, error: "submitter missing" };
    try {
      await this.resolveSubmitterIdentity(signal);
      signal?.throwIfAborted();
    }
    catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300), ...(!signal?.aborted ? { needsManual: true } : {}) };
    }
    const kind: "create" | "append" = this.state.bvid || this.state.aid ? "append" : "create";
    this.state = {
      ...this.state,
      pending: {
        kind,
        submissionState: "intent",
        partIndex: input.index,
        stem: input.stem,
        title: input.title,
        bytes: input.bytes,
        durationSec: input.durationSec,
        spoolPath: input.spoolPath,
      },
    };
    try {
      this.persist();
    }
    catch (e) {
      return { ok: false, error: "cannot persist upload intent: " + String((e as Error)?.message ?? e).slice(0, 200) };
    }
    const result = await publishLivePumpPart({
      submitter,
      targetId: this.o.submitterTargetId,
      kind,
      part: input,
      signal,
      archive: {
        bvid: this.state.bvid,
        aid: this.state.aid,
        title: this.state.title,
        tid: this.state.tid,
        tag: this.state.tag,
        desc: this.state.desc,
        private: this.state.private,
      },
    });
    if (!result.ok)
      return result;
    if (result.proof === "accepted") {
      return this.recordAcceptedAndObserve(input, existing, kind, result.bvid, result.aid, signal);
    }
    return this.recordConfirmed(input, existing, kind, result.bvid, result.aid);
  }
  private async recordAcceptedAndObserve(
    input: PartSubmitInput,
    existing: LivePumpState["parts"][number] | undefined,
    kind: "create" | "append",
    bvid?: string,
    aid?: number,
    signal?: AbortSignal,
  ): Promise<{ ok: boolean; bvid?: string; aid?: number; error?: string; needsManual?: boolean }> {
    const pending = this.state.pending;
    if (!pending) return { ok: false, error: "accepted upload has no durable pending intent" };
    this.state = {
      ...this.state,
      ...(bvid ? { bvid } : {}),
      ...(aid !== undefined ? { aid } : {}),
      pending: {
        ...pending,
        submissionState: "accepted",
        acceptedAt: Date.now(),
        ...(bvid ? { acceptedBvid: bvid } : {}),
        ...(aid !== undefined ? { acceptedAid: aid } : {}),
      },
      parts: existing ? this.state.parts.map((part) => part.index === input.index
        ? { ...part, proof: "accepted", nativeKey: input.stem, acceptedAt: Date.now(), confirmed: false }
        : part)
        : [...this.state.parts, {
          index: input.index,
          spoolPath: input.spoolPath,
          filename: basename(input.spoolPath),
          stem: input.stem,
          title: input.title,
          bytes: input.bytes,
          durationSec: input.durationSec,
          confirmed: false,
          proof: "accepted",
          nativeKey: input.stem,
          acceptedAt: Date.now(),
        }],
    };
    try {
      this.persist();
    } catch (e) {
      return { ok: false, error: "cannot persist accepted upload: " + String((e as Error)?.message ?? e).slice(0, 200) };
    }
    if (signal?.aborted) return { ok: false, needsManual: true, error: "accepted upload awaits observation; source retained" };
    const resolution = await resolveInterruptedPublication({
      pending: this.state.pending!,
      cookiesPath: this.o.cookiesPath,
      fetchImpl: this.o.fetchImpl,
      archive: { title: this.state.title, bvid: this.state.bvid, aid: this.state.aid },
    });
    if (resolution.kind === "blocked") {
      return { ok: false, needsManual: true, error: resolution.result.reason ?? "accepted part is not yet positively observed; source retained" };
    }
    if (resolution.kind === "existing" && this.state.aid !== undefined && resolution.aid !== this.state.aid) {
      return { ok: false, needsManual: true, error: "archive identity mismatch after accepted upload; source retained" };
    }
    const acceptedPart = this.state.parts.find((part) => part.index === input.index);
    if (!acceptedPart) {
      return { ok: false, needsManual: true, error: "accepted upload checkpoint disappeared before observation; source retained" };
    }
    return this.recordConfirmed(
      input,
      acceptedPart,
      kind,
      resolution.bvid ?? bvid ?? this.state.bvid,
      resolution.aid ?? aid ?? this.state.aid,
    );
  }
  drainSeason(): Promise<void> {
    return this.season.drain();
  }
  failSeasonWriteOnce(): void {
    this.season.failWriteOnce();
  }
  async reconcileSeason(fetchImpl?: typeof fetch): Promise<void> {
    await this.season.reconcile(fetchImpl);
  }
  private cleanupConfirmed(): void {
    if (this.o.cleanupConfirmedSpool === false || this.stateUntrusted)
      return;
    const durable = readLivePumpState(this.checkpoint.statePath);
    if (!durable || durable.createdAt !== this.state.createdAt || durable.room !== this.state.room
      || durable.bvid !== this.state.bvid || durable.aid !== this.state.aid)
      return;
    for (const p of durable.parts) {
      if (!isLivePumpPartObserved(p) || durable.pending?.partIndex === p.index)
        continue;
      if (!existsSync(p.spoolPath))
        continue;
      try {
        this.o.submitter?.observeStreamedPart({
          ref: { targetId: this.o.submitterTargetId ?? "bilibili-upos", id: durable.bvid ?? String(durable.aid) },
          name: p.nativeKey!,
        });
        rmSync(p.spoolPath, { force: true });
        this.log(`[直播直传] confirmed part ${p.index}, removed spool ${p.spoolPath}`);
      }
      catch (e) {
        this.log(`[直播直传] confirmed part ${p.index}, spool cleanup failed: ${String((e as Error)?.message ?? e)}`);
      }
    }
  }
  resubmitAllUnconfirmed(signal?: AbortSignal): Promise<{
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
    held?: number[];
    retryable?: boolean;
  }> {
    return this.recovery.resubmitAllUnconfirmed(signal);
  }
  resubmitUnconfirmedPart(signal?: AbortSignal): Promise<SpoolResubmitResult> {
    return this.recovery.resubmitUnconfirmedPart(signal);
  }
  recover(): Promise<RecoveryResult> {
    return this.recovery.recover();
  }
}
