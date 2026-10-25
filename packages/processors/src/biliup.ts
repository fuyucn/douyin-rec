/**
 * biliup processor (plan 038 T08/T15): create the first part, then append each later part.
 * A transfer with no tcp progress for stallMs is stopped and retried with proof; submit is never killed.
 */
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import {
  addArchiveToSeason, APPEND_AMBIGUOUS_MARKER, BILIUP_QUEUE_CAPABILITY, BILIUP_SLOT_CAPABILITY, describeSeasonOutcome, isSlotBusy, SLOT_BUSY_MARKER, normalizeSeasonSectionId, UncertainOutcome, formatPartTitle, linkOrCopy, partTitleToFilename, probeChild,
  type ProcessContext, type ProcessJob, type ProcessResult, type Processor, type TitleContext, type UploadProgress, type UploadSlot,
} from "@drec/core";
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
  /** Part title template + render context (same as the blocking path); parts are uploaded under that name. */
  partTitleTemplate?: string;
  titleCtx?: TitleContext;
  /** Optional Bilibili season section id; added after the P1 create succeeds. */
  seasonSectionId?: number;
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
    partTitleTemplate: typeof p.partTitleTemplate === "string" && p.partTitleTemplate.trim() ? p.partTitleTemplate : undefined,
    titleCtx: typeof p.titleCtx === "object" && p.titleCtx !== null ? p.titleCtx : undefined,
    seasonSectionId: normalizeSeasonSectionId(p.seasonSectionId),
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
  /** Minimum gap between progress writes (default 30s); progress is display-only. */
  progressEveryMs?: number;
  /** File size lookup for progress totals (tests inject). */
  sizeOf?: (path: string) => number;
  /** Node-wide upload slot (plan 038 PR4): one biliup per node, shared with rolling upload. */
  slot?: UploadSlot;
  /** How long to wait for a free slot before failing the job (default 6h). */
  slotWaitMs?: number;
  /** Account rate-limit gate (601/21566 cooldown + window), opened per run; injected by the CLI. */
  gate?: () => { run<T>(key: string, fn: () => Promise<T>): Promise<T> };
  accountKey?: (cookiesPath: string) => string;
  /** The node's own biliup cookies path when present; the master-sent path is only a fallback. */
  localCookies?: () => string | null;
}

const ALIAS_DIR = ".upload";

/** biliup is always run with the node's own cookies when it has them (the master path rarely exists here). */
const cookiesOf = (p: BiliupParams, deps: BiliupDeps): string => deps.localCookies?.() ?? p.cookies;

/**
 * biliup names a part after its file stem, so each part is hard-linked under its rendered part title
 * (same rule as the blocking node pipeline: 1-based index, `-P{idx}` on collisions, original name on failure).
 */
