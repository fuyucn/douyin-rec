/**
 * biliup processor (plan 038 T08/T15): create the first part, then append each later part.
 * A transfer with no tcp progress for stallMs is stopped and retried with proof; submit is never killed.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { APPEND_AMBIGUOUS_MARKER, BILIUP_QUEUE_CAPABILITY, UncertainOutcome, probeChild, type ProcessContext, type ProcessJob, type ProcessResult, type Processor } from "@drec/core";
import { appendGroup, countVideoParts, isAllFilesUploadedLine, runBiliup, uploadPlain, type BiliupHooks } from "./run-biliup.js";
import { TransferWatch, readTcpAcked, watchConfigOf, type AckSample } from "./biliup-progress.js";
import { findRecentArchive, type ArchiveQuery } from "./archive-lookup.js";

export interface BiliupParams {
  cookies: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  public?: boolean;
  bv?: string;
}

/** BV persisted on the queue row by an earlier attempt of this same job (P1 created by us, inputs[0] is P1). */
function persistedBv(job: ProcessJob): string | undefined {
  const v = (job as { bv?: string | null }).bv;
  return typeof v === "string" && v ? v : undefined;
}

function params(job: ProcessJob): BiliupParams {
  const p = job.params as Partial<BiliupParams>;
  const persisted = persistedBv(job);
  return {
    cookies: String(p.cookies ?? ""),
    title: String(p.title ?? ""),
    tid: Number(p.tid ?? 0),
    tag: String(p.tag ?? ""),
    desc: typeof p.desc === "string" ? p.desc : undefined,
    public: p.public === true,
    bv: typeof persisted === "string" && persisted ? persisted : (typeof p.bv === "string" && p.bv ? p.bv : undefined),
  };
}

/** Default duration probe: ffprobe via biliup output is not available here, so callers inject it. */
export interface BiliupDeps {
  /** biliup runner; receives the observation hooks (tests call onSpawn/onLine themselves). */
  run?: (argv: string[], hooks?: BiliupHooks) => Promise<string>;
  lookup?: ArchiveQuery;
  /** Expected total duration of the parts, used for the no-draft proof. */
  expectedDurationSec?: number;
  probeDuration?: (file: string) => Promise<number>;
  /**
   * Parts currently on the archive (null = unknown). Defaults to the real lookup, except when `run` is
   * injected (tests), where it stays unset so nothing touches the network.
   */
  countParts?: (bv: string, cookies: string) => Promise<number | null>;
  // Watchdog seams (tests).
  now?: () => number;
  readAcked?: (pid: number) => AckSample;
  kill?: (pid: number, sig: NodeJS.Signals) => void;
  probe?: typeof probeChild;
  tickMs?: number;
  killGraceMs?: number;
}

/** Transfer retries are counted by claims (plan 038 §4.3): 1 claim + 2 retries. */
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 3600_000;

/** The watchdog killed a stalled child; the processor decides retry vs manual. */
class StallError extends Error {}

/** Expected duration comes from the job (master/prep), never silently defaulted to "safe". */
function expectedDuration(job: ProcessJob, deps: BiliupDeps): number {
  const fromJob = Number((job.params as { expectedDurationSec?: unknown }).expectedDurationSec ?? 0);
  return Number.isFinite(fromJob) && fromJob > 0 ? fromJob : (deps.expectedDurationSec ?? 0);
}

interface Supervisor {
  run: (argv: string[]) => Promise<string>;
  setStep: (step: string) => void;
  /** Rejects with UncertainOutcome once submit passes maxWallMs; never resolves. */
  abandoned: Promise<never>;
  wallHit: () => boolean;
  stop: () => void;
}

