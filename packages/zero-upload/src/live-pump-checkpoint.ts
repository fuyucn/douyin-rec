import { mkdirSync, statSync } from "node:fs";
import { basename } from "node:path";
import { isLivePumpPartObserved, livePumpStatePath, readLivePumpState, requiresLivePumpProof, writeLivePumpState, type LivePumpState } from "./live-pump-state.js";
import { readConfirmedJournal } from "./live-pump-confirmations.js";
import { markActivity, rolloverStaleState } from "./live-pump-spool-policy.js";
import type { LivePumpSessionOpts } from "./live-pump-session-options.js";
/** Sole local writer: staged publication changes persist before any irreversible request. */
export class LivePumpCheckpoint {
  readonly statePath: string;
  state: LivePumpState;
  private readonly log: (msg: string) => void;
  stateUntrusted = false;
  private readonly resumed: boolean;
  private lastActivityMarkMs = 0;
  constructor(private readonly o: LivePumpSessionOpts) {
    mkdirSync(o.spoolDir, { recursive: true });
    this.log = o.log ?? (m => process.stderr.write(`${m}\n`));
    this.statePath = livePumpStatePath(o.spoolDir, o.room);
    const rolloverAlert = rolloverStaleState(this.statePath, o.room, Date.now(), this.log);
    if (rolloverAlert)
      o.onAlert?.(rolloverAlert);
    const loaded = readLivePumpState(this.statePath);
    this.resumed = !!loaded;
    if (loaded && loaded.room !== o.room) {
      throw new Error(`live-pump state room mismatch: ${loaded.room} != ${o.room}`);
    }
    this.state = loaded ?? {
      schemaVersion: 1,
      submissionProofVersion: 1,
      room: o.room,
      createdAt: Date.now(),
      title: o.title,
      tid: o.tid,
      tag: o.tag,
      ...(o.desc ? { desc: o.desc } : {}),
      private: o.private !== false,
      parts: [],
      updatedAt: Date.now(),
    };
    if (loaded) {
      this.log(`[直播直传] resumed state ${this.statePath} (${loaded.parts.length} parts, title=${loaded.title})`);
      const rec = this.reconcileConfirmedJournal();
      if (rec.changed) {
        this.log(rec.unconfirmedRemain ? "[直播直传] 已收编队列确认日志(仍有未确认分 P 待队列补传)" : "[直播直传] 已收编队列确认日志(全部分 P 已确认)");
      }
    }
  }
  get bvid(): string | undefined {
    return this.state.bvid;
  }
  get sessionInfo(): {
    sessionId: string;
    createdAt: number;
    resumed: boolean;
  } {
    return { sessionId: `${this.state.room}:${this.state.createdAt}`, createdAt: this.state.createdAt, resumed: this.resumed };
  }
  get aid(): number | undefined {
    return this.state.aid;
  }
  get parts(): LivePumpState["parts"] {
    return [...this.state.parts];
  }
  get hasUnconfirmed(): boolean {
    if (requiresLivePumpProof(this.state))
      return !!this.state.pending || this.state.parts.some(part => !isLivePumpPartObserved(part));
    return !!this.state.pending || this.state.parts.some(p => !p.confirmed);
  }
  get roomKey(): string {
    return this.state.room;
  }
  get archiveTitle(): string {
    return this.state.title;
  }
  get nextPartIndex(): number {
    return this.state.parts.reduce((m, p) => Math.max(m, p.index + 1), 0);
  }
  get hasArchiveIdentity(): boolean {
    return !!this.state.bvid || !!this.state.aid || this.state.parts.length > 0 || !!this.state.pending;
  }
  setTitleIfFresh(title: string): boolean {
    if (this.hasArchiveIdentity || !title.trim())
      return false;
    this.state = { ...this.state, title };
    return true;
  }
  snapshot(): LivePumpState {
    return JSON.parse(JSON.stringify(this.state)) as LivePumpState;
  }
  lowestUnconfirmed(): LivePumpState["parts"][number] | undefined {
    let best: LivePumpState["parts"][number] | undefined;
    for (const p of this.state.parts)
      if (!(requiresLivePumpProof(this.state) ? isLivePumpPartObserved(p) : p.confirmed) && (!best || p.index < best.index))
        best = p;
    return best;
  }
  dropPart(index: number): void {
    if (!this.state.parts.some(p => p.index === index))
      return;
    this.state = { ...this.state, parts: this.state.parts.filter(p => p.index !== index) };
    try {
      this.persist();
    }
    catch {
    }
  }
  /** Rebuilding a row clears stale validation; only a proven local gate may set it again. */
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
    if (this.stateUntrusted)
      return { ok: false, error: "state sidecar is untrusted" };
    if (this.state.pending && this.state.pending.partIndex === input.index)
      return { ok: false, error: "another submit is pending" };
    const existing = this.state.parts.find(p => p.index === input.index);
    if (existing?.proof === "accepted")
      return { ok: false, error: "accepted part must be observed by its original owner" };
    if (existing?.confirmed)
      return { ok: true };
    const part = {
      index: input.index,
      spoolPath: input.spoolPath,
      filename: basename(input.spoolPath),
      stem: input.stem ?? "",
      title: input.title,
      bytes: input.bytes,
      durationSec: input.durationSec,
      confirmed: false,
      ...(input.spoolIncomplete ? { spoolIncomplete: true } : {}),
      ...(input.validated ? { validated: true } : {}),
      ...(input.needsValidation ? { needsValidation: true } : {}),
      ...(input.sealed !== undefined ? { sealed: input.sealed } : {}),
    };
    this.state = {
      ...this.state,
      parts: existing ? this.state.parts.map(p => p.index === input.index ? part : p) : [...this.state.parts, part],
    };
    try {
      this.persist();
    }
    catch (e) {
      return { ok: false, error: `cannot persist unconfirmed part: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    return { ok: true };
  }
  markSpoolIncomplete(index: number): void {
    if (this.stateUntrusted)
      return;
    const row = this.state.parts.find(p => p.index === index);
    if (!row || row.confirmed || row.spoolIncomplete)
      return;
    this.state = { ...this.state, parts: this.state.parts.map(p => p.index === index ? { ...p, spoolIncomplete: true } : p) };
    try {
      this.persist();
    }
    catch {
    }
  }
  markValidated(index: number): {
    ok: boolean;
    error?: string;
  } {
    if (this.stateUntrusted)
      return { ok: false, error: "state sidecar is untrusted" };
    const row = this.state.parts.find(p => p.index === index);
    if (!row)
      return { ok: false, error: `cannot mark part validated: no WAL row for index ${index}` };
    if (row.confirmed || row.validated)
      return { ok: true };
    this.state = { ...this.state, parts: this.state.parts.map(p => p.index === index ? { ...p, validated: true, needsValidation: undefined } : p) };
    try {
      this.persist();
    }
    catch (e) {
      return { ok: false, error: `cannot mark part validated: ${String((e as Error)?.message ?? e).slice(0, 200)}` };
    }
    return { ok: true };
  }
  dropUnrecoverableUnsealed(): number[] {
    if (this.stateUntrusted)
      return [];
    const doomed: number[] = [];
    for (const p of this.state.parts) {
      if (p.sealed !== false || p.confirmed || p.spoolIncomplete)
        continue;
      let bytes = -1;
      try {
        bytes = statSync(p.spoolPath).size;
      }
      catch {
      }
      if (bytes > 0)
        continue;
      doomed.push(p.index);
    }
    if (doomed.length === 0)
      return [];
    const set = new Set(doomed);
    this.state = { ...this.state, parts: this.state.parts.filter(p => !set.has(p.index)) };
    try {
      this.persist();
    }
    catch {
    }
    return doomed;
  }
  persist(opts?: {
    seasonOnly?: boolean;
  }): void {
    try {
      writeLivePumpState(this.statePath, this.state);
    }
    catch (e) {
      if (!opts?.seasonOnly)
        this.stateUntrusted = true;
      throw e;
    }
  }
  noteActivity(now = Date.now()): void {
    if (now - this.lastActivityMarkMs < 60000)
      return;
    this.lastActivityMarkMs = now;
    markActivity(this.statePath, now);
  }
  markDeliveryDeferred(): void {
    if (this.state.deliveryDeferred)
      return;
    this.state = { ...this.state, deliveryDeferred: true };
    try {
      this.persist();
    }
    catch (e) {
      this.log(`[直播直传] ⚠️ 无法持久化落盘续录意图(下次切换时重试): ${String((e as Error)?.message ?? e)}`);
    }
  }
  adoptQueueManaged(): void {
    if (this.stateUntrusted || this.state.queueManaged)
      return;
    const onDisk = readLivePumpState(this.statePath);
    if (!onDisk?.queueManaged || onDisk.createdAt !== this.state.createdAt)
      return;
    this.state = { ...this.state, queueManaged: true };
  }
  reconcileConfirmedJournal(): {
    changed: boolean;
    unconfirmedRemain: boolean;
  } {
    if (requiresLivePumpProof(this.state))
      return { changed: false, unconfirmedRemain: this.hasUnconfirmed };
    const journal = readConfirmedJournal(this.statePath, this.state.createdAt);
    let changed = false;
    let bvid = this.state.bvid;
    const parts = this.state.parts.map(p => {
      if (p.confirmed)
        return p;
      const j = journal.get(p.index);
      if (!j)
        return p;
      changed = true;
      if (!bvid && j.bv)
        bvid = j.bv;
      return { ...p, confirmed: true };
    });
    const pending = this.state.pending && journal.has(this.state.pending.partIndex) ? undefined : this.state.pending;
    const unconfirmedRemain = parts.some(p => !p.confirmed) || !!pending;
    const settled = !unconfirmedRemain;
    const markerChanged = settled && (!!this.state.queueManaged || !!this.state.deliveryDeferred);
    if (!changed && !markerChanged && pending === this.state.pending)
      return { changed: false, unconfirmedRemain };
    this.state = {
      ...this.state,
      ...(bvid ? { bvid } : {}),
      parts,
      ...(pending ? { pending } : { pending: undefined }),
      ...(markerChanged ? { queueManaged: undefined, deliveryDeferred: undefined } : {}),
    };
    try {
      this.persist();
    }
    catch (e) {
      this.log(`[直播直传] ⚠️ 无法持久化确认日志收编结果(下次启动重试): ${String((e as Error)?.message ?? e)}`);
    }
    return { changed: true, unconfirmedRemain };
  }
}
