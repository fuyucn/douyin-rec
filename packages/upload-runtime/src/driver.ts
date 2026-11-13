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
  /** Test seam: cooldowns must not be real sleeps in tests. */
  sleep(ms: number): Promise<void>;
  now(): number;
  log(msg: string): void;
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
}

export interface StreamedPartRequest {
  cred: CredentialRef;
  ref: ArchiveRef;
  name: string;
  title?: string;
  /** Size of the part the transport already uploaded; 0 = unknown. */
  size?: number;
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

  /** Bounded wait. */
  async function pause(attempt: number, cls: UploadErrorClass): Promise<void> {
    const want =
      cls.kind === "rate-limited"
        ? cls.retryAfterMs ?? rateLimitMs
        : transientBaseMs * 2 ** attempt;
    const ms = Math.min(Math.max(1, want), maxWaitMs);
    log("[upload-driver] waiting " + Math.round(ms / 1000) + "s before retry (" + cls.kind + ")");
    await sleep(ms);
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
          await pause(attempt, cls);
        }
      }
      throw new UploadDriverError("retry-exhausted", "建稿重试耗尽");
    },

    async appendParts(req: AppendPartsRequest): Promise<AppendPartsOutcome> {
      const key = checkpointKey(req.ref.targetId, req.ref.id);
      for (let attempt = 0; attempt < attempts; attempt++) {
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
            await pause(attempt, { kind: "transient", reason: "confirmed-not-submitted" });
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
          await pause(attempt, cls);
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
          store.save(key, { targetId: res.ref.targetId, archiveId: res.ref.id, parts: [] });
          return { ref: res.ref, reused: false };
        } catch (err) {
          if (err instanceof UploadDriverError) throw err;
          const cls = classifyAttempt(err);
          const stop = stopFor(cls, "流式建稿");
          if (stop) throw stop;
          if (attempt + 1 >= attempts) {
            throw new UploadDriverError("retry-exhausted", "流式建稿重试 " + attempts + " 次仍失败: " + messageOf(err));
          }
          await pause(attempt, cls);
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
            await pause(attempt, { kind: "transient", reason: "confirmed-not-submitted" });
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
          await pause(attempt, cls);
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