/** Wrap biliup runs with the transfer watchdog: stall kills the child, submit is never killed. */
function supervise(job: ProcessJob, ctx: ProcessContext, deps: BiliupDeps): Supervisor {
  const watch = new TransferWatch(watchConfigOf(job.params), deps.now ?? Date.now, (m) => ctx.alert(m));
  const kill = deps.kill ?? ((pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* already gone */ } });
  let child: { pid: number; stalled: boolean; exited: boolean } | null = null;
  let wall = false;
  let gaveUp = false;
  let giveUp: (e: Error) => void = () => {};
  const abandoned = new Promise<never>((_, reject) => { giveUp = reject; });
  abandoned.catch(() => {});
  const timer = setInterval(() => {
    const c = child;
    if (!c || c.exited) return;
    const v = watch.observe((deps.readAcked ?? readTcpAcked)(c.pid));
    if (v.kind === "wall") wall = true;
    // Past the wall, a submit (now or later in this job) makes the outcome unknown; it is never killed.
    if (wall && watch.currentStep === "submit" && !gaveUp) {
      gaveUp = true;
      giveUp(new UncertainOutcome(`biliup submit still running past maxWallMs (pid ${c.pid}); outcome unknown, slot held until it exits`));
    } else if (v.kind === "stall" && !c.stalled) {
      c.stalled = true;
      ctx.alert(`biliup transfer stalled: no tcp progress for ${Math.round(v.idleMs / 1000)}s; stopping pid ${c.pid}`);
      kill(c.pid, "SIGTERM");
      setTimeout(() => { if (!c.exited) kill(c.pid, "SIGKILL"); }, deps.killGraceMs ?? 10_000).unref?.();
    }
  }, deps.tickMs ?? 5_000);
  timer.unref?.();
  const setStep = (step: string): void => { watch.setStep(step); ctx.setState?.({ step }); };
  const exec = deps.run ?? runBiliup;
  const run = async (argv: string[]): Promise<string> => {
    // An abandoned run (job already uncertain) must never start another biliup child.
    if (gaveUp) throw new Error("biliup run abandoned after an uncertain submit; not starting another upload");
    const me = { pid: 0, stalled: false, exited: false };
    try {
      return await exec(argv, {
        onSpawn: (pid) => {
          if (pid == null) return;
          me.pid = pid;
          child = me;
          watch.childStarted();
          watch.setStep("transfer");
          ctx.setState?.({ step: "transfer", childPid: pid, childPidStartedAt: (deps.probe ?? probeChild)(pid)?.startedAt ?? null });
        },
        onLine: (line) => { if (isAllFilesUploadedLine(line)) setStep("submit"); },
      });
    } catch (e) {
      if (me.stalled) throw new StallError(`biliup stalled and was stopped (${String((e as Error)?.message ?? e).slice(0, 200)})`);
      throw e;
    } finally {
      me.exited = true;
    }
  };
  return { run, setStep, abandoned, wallHit: () => wall, stop: () => clearInterval(timer) };
}

/** Mutable progress of one run, read by the stall handler. */
interface RunState { bv?: string }

