/**
 * live-pump-submitter.ts - builds the PartSubmitter the zero-disk pump uses (plans/049 stage 2b-2c).
 *
 * The runner already uploaded the bytes while the part was recording, so the submitter only
 * publishes metadata through the driver. Everything the driver needs is assembled here: the UPOS
 * target, a checkpoint store backed by the pump's own state file, and one bound credential.
 */
import { createUposTarget, UPOS_TARGET_ID } from "@drec/bilibili-upload";
import type { ArchiveRef, PartSubmitter, UploadTarget } from "@drec/core";
import type { UploadCheckpoint, UploadPartRecord, UploadStateStore } from "@drec/upload-runtime";
import { createUploadDriver } from "@drec/upload-runtime";
import { livePumpStatePath, readLivePumpState } from "@drec/zero-upload";

export interface LivePumpSubmitterOpts {
  cookiesPath: string;
  spoolDir: string;
  pumpRoom: string;
  /**
   * Shared per-account submission accounting (issue #331). The legacy in-process path records
   * every attempt in the same window/cooling state the node's queued uploads wait on; the driver
   * path must keep that parity or a direct upload silently under-counts the account quota.
   */
  submitGate?: { noteSubmit(): void; noteRateLimited(): void };
  /** Test seam: a fake UPOS target, so the wiring below is exercised without the wire. */
  target?: UploadTarget;
  /** Test seam: cooldown waits must not be real sleeps in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: (msg: string) => void;
}

/** Checkpoint view of the pump's state file: recovery already knows which parts are confirmed. */
function stateFileStore(o: LivePumpSubmitterOpts): UploadStateStore {
  const cache = new Map<string, UploadCheckpoint>();
  const statePath = livePumpStatePath(o.spoolDir, o.pumpRoom);
  function seed(key: string): UploadCheckpoint | null {
    const cached = cache.get(key);
    if (cached) return cached;
    if (!key.includes(":")) return null;
    const archiveId = key.slice(key.indexOf(":") + 1);
    const state = readLivePumpState(statePath);
    if (!state || (state.bvid !== archiveId && String(state.aid ?? "") !== archiveId)) return null;
    const parts: UploadPartRecord[] = state.parts
      .filter((p) => p.nativeKey && (p.proof === "accepted" || (p.confirmed && p.proof === "observed")))
      .map((p) => ({
        index: p.index + 1,
        size: p.bytes ?? 0,
        mtimeMs: 0,
        proof: p.proof,
        nativeKey: p.nativeKey,
        ...(p.acceptedAt ? { acceptedAt: new Date(p.acceptedAt).toISOString() } : {}),
        ...(p.observedAt ? { confirmedAt: new Date(p.observedAt).toISOString() } : {}),
        ...(p.title ? { title: p.title } : {}),
      }));
    const cp: UploadCheckpoint = { targetId: UPOS_TARGET_ID, archiveId, parts };
    cache.set(key, cp);
    return cp;
  }
  return {
    load: seed,
    save: (key, checkpoint) => { cache.set(key, checkpoint); },
    confirmPart: (key, part) => {
      const cur = cache.get(key);
      cache.set(key, cur ? { ...cur, parts: [...cur.parts, part] } : { targetId: UPOS_TARGET_ID, archiveId: key.slice(key.indexOf(":") + 1), parts: [part] });
    },
    observePart: (key, nativeKey, observedAt) => {
      const current = seed(key);
      if (!current) return false;
      const part = current.parts.find((candidate) => candidate.nativeKey === nativeKey);
      if (!part) return false;
      if (part.proof === "observed") return true;
      if (part.proof !== "accepted") return false;
      cache.set(key, {
        ...current,
        parts: current.parts.map((candidate) => candidate.nativeKey === nativeKey
          ? { ...candidate, proof: "observed", confirmedAt: observedAt, acceptedAt: undefined }
          : candidate),
      });
      return true;
    },
  };
}

/**
 * Default cooldown wait. The timer must be cleared when the signal aborts: the driver settles the
 * moment the stop lands, and a live pump that has already reported its result must not stay alive
 * for the remaining minutes of a rate-limit wait (its supervisor kills the child by then).
 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    // Declared first so the abort path can clear it; the callback only runs after this frame.
    let timer: NodeJS.Timeout | undefined;
    const onAbort = (): void => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Builds the driver-backed submitter used by tasks that selected streamed upload.
 */
export function buildLivePumpSubmitter(o: LivePumpSubmitterOpts): PartSubmitter {
  const log = o.log ?? (() => {});
  const target = o.target ?? createUposTarget({ log });
  const cred: { targetId: string; locator: string } = { targetId: UPOS_TARGET_ID, locator: o.cookiesPath };
  const driver = createUploadDriver({
    target,
    store: stateFileStore(o),
    sleep: o.sleep ?? abortableSleep,
    now: () => Date.now(),
    log,
    // Same budget as the legacy path (rateLimitAttempts 5, 60s base, 300s cap). The driver
    // default of 3 attempts would hand a live part to a human one cooldown earlier than the
    // path it replaces, and a lost part cannot be recovered after the broadcast ends.
    retry: { attempts: 5, transientBaseMs: 1_000, rateLimitMs: 60_000, maxWaitMs: 300_000 },
    ...(o.submitGate ? { accounting: o.submitGate } : {}),
  });
  return {
    ensureStreamedArchive: async (req) => {
      const out = await driver.ensureStreamedArchive({
        cred,
        archive: req.archive,
        name: req.name,
        ...(req.title ? { title: req.title } : {}),
        ...(req.expectedDurationSec !== undefined ? { expectedDurationSec: req.expectedDurationSec } : {}),
        ...(req.skipFindRecent ? { skipFindRecent: true } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      const ref: ArchiveRef = out.ref;
      return { ref, reused: out.reused, ...(out.partProof ? { partProof: out.partProof } : {}) };
    },
    appendStreamedPart: async (req) => {
      const out = await driver.appendStreamedPart({
        cred,
        ref: req.ref,
        name: req.name,
        ...(req.title ? { title: req.title } : {}),
        ...(req.size !== undefined ? { size: req.size } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
      });
      return { confirmed: out.confirmed, accepted: out.accepted };
    },
    observeStreamedPart: (req) => {
      if (!driver.observeStreamedPart(req)) {
        throw new Error("accepted streamed part was not found by exact native key");
      }
    },
    verify: async (req) => {
      const out = await driver.verify({ cred, ref: req.ref, expectedParts: req.expectedParts });
      return { ok: out.ok, observedParts: out.observedParts };
    },
  };
}
