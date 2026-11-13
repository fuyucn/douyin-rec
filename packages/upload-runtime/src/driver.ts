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
          const cls = classify(err);
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
          const cls = classify(err);
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

    async verify(req: VerifyRequest): Promise<VerifyOutcome> {
      const info = await target.inspect({ ref: req.ref, cred: req.cred });
      if (!info) return { ok: false, observedParts: null };
      if (req.expectedParts === null) return { ok: true, observedParts: info.partCount };
      if (info.partCount === null) return { ok: false, observedParts: null };
      return { ok: info.partCount === req.expectedParts, observedParts: info.partCount };
    },
  };
}