async function uploadAll(job: ProcessJob, ctx: ProcessContext, deps: BiliupDeps, sup: Supervisor, st: RunState): Promise<ProcessResult> {
  const p = params(job);
  const files = job.inputs;
  const meta = { cookies: p.cookies, title: p.title, tid: p.tid, tag: p.tag, ...(p.desc ? { desc: p.desc } : {}), public: p.public === true };
  st.bv = p.bv;
  if (!st.bv) {
    sup.setStep("gate_wait");
    // Fail-closed before creating anything: without duration we cannot prove "no draft".
    const expected = expectedDuration(job, deps);
    if (expected <= 0) throw new Error("missing expected duration for this output; cannot prove no draft exists, refusing to create one");
    const proof = await findRecentArchive(p.cookies, p.title, expected, deps.lookup);
    if (proof === "yes") throw new Error("an archive with the same title and duration already exists; refusing to create a duplicate");
    if (proof === "unknown") throw new Error("cannot confirm whether a draft exists; needs manual verification");
    st.bv = await uploadPlain({ plain: meta, run: sup.run });
    ctx.setState?.({ bv: st.bv });
  }
  const bv = st.bv;
  const countParts = countPartsOf(deps);
  // params.bv: the draft exists and every input is a part still to append.
  // Row bv only (a resumed attempt of this job): inputs[0] is P1 and some later parts may already be on
  // the archive, so appending from index 0 or 1 could duplicate a part. Resume only from a confirmed count.
  let appendFrom = p.bv ? 0 : 1;
  if (persistedBv(job) && !(job.params as { bv?: unknown }).bv) {
    const onServer = countParts ? await countParts(bv, p.cookies).catch(() => null) : null;
    if (onServer == null || onServer < 1 || onServer > files.length) {
      throw new Error(`${APPEND_AMBIGUOUS_MARKER} resumed upload of ${bv} cannot confirm how many parts are already on the archive (count=${onServer ?? "unknown"}); needs manual verification`);
    }
    appendFrom = onServer;
  }
  for (let i = appendFrom; i < files.length; i++) {
    sup.setStep("gate_wait");
    try {
      await appendGroup({ ...meta, bv, files: [files[i]!], run: sup.run, ...(countParts ? { countParts: () => countParts(bv, p.cookies) } : {}) });
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes(APPEND_AMBIGUOUS_MARKER)) throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${msg}`);
      throw e;
    }
  }
  return { outputs: [], bv, note: `${basename(files[0] ?? "")} +${Math.max(0, files.length - 1)} parts` };
}

const countPartsOf = (deps: BiliupDeps) => deps.countParts ?? (deps.run ? undefined : countVideoParts);

/**
 * After a stall kill: retry only with proof that resuming cannot duplicate anything (plan 038 §4.3).
 * Create: no archive with this title+duration. Append: a confirmed part count (the resume path continues
 * from it). Anything unconfirmed fails as ambiguous for manual handling.
 */
async function afterStall(job: ProcessJob, deps: BiliupDeps, sup: Supervisor, st: RunState, e: StallError): Promise<ProcessResult> {
  const p = params(job);
  const attempts = (job as { attempts?: number }).attempts ?? 1;
  if (sup.wallHit()) throw new Error(`${e.message}; past maxWallMs, not retrying`);
  if (attempts >= MAX_ATTEMPTS) throw new Error(`${e.message}; ${attempts} attempts used, not retrying`);
  if (!st.bv) {
    const proof = await findRecentArchive(p.cookies, p.title, expectedDuration(job, deps), deps.lookup);
    if (proof !== "no") throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${e.message}; cannot prove no draft was created (${proof})`);
  } else {
    if (p.bv) throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${e.message}; appends onto a pre-existing draft cannot be resumed safely`);
    const countParts = countPartsOf(deps);
    const n = countParts ? await countParts(st.bv, p.cookies).catch(() => null) : null;
    if (n == null || n < 1 || n > job.inputs.length) throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${e.message}; part count unknown (${n ?? "unknown"})`);
  }
  const backoff = Math.min(MAX_BACKOFF_MS, RETRY_BACKOFF_MS * 2 ** (attempts - 1));
  return { outputs: [], ...(st.bv ? { bv: st.bv } : {}), retry: { notBefore: (deps.now ?? Date.now)() + backoff, reason: "transfer-retry" } };
}

export function makeBiliupProcessor(deps: BiliupDeps = {}): Processor {
  return {
    kind: "biliup",
    resource: "upload",
    lane: "biliup",
    retryable: false,
    interruptible: false,
    // Advertised only now that stall death and submit alerts exist (plan 038 T15).
    capabilities: [BILIUP_QUEUE_CAPABILITY],
    validate(job: ProcessJob): string | null {
      const p = params(job);
      if (!p.cookies) return "missing cookies path";
      if (!p.title) return "missing archive title";
      if (!Number.isInteger(p.tid) || p.tid <= 0) return "invalid tid";
      if (!p.tag) return "missing tag";
      if (job.inputs.length === 0) return "inputs must not be empty";
      if (job.inputs.some((f) => !existsSync(f))) return "a part file does not exist";
      return null;
    },
    estimateDiskBytes(): number { return 0; },
    async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
      const sup = supervise(job, ctx, deps);
      const st: RunState = {};
      const work = uploadAll(job, ctx, deps, sup, st);
      work.catch(() => {}); // may be abandoned below; its later outcome must not become unhandled
      try {
        return await Promise.race([work, sup.abandoned]);
      } catch (e) {
        if (e instanceof StallError) return afterStall(job, deps, sup, st, e);
        throw e;
      } finally {
        sup.stop();
      }
    },
    async verifyStopped(job: ProcessJob): Promise<"safe" | "uncertain"> {
      const p = params(job);
      const expected = expectedDuration(job, deps);
      // Child liveness is checked by the runner (pid + startedAt); this hook only proves no draft.
      if (!p.title || expected <= 0) return "uncertain";
      const proof = await findRecentArchive(p.cookies, p.title, expected, deps.lookup);
      return proof === "no" ? "safe" : "uncertain";
    },
    async recover(): Promise<"uncertain"> { return "uncertain"; },
  };
}

export const biliupProcessor: Processor = makeBiliupProcessor();
