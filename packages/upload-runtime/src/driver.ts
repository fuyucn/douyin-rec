/**
 * driver.ts — the generic upload driver (plans/049 §4.1).
 *
 * The target owns the wire protocol; the driver owns what happens around it: dedupe before a
 * create, cooldowns for rate limits, bounded retries for transient failures, and the rule that an
 * ambiguous outcome stops everything and goes to a human.
 *
 * Three outcomes are deliberately never retried, because a retry creates duplicates that cannot
 * be undone on Bilibili:
 *   - create proof unknown   (the archive may already exist)
 *   - append proof unknown   (the part may already be on the archive)
 *   - any error the target classifies as ambiguous (the request may have reached the server)
 *
 * A retry that can sleep for an hour is a hang with extra steps, so every wait is capped.
 */
import type {
  ArchiveRef,
  CredentialRef,
  UploadErrorClass,
  UploadFile,
  UploadPolicy,
  UploadTarget,
} from "@drec/core";
import type { UploadCheckpoint, UploadPartRecord, UploadStateStore } from "./state-store.js";

export interface UploadRuntimeDeps {
  target: UploadTarget;
  store: UploadStateStore;
  /**
   * Test seam: cooldowns must not be real sleeps in tests.
   *
   * The signal is the wait's own cancellation: an implementation that owns a timer must clear it
   * when the signal aborts, or the process stays alive for the rest of the cooldown after the run
   * has already settled.
   */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  now(): number;
  log(msg: string): void;
  /**
  * Hard-stop signal. When aborted, no further attempt is made and the current bounded wait ends
  * immediately. A live part may be mid-cooldown when the operator stops the run; finishing the
  * wait and firing one more irreversible request afterwards is not a stop.
   */
  signal?: AbortSignal;
  /**
   * Account-level bookkeeping shared with every other upload on this machine (issue #331).
   *
   * The legacy in-process submit path records each attempt in the same per-account window rolling
   * and queued uploads on this node wait on, and cools that account when Bilibili answers with a
   * submission rate limit. The driver is the only layer that knows how many attempts a publish
   * really made, so the wiring lives here; both hooks are optional because a standalone driver
   * (tests, the queue path) has no shared window to feed.
   *
   * Neither hook may block or break a publish: the bytes are already on the target and recording
   * continues, so accounting is best effort and failures are swallowed.
   */
  accounting?: {
    /** Called before every attempt, right before the irreversible request goes out. */
    noteSubmit(): void;
    /** Called when the target reported a submission rate limit for this attempt. */
    noteRateLimited(): void;
  };
  /** Retry policy. Defaults keep a live broadcast from waiting forever on one rate limit. */
  retry?: {
    attempts?: number;
    transientBaseMs?: number;
    rateLimitMs?: number;
    maxWaitMs?: number;
  };
}

export interface EnsureArchiveRequest {
  cred: CredentialRef;
  title: string;
  files: UploadFile[];
  policy: UploadPolicy;
  expectedDurationSec?: number;
  /** Skip findRecent. Default false: dedupe before creating is the whole point. */
  skipFindRecent?: boolean;
  /** Hard-stop; see UploadRuntimeDeps.signal. */
  signal?: AbortSignal;
}

export interface EnsureArchiveOutcome {
  ref: ArchiveRef;
  /** true = findRecent matched an existing archive, nothing was created. */
  reused: boolean;
}

export interface AppendPartsRequest {
  cred: CredentialRef;
  ref: ArchiveRef;
  files: UploadFile[];
  policy: UploadPolicy;
  /** Hard-stop; see UploadRuntimeDeps.signal. */
  signal?: AbortSignal;
}

export interface AppendPartsOutcome {
  /** 1-based part numbers this call confirmed (proof = observed). */
  confirmed: number[];
}

export interface StreamedArchiveRequest {
  cred: CredentialRef;
  /** Archive metadata for the create request; ignored when an archive is reused. */
  archive: { title: string; tid?: number; tags?: string[]; desc?: string; policy?: UploadPolicy };
  /** File name the transport already produced for the part bytes. */
  name: string;
  title?: string;
  expectedDurationSec?: number;
  skipFindRecent?: boolean;
  /** Hard-stop; see UploadRuntimeDeps.signal. */
  signal?: AbortSignal;
}