export function aliasPartFiles(files: readonly string[], template?: string, ctx?: TitleContext): string[] {
  if (!template || !ctx) return [...files];
  const used = new Set<string>();
  return files.map((f, i) => {
    let base: string | null = null;
    try {
      base = partTitleToFilename(formatPartTitle(template, { ...ctx, partIndex: i + 1, partTotal: files.length }, "plain"));
    } catch { /* unrenderable title: keep the original name rather than fail the upload */ }
    if (!base) return f;
    let stem = base;
    for (let n = 0; used.has(stem); n++) stem = `${base}-P${i + 1}${n > 0 ? `-${n}` : ""}`;
    used.add(stem);
    const dst = join(dirname(f), ALIAS_DIR, `${stem}${extname(f)}`);
    try {
      mkdirSync(dirname(dst), { recursive: true });
      rmSync(dst, { force: true });
      linkOrCopy(f, dst);
      return dst;
    } catch {
      return f;
    }
  });
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
  /** The next run uploads one part: bytes already uploaded by earlier parts, this part's size, job total. */
  setPart: (baseBytes: number, partBytes: number, totalBytes: number) => void;
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
  const now = deps.now ?? Date.now;
  const part = { base: 0, size: 0, total: 0 };
  let lastWrite: UploadProgress | null = null;
  const slot = deps.slot;
  // Progress = finished parts + this child's acked bytes, capped at the part size (acked includes HTTP overhead).
  const report = (force: boolean): void => {
    if (part.total <= 0) return;
    const t = now();
    if (!force && lastWrite && t - lastWrite.at < (deps.progressEveryMs ?? 30_000)) return;
    const doneBytes = Math.min(part.total, part.base + Math.min(part.size, watch.ackedSinceChild));
    const dt = lastWrite ? t - lastWrite.at : 0;
    const bps = lastWrite && dt > 0 && doneBytes >= lastWrite.doneBytes ? Math.round(((doneBytes - lastWrite.doneBytes) * 1000) / dt) : null;
    lastWrite = { doneBytes, totalBytes: part.total, bps, at: t };
    // Runs inside a timer / child output handler: a throw here would be uncaught, and progress is display-only.
    try { ctx.setState?.({ progress: lastWrite }); } catch (e) { ctx.log(`progress not saved: ${(e as Error)?.message ?? e}`); }
    slot?.touch();
  };
  const timer = setInterval(() => {
    const c = child;
    if (!c || c.exited) return;
    const v = watch.observe((deps.readAcked ?? readTcpAcked)(c.pid));
    if (watch.currentStep === "transfer") report(false);
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
  const setStep = (step: string): void => {
    watch.setStep(step);
    ctx.setState?.({ step });
    // Every byte of this part is acked once biliup reports all files uploaded.
    if (step === "submit") { part.base += part.size; part.size = 0; report(true); }
  };
  const setPart = (base: number, size: number, total: number): void => { part.base = base; part.size = size; part.total = total; };
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
  return { run, setStep, setPart, abandoned, wallHit: () => wall, stop: () => clearInterval(timer) };
}

/** Mutable progress of one run, read by the stall handler. */
interface RunState { bv?: string }

async function uploadAll(job: ProcessJob, ctx: ProcessContext, deps: BiliupDeps, sup: Supervisor, st: RunState): Promise<ProcessResult> {
  const p = params(job);
  const files = aliasPartFiles(job.inputs, p.partTitleTemplate, p.titleCtx);
  const cookies = cookiesOf(p, deps);
  const meta = {
    cookies,
    title: p.title,
    tid: p.tid,
    tag: p.tag,
    ...(p.desc ? { desc: p.desc } : {}),
    ...(p.seasonSectionId ? { seasonSectionId: p.seasonSectionId } : {}),
    onNote: (m: string) => ctx.log(m),
    public: p.public === true,
  };
  const gate = deps.gate?.();
  const key = deps.accountKey?.(cookies) ?? "";
  // Every create/append takes a fresh quota slot, like the blocking path; gate_wait is never a stall.
  const gated = <T>(fn: () => Promise<T>): Promise<T> => (gate ? gate.run(key, fn) : fn());
  // One biliup per node: the slot is taken per part (create or one append) and released right after it.
  const slotted = async <T>(fn: () => Promise<T>): Promise<T> => {
    const slot = deps.slot;
    if (!slot) return gated(fn);
    sup.setStep("gate_wait");
    if (!(await slot.acquire("queue", deps.slotWaitMs ?? 6 * 3600_000))) throw new Error(`${SLOT_BUSY_MARKER} within the wait limit; nothing was uploaded`);
    try { return await gated(fn); } finally { slot.release(); }
  };
  const sizes = files.map((f) => { try { return (deps.sizeOf ?? ((x: string) => statSync(x).size))(f); } catch { return 0; } });
  const total = sizes.reduce((a, b) => a + b, 0);
  const partAt = (i: number): void => sup.setPart(sizes.slice(0, i).reduce((a, b) => a + b, 0), sizes[i] ?? 0, total);
  st.bv = p.bv;
  let createdNow = false;
  if (!st.bv) {
    sup.setStep("gate_wait");
    // Fail-closed before creating anything: without duration we cannot prove "no draft".
    const expected = expectedDuration(job, deps);
    if (expected <= 0) throw new Error("missing expected duration for this output; cannot prove no draft exists, refusing to create one");
    const proof = await findRecentArchive(cookies, p.title, expected, deps.lookup);
    if (proof === "yes") throw new Error("an archive with the same title and duration already exists; refusing to create a duplicate");
    if (proof === "unknown") throw new Error("cannot confirm whether a draft exists; needs manual verification");
    partAt(0);
    st.bv = await slotted(() => uploadPlain({ plain: { ...meta, video: files[0]! }, run: sup.run }));
    createdNow = true;
    ctx.setState?.({ bv: st.bv });
  }
  const bv = st.bv;
  // A resumed row reuses the draft created by an earlier attempt, so the create hook never runs
  // again. Reconcile the season once per processed row; the add is idempotent.
  if (!createdNow && p.seasonSectionId) {
    const outcome = await addArchiveToSeason({ cookiesPath: cookies, sectionId: p.seasonSectionId, bvid: bv });
    ctx.log(describeSeasonOutcome(outcome));
  }
  const countParts = countPartsOf(deps);
  // params.bv: the draft exists and every input is a part still to append.
  // Row bv only (a resumed attempt of this job): inputs[0] is P1 and some later parts may already be on
  // the archive, so appending from index 0 or 1 could duplicate a part. Resume only from a confirmed count.
  let appendFrom = p.bv ? 0 : 1;
  if (persistedBv(job) && !(job.params as { bv?: unknown }).bv) {
    const onServer = countParts ? await countParts(bv, cookies).catch(() => null) : null;
    if (onServer == null || onServer < 1 || onServer > files.length) {
      throw new Error(`${APPEND_AMBIGUOUS_MARKER} resumed upload of ${bv} cannot confirm how many parts are already on the archive (count=${onServer ?? "unknown"}); needs manual verification`);
    }
    appendFrom = onServer;
  }
  for (let i = appendFrom; i < files.length; i++) {
    sup.setStep("gate_wait");
    partAt(i);
    try {
      await slotted(() => appendGroup({ ...meta, bv, files: [files[i]!], run: sup.run, ...(countParts ? { countParts: () => countParts(bv, cookies) } : {}) }));
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (msg.includes(APPEND_AMBIGUOUS_MARKER)) throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${msg}`);
      throw e;
    }
  }
  return { outputs: [], bv, note: `${basename(job.inputs[0] ?? "")} +${Math.max(0, files.length - 1)} parts` };
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
    const proof = await findRecentArchive(cookiesOf(p, deps), p.title, expectedDuration(job, deps), deps.lookup);
    if (proof !== "no") throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${e.message}; cannot prove no draft was created (${proof})`);
  } else {
    if (p.bv) throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${e.message}; appends onto a pre-existing draft cannot be resumed safely`);
    const countParts = countPartsOf(deps);
    const n = countParts ? await countParts(st.bv, cookiesOf(p, deps)).catch(() => null) : null;
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
    capabilities: [BILIUP_QUEUE_CAPABILITY, BILIUP_SLOT_CAPABILITY],
    validate(job: ProcessJob): string | null {
      const p = params(job);
      if (!cookiesOf(p, deps)) return "missing cookies path";
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
        // A busy slot is not an outcome: nothing was created. Wait, then let the runner try again.
        if (isSlotBusy(e)) return { outputs: [], retry: { reason: "slot-busy", notBefore: Date.now() + RETRY_BACKOFF_MS } };
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
      const proof = await findRecentArchive(cookiesOf(p, deps), p.title, expected, deps.lookup);
      return proof === "no" ? "safe" : "uncertain";
    },
    async recover(): Promise<"uncertain"> { return "uncertain"; },
  };
}

export const biliupProcessor: Processor = makeBiliupProcessor();
