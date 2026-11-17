import { LivePumpSessionRecovery } from "./live-pump-session-recovery.js";
import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { noteRecorderProgress } from "@drec/core";
import { lookupArchive, type StudioVideo } from "./upos-stream.js";
import { type LivePumpState } from "./live-pump-state.js";
import { LivePumpSeason } from "./live-pump-season.js";
import { publishLivePumpPart } from "./live-pump-publication.js";
import { publishLegacyLivePumpPart } from "./live-pump-legacy-publication.js";
import { type RecoveryResult } from "./live-pump-recovery.js";
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
    if (existing?.confirmed)
      return { ok: true, bvid: this.state.bvid, aid: this.state.aid };
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
    return this.recordConfirmed(input, existing, pending.kind, result.bvid, result.aid);
  }
  private recordConfirmed(input: PartSubmitInput, existing: LivePumpState["parts"][number] | undefined, kind: "create" | "append", bvid?: string, aid?: number): {
    ok: boolean;
    bvid?: string;
    aid?: number;
    error?: string;
  } {
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
      } : p) : [...this.state.parts, {
          index: input.index,
          spoolPath: input.spoolPath,
          filename: basename(input.spoolPath),
          stem: input.stem,
          title: input.title,
          bytes: input.bytes,
          durationSec: input.durationSec,
          confirmed: true,
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
      return { ok: false, error: "cannot persist confirmation: " + String((e as Error)?.message ?? e).slice(0, 200) };
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
    return this.recordConfirmed(input, existing, kind, result.bvid, result.aid);
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
    if (this.o.cleanupConfirmedSpool === false)
      return;
    for (const p of this.state.parts) {
      if (!p.confirmed)
        continue;
      if (!existsSync(p.spoolPath))
        continue;
      try {
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