export interface StreamedPartRequest {
  cred: CredentialRef;
  ref: ArchiveRef;
  name: string;
  title?: string;
  /** Size of the part the transport already uploaded; 0 = unknown. */
  size?: number;
  /** Hard-stop; see UploadRuntimeDeps.signal. */
  signal?: AbortSignal;
}

export interface VerifyRequest {
  cred: CredentialRef;
  ref: ArchiveRef;
  /** Expected part count; null = we have no number to compare against (existence check only). */
  expectedParts: number | null;
}

export interface VerifyOutcome {
  ok: boolean;
  observedParts: number | null;
}

/** Why the driver stopped. Callers map "needs-manual" onto the queue's needs_manual state. */
export type UploadDriverFailure = "needs-manual" | "retry-exhausted" | "fatal";

export class UploadDriverError extends Error {
  constructor(readonly failure: UploadDriverFailure, message: string) {
    super(message);
    this.name = "UploadDriverError";
  }
}

export interface UploadDriver {
  ensureArchive(req: EnsureArchiveRequest): Promise<EnsureArchiveOutcome>;
  appendParts(req: AppendPartsRequest): Promise<AppendPartsOutcome>;
  verify(req: VerifyRequest): Promise<VerifyOutcome>;
  /** Create or reuse an archive for bytes a streaming runner already uploaded. */
  ensureStreamedArchive(req: StreamedArchiveRequest): Promise<EnsureArchiveOutcome>;
  /** Publish one already-uploaded part; the returned number is the one this call proved. */
  appendStreamedPart(req: StreamedPartRequest): Promise<AppendPartsOutcome>;
}

const DEFAULTS = {
  attempts: 3,
  transientBaseMs: 1_000,
  rateLimitMs: 60_000,
  maxWaitMs: 300_000,
} as const;

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

function checkpointKey(targetId: string, archiveId: string): string {
  return targetId + ":" + archiveId;
}

/**
 * One signal that aborts when any input does. `detach` must be called when the wait ends, or
 * every retry would leave listeners on the run's signal.
 */
function combineSignals(signals: AbortSignal[]): { signal: AbortSignal; detach(): void } | null {
  if (signals.length === 0) return null;
  if (signals.length === 1) return { signal: signals[0]!, detach: () => {} };
  const ac = new AbortController();
  const onAbort = (): void => ac.abort();
  for (const s of signals) {
    if (s.aborted) {
      ac.abort();
      break;
    }
    s.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: ac.signal,
    detach: () => { for (const s of signals) s.removeEventListener("abort", onAbort); },
  };
}

/**
 * Wait `ms`, but settle the moment `signal` aborts even if the injected sleep ignores the signal
 * (a fake in tests, or an old implementation). The timer itself is owned by `sleep`; production
 * callers clear it on abort so a pending cooldown cannot hold the process open.
 */
async function sleepUnlessAborted(
  sleep: UploadRuntimeDeps["sleep"],
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!signal) {
    await sleep(ms);
    return;
  }
  if (signal.aborted) return;
  let slept: Promise<void>;
  try {
    slept = Promise.resolve(sleep(ms, signal));
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", done);
      resolve();
    };
    signal.addEventListener("abort", done, { once: true });
    // A sleep that throws must not turn a cooldown into a failed publish: end the wait and let
    // the next loop decide (the attempt checks will stop it if the run was aborted).
    void slept.then(done, done);
    // The abort may have landed while `sleep` was being called (before this listener existed).
    if (signal.aborted) done();
  });
}

