/**
 * live-pump-submitter.ts - builds the PartSubmitter the zero-disk pump uses (plans/049 stage 2b-2c).
 *
 * The runner already uploaded the bytes while the part was recording, so the submitter only
 * publishes metadata through the driver. Everything the driver needs is assembled here: the UPOS
 * target, a checkpoint store backed by the pump's own state file, and one bound credential.
 *
 * Off by default: DREC_LIVE_PUMP_DRIVER must be 1. A half-wired upload path is worse than the
 * legacy one, and this flip changes what happens when the archive id is unreadable.
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
  env?: (key: string) => string | undefined;
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
    if (!state || !state.bvid || state.bvid !== archiveId) return null;
    const parts: UploadPartRecord[] = state.parts
      .filter((p) => p.confirmed)
      .map((p) => ({ index: p.index + 1, size: p.bytes ?? 0, mtimeMs: 0, ...(p.title ? { title: p.title } : {}) }));
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
 * Returns null when the flag is off, so the caller keeps the legacy in-process path untouched.
 */
export function buildLivePumpSubmitter(o: LivePumpSubmitterOpts): PartSubmitter | null {
  const env = o.env ?? ((key: string) => process.env[key]);
  if (env("DREC_LIVE_PUMP_DRIVER") !== "1") return null;
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
      return { ref, reused: out.reused };
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
      return { confirmed: out.confirmed };
    },
    verify: async (req) => {
      const out = await driver.verify({ cred, ref: req.ref, expectedParts: req.expectedParts });
      return { ok: out.ok, observedParts: out.observedParts };
    },
  };
}