export function createUploadDriver(deps: UploadRuntimeDeps): UploadDriver {
  const { target, store, sleep, now, log } = deps;
  const attempts = Math.max(1, deps.retry?.attempts ?? DEFAULTS.attempts);
  const transientBaseMs = deps.retry?.transientBaseMs ?? DEFAULTS.transientBaseMs;
  const rateLimitMs = deps.retry?.rateLimitMs ?? DEFAULTS.rateLimitMs;
  const maxWaitMs = deps.retry?.maxWaitMs ?? DEFAULTS.maxWaitMs;

  /** Accounting must never be the reason a live part stops being published. */
  function noteSubmit(): void {
    try {
      deps.accounting?.noteSubmit();
    } catch {
      /* accounting is observability: never block a submit */
    }
  }

  function noteRateLimited(): void {
    try {
      deps.accounting?.noteRateLimited();
    } catch {
      /* accounting is observability: never block a submit */
    }
  }

  /**
   * Bounded wait that a hard-stop can end immediately.
   *
   * The legacy in-process path sleeps through `sleepUnlessAborted`: a stop during a 300s cooldown
   * must not keep the pump alive for the rest of it (its finalize budget is seconds, not minutes).
   * Both signals are honoured: the run's stop and the per-call one (a runner that stops only its
   * own part).
   */
  async function pause(attempt: number, cls: UploadErrorClass, reqSignal?: AbortSignal): Promise<void> {
    // A target-reported hint wins; otherwise the wait grows per attempt (60s, 120s, 240s, capped
    // at maxWaitMs) exactly like the legacy in-process path. A flat 60s per attempt is shorter
    // than the cooldown Bilibili is still holding, so every retry lands inside the window.
    const want =
      cls.kind === "rate-limited"
        ? cls.retryAfterMs ?? rateLimitMs * 2 ** attempt
        : transientBaseMs * 2 ** attempt;
    const ms = Math.min(Math.max(1, want), maxWaitMs);
    log("[upload-driver] waiting " + Math.round(ms / 1000) + "s before retry (" + cls.kind + ")");
    const signals = [deps.signal, reqSignal].filter((s): s is AbortSignal => !!s);
    const combined = combineSignals(signals);
    try {
      await sleepUnlessAborted(sleep, ms, combined?.signal);
    } finally {
      combined?.detach();
    }
  }

  /** A hard-stop must not be followed by another irreversible request. Per-call signal wins over
   * the driver-wide one, so a runner that owns its own abort can stop only its own part. */
  function stopped(reqSignal?: AbortSignal): boolean {
    return reqSignal?.aborted === true || deps.signal?.aborted === true;
  }

  function assertNotStopped(what: string, reqSignal?: AbortSignal): void {
    if (stopped(reqSignal)) throw new UploadDriverError("fatal", what + ": 已收到停止信号，不再提交");
  }

  function classify(err: unknown): UploadErrorClass {
    try {
      return target.classifyError(err);
    } catch {
      // A target that cannot classify must not crash the driver; treat as permanent (no retry).
      return { kind: "permanent", reason: messageOf(err) };
    }
  }

  /** Map the two non-retryable classes to a stop; retryable classes return null. */
  function stopFor(cls: UploadErrorClass, what: string): UploadDriverError | null {
    if (cls.kind === "ambiguous") return new UploadDriverError("needs-manual", what + ": " + cls.reason);
    if (cls.kind === "permanent") return new UploadDriverError("fatal", what + ": " + cls.reason);
    return null;
  }

  /**
   * Classify one failed attempt and apply the shared-account discount before deciding what to do.
   *
   * A rate limit is recorded even when the attempt budget is exhausted: the account is cooling
   * either way, and the next upload on this node must see that.
   */
  function classifyAttempt(err: unknown): UploadErrorClass {
    const cls = classify(err);
    if (cls.kind === "rate-limited") noteRateLimited();
    return cls;
  }

  /** Record each appended file once. Indexes continue from the stored checkpoint. */
  function confirm(req: AppendPartsRequest, key: string): number[] {
    let existing: UploadCheckpoint | null = store.load(key);
    if (!existing) {
      // A checkpoint must exist for every archive we confirm into; otherwise part numbers restart.
      existing = { targetId: req.ref.targetId, archiveId: req.ref.id, parts: [] };
      store.save(key, existing);
    }
    const start = existing.parts.length + 1;
    const confirmedAt = new Date(now()).toISOString();
    const indexes: number[] = [];
    req.files.forEach((file, i) => {
      const index = start + i;
      const part: UploadPartRecord = {
        index,
        size: file.size ?? file.source?.size ?? 0,
        mtimeMs: file.mtimeMs ?? 0,
        ...(file.title ? { title: file.title } : {}),
        confirmedAt,
      };
      store.confirmPart(key, part);
      indexes.push(index);
    });
    return indexes;
  }

  return {
    async ensureArchive(req: EnsureArchiveRequest): Promise<EnsureArchiveOutcome> {
      if (!req.skipFindRecent) {
        const found = await target.findRecent({
          cred: req.cred,
          title: req.title,
          ...(req.expectedDurationSec !== undefined ? { expectedDurationSec: req.expectedDurationSec } : {}),
        });
        if (found === "unknown") {
          // Reading failed. Creating now is how a second archive gets born next to the first one.
          throw new UploadDriverError("needs-manual", "建稿前去重结果不确定（列表读取失败）");
        }
        if (found !== "none") {
          log("[upload-driver] reusing archive " + found.ref.id);
          store.save(checkpointKey(found.ref.targetId, found.ref.id), {
            targetId: found.ref.targetId,
            archiveId: found.ref.id,
            parts: [],
          });
          return { ref: found.ref, reused: true };
        }
      }

      for (let attempt = 0; attempt < attempts; attempt++) {
        assertNotStopped("建稿", req.signal);
        noteSubmit();
        try {
          const res = await target.create({
            cred: req.cred,
            title: req.title,
            files: req.files,
            policy: req.policy,
          });
          if (res.proof === "unknown" || !res.ref) {
            // The archive may exist without an id we can read: never retry, never build a second.
            throw new UploadDriverError("needs-manual", "建稿结果不确定（没有可读的稿件号）");
          }
          store.save(checkpointKey(res.ref.targetId, res.ref.id), {
            targetId: res.ref.targetId,
            archiveId: res.ref.id,
            parts: [],
          });
          return { ref: res.ref, reused: res.proof === "found-existing" };
        } catch (err) {
          if (err instanceof UploadDriverError) throw err;
          const cls = classifyAttempt(err);
          const stop = stopFor(cls, "建稿");
          if (stop) throw stop;
          if (attempt + 1 >= attempts) {
            throw new UploadDriverError("retry-exhausted", "建稿重试 " + attempts + " 次仍失败: " + messageOf(err));
          }
          await pause(attempt, cls, req.signal);
        }
      }
      throw new UploadDriverError("retry-exhausted", "建稿重试耗尽");
    },

    async appendParts(req: AppendPartsRequest): Promise<AppendPartsOutcome> {
      const key = checkpointKey(req.ref.targetId, req.ref.id);
      for (let attempt = 0; attempt < attempts; attempt++) {
        assertNotStopped("追加", req.signal);
        noteSubmit();
        try {
          const res = await target.append({
            cred: req.cred,
            ref: req.ref,
            files: req.files,
            policy: req.policy,
          });
          if (res.proof === "unknown") {
            throw new UploadDriverError("needs-manual", "追加结果不确定（分 P 可能已提交）");
          }
          if (res.proof === "confirmed-not-submitted") {
            // Safe to retry: the target proved the request never took effect.
            if (attempt + 1 >= attempts) {
              throw new UploadDriverError("retry-exhausted", "追加重试 " + attempts + " 次仍未提交");
            }
            await pause(attempt, { kind: "transient", reason: "confirmed-not-submitted" }, req.signal);
            continue;
          }
          const confirmed = confirm(req, key);
          return { confirmed };
        } catch (err) {
          if (err instanceof UploadDriverError) throw err;
          const cls = classifyAttempt(err);
          const stop = stopFor(cls, "追加");
          if (stop) throw stop;
          if (attempt + 1 >= attempts) {
            throw new UploadDriverError("retry-exhausted", "追加重试 " + attempts + " 次仍失败: " + messageOf(err));
          }
          await pause(attempt, cls, req.signal);
        }
      }
      throw new UploadDriverError("retry-exhausted", "追加重试耗尽");
    },

    async ensureStreamedArchive(req: StreamedArchiveRequest): Promise<EnsureArchiveOutcome> {
      const publish = target.publishStreamed?.bind(target);
      if (!publish || target.capabilities.streamPublish !== true) {
        throw new UploadDriverError("fatal", "目标不支持流式发布（publishStreamed 缺失）");
      }
      const archiveTitle = req.archive.title;
      if (!req.skipFindRecent) {
        const found = await target.findRecent({ cred: req.cred, title: archiveTitle });
        if (found === "unknown") {
          throw new UploadDriverError("needs-manual", "建稿前去重结果不确定（列表读取失败）");
        }
        if (found !== "none") {
          log("[upload-driver] reusing archive " + found.ref.id);
          const key = checkpointKey(found.ref.targetId, found.ref.id);
          store.save(key, { targetId: found.ref.targetId, archiveId: found.ref.id, parts: [] });
          return { ref: found.ref, reused: true };
        }
      }
      for (let attempt = 0; attempt < attempts; attempt++) {
        assertNotStopped("流式建稿", req.signal);
        noteSubmit();
        try {
          const res = await publish({
            cred: req.cred,
            ref: null,
            name: req.name,
            ...(req.title ? { title: req.title } : {}),
            archive: req.archive,
          });
          if (res.proof === "unknown" || !res.ref) {
            throw new UploadDriverError("needs-manual", "流式建稿结果不确定（没有可读的稿件号）");
          }
          const key = checkpointKey(res.ref.targetId, res.ref.id);
          // The create already published this part, so the checkpoint must start at P1. Saving
          // "parts: []" made the NEXT streamed part confirm itself as P1: the archive really had
          // two parts while the checkpoint (and every proof built on it) said one.
          store.save(key, {
            targetId: res.ref.targetId,
            archiveId: res.ref.id,
            parts: [{
              index: 1,
              size: 0,
              mtimeMs: 0,
              ...(req.title ? { title: req.title } : {}),
              confirmedAt: new Date(now()).toISOString(),
            }],
          });
          return { ref: res.ref, reused: false };
        } catch (err) {
          if (err instanceof UploadDriverError) throw err;
          const cls = classifyAttempt(err);
          const stop = stopFor(cls, "流式建稿");
          if (stop) throw stop;
          if (attempt + 1 >= attempts) {
            throw new UploadDriverError("retry-exhausted", "流式建稿重试 " + attempts + " 次仍失败: " + messageOf(err));
          }
          await pause(attempt, cls, req.signal);
        }
      }
      throw new UploadDriverError("retry-exhausted", "流式建稿重试耗尽");
    },

    async appendStreamedPart(req: StreamedPartRequest): Promise<AppendPartsOutcome> {
      const publish = target.publishStreamed?.bind(target);
      if (!publish || target.capabilities.streamPublish !== true) {
        throw new UploadDriverError("fatal", "目标不支持流式发布（publishStreamed 缺失）");
      }
      const key = checkpointKey(req.ref.targetId, req.ref.id);
      const policy: UploadPolicy = target.hardPolicy();
      for (let attempt = 0; attempt < attempts; attempt++) {
        assertNotStopped("流式追加", req.signal);
        noteSubmit();
        try {
          const res = await publish({
            cred: req.cred,
            ref: req.ref,
            name: req.name,
            ...(req.title ? { title: req.title } : {}),
          });
          if (res.proof === "unknown") {
            throw new UploadDriverError("needs-manual", "流式追加结果不确定（分 P 可能已提交）");
          }
          if (res.proof === "confirmed-not-submitted") {
            if (attempt + 1 >= attempts) {
              throw new UploadDriverError("retry-exhausted", "流式追加重试 " + attempts + " 次仍未提交");
            }
            await pause(attempt, { kind: "transient", reason: "confirmed-not-submitted" }, req.signal);
            continue;
          }
          const file: UploadFile = { path: req.name, size: req.size ?? 0, mtimeMs: 0, ...(req.title ? { title: req.title } : {}) };
          const confirmed = confirm({ cred: req.cred, ref: req.ref, files: [file], policy }, key);
          return { confirmed };
        } catch (err) {
          if (err instanceof UploadDriverError) throw err;
          const cls = classifyAttempt(err);
          const stop = stopFor(cls, "流式追加");
          if (stop) throw stop;
          if (attempt + 1 >= attempts) {
            throw new UploadDriverError("retry-exhausted", "流式追加重试 " + attempts + " 次仍失败: " + messageOf(err));
          }
          await pause(attempt, cls, req.signal);
        }
      }
      throw new UploadDriverError("retry-exhausted", "流式追加重试耗尽");
    },

    async verify(req: VerifyRequest): Promise<VerifyOutcome> {
      const info = await target.inspect({ ref: req.ref, cred: req.cred });
      if (!info) return { ok: false, observedParts: null };
      if (req.expectedParts === null) return { ok: true, observedParts: info.partCount };
      if (info.partCount === null) return { ok: false, observedParts: null };
      return { ok: info.partCount === req.expectedParts, observedParts: info.partCount };
    },
  };
}

