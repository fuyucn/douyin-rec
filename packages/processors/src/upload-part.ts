/**
 * processors/upload-part.ts — per-part chain upload (plan 046 §5.4 / §10 PR5 prelude).
 *
 * The ctx is the only pointer: one absolute video file + the in-queue fingerprint + an optional
 * inherited draft id. bv empty => create; bv present => append. No directory scan, no archive list
 * or part-count query (Bilibili data lags; the local success proof is the upload itself). All of the
 * stall/slot/gate/progress machinery is reused from biliup.ts via supervise(), not reimplemented.
 *
 * Success = explicit bv (create) or an unambiguous append ack, plus the in-queue fp still matching
 * and the child's acked bytes reaching the file size. Anything else throws; the runner records the
 * failure (rate limits re-enter pending through the generic classifier) and never chains cleanup.
 *
 * TODO(?): reconciliation entry point is intentionally not wired here. An interrupted submit still
 * becomes the existing UncertainOutcome -> uncertain path; PR3 wiring of startReconciliation lands
 * later, after the settle-window measurement. No trustNo and no automatic resend are enabled.
 */
import { existsSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import {
  APPEND_AMBIGUOUS_MARKER, PART_KINDS, PART_WORKFLOW_TEMPLATES, isAppendAmbiguous,
  isSlotBusy, SLOT_BUSY_MARKER, RETRY_BACKOFF_MS, isVideoFileName, assertJobInvariants,
  type PartCtx, type ProcessContext, type ProcessJob, type ProcessResult, type Processor,
} from "@drec/core";
import { appendGroup, isAllFilesUploadedLine, uploadPlain } from "./run-biliup.js";
import {
  afterStall, BiliupDeps, StallError, supervise, countPartsOf, params,
  type RunState, type Supervisor,
} from "./biliup.js";

/** Explicit workflow mode in job.params; missing/invalid = no chaining (fail-closed). */
export const PART_WORKFLOW_PARAM = "partWorkflow";

export interface UploadPartDeps extends BiliupDeps {
  /** File fingerprint seam (tests). Defaults to statSync size+mtimeMs. */
  stat?: (path: string) => { size: number; mtimeMs: number };
  now?: () => number;
}

function ctxOf(job: ProcessJob): PartCtx {
  const raw: unknown = job.params.ctx;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("upload-part requires params.ctx");
  const c = raw as Record<string, unknown>;
  if (c.v !== 1 || typeof c.orderKey !== "string" || !c.orderKey || !Number.isSafeInteger(c.index) || (c.index as number) < 1) {
    throw new Error("upload-part params.ctx 非法(v/orderKey/index)");
  }
  if (typeof c.file !== "string" || !c.file || !isAbsolute(c.file) || !isVideoFileName(c.file)) {
    throw new Error("upload-part params.ctx.file 须为绝对视频路径(xml/ass/边车禁止)");
  }
  const fp: unknown = c.fp;
  if (typeof fp !== "object" || fp === null || Array.isArray(fp)) throw new Error("upload-part params.ctx.fp 须为对象");
  const f = fp as Record<string, unknown>;
  for (const key of ["size", "mtimeMs"] as const) {
    if (typeof f[key] !== "number" || !Number.isFinite(f[key]) || (f[key] as number) < 0) {
      throw new Error("upload-part params.ctx.fp." + key + " 须为有限的非负数");
    }
  }
  if (c.bv !== undefined && (typeof c.bv !== "string" || !c.bv)) throw new Error("upload-part params.ctx.bv 须为非空字符串");
  return c as unknown as PartCtx;
}

function workflowMode(job: ProcessJob): keyof typeof PART_WORKFLOW_TEMPLATES | null {
  const v: unknown = job.params[PART_WORKFLOW_PARAM];
  return v === "live-pump" || v === "rolling" || v === "whole-order" ? v : null;
}

/** True iff the single-part confirmation must chain its cleanup in the SAME transaction. */
export function shouldChainCleanup(job: ProcessJob): boolean {
  const mode = workflowMode(job);
  return mode !== null && PART_WORKFLOW_TEMPLATES[mode].cleanupAt === "part-confirmed";
}

/** Shared "one biliup run for this one part" driver; existing biliup processor keeps its own multi-part loop. */
export async function runOneBiliupPart(
  job: ProcessJob, c: ProcessContext, deps: UploadPartDeps, sup: Supervisor,
): Promise<ProcessResult> {
  const ctx = ctxOf(job);
  const p = params(job);
  const cookies = p.cookies;
  const file = ctx.file;
  if (!existsSync(file)) throw new Error("upload-part source missing: " + basename(file));
  const st: RunState = { bv: ctx.bv };
  const meta = {
    cookies, title: p.title, tid: p.tid, tag: p.tag, public: p.public === true,
    ...(p.desc ? { desc: p.desc } : {}),
  };
  const gate = deps.gate?.();
  const key = deps.accountKey?.(cookies) ?? "";
  const slotted = async <T>(fn: () => Promise<T>): Promise<T> => {
    const slot = deps.slot;
    if (!slot) return gate ? gate.run(key, fn) : fn();
    sup.setStep("gate_wait");
    if (!(await slot.acquire("queue", deps.slotWaitMs ?? 6 * 3600_000))) {
      throw new Error(SLOT_BUSY_MARKER + " within the wait limit; nothing was uploaded");
    }
    try { return gate ? await gate.run(key, fn) : await fn(); } finally { slot.release(); }
  };
  const size = (deps.sizeOf ?? ((x: string) => statSync(x).size))(file);
  sup.setPart(0, size, size);
  const plain = { ...meta, video: file, public: meta.public };
  let ackSeen = false;
  // All-files-uploaded is biliup's explicit transfer-complete boundary. Feed the final tcp-acked
  // sample then require acked bytes >= file size (plan 046 §5.4(b)); missing evidence never passes.
  const runWithAck = async (argv: string[]): Promise<string> => sup.run(argv).then((out) => {
    if (isAllFilesUploadedLine(out)) {
      ackSeen = true;
      sup.observeAcked((deps.readAcked ?? (() => new Map<string, number>()))(0));
    }
    return out;
  });
  if (!st.bv) {
    // No archive query: per-part create is guarded by the explicit bv below, never by list trust.
    st.bv = await slotted(() => uploadPlain({ plain, run: runWithAck }));
    c.setState?.({ bv: st.bv });
  } else {
    const countParts = countPartsOf(deps);
    await slotted(() => appendGroup({
      ...meta, bv: st.bv!, files: [file], run: runWithAck,
      ...(countParts ? { countParts: () => countParts(st.bv!, cookies) } : {}),
    }));
    // appendGroup resolves only after an unambiguous successful command; ambiguous failures are
    // re-thrown by appendGroup itself. TODO(?): PR5 should confirm biliup append's real completion
    // line; until then the exceptional return is the explicit ack (no archive list is queried).
    ackSeen = true;
    sup.observeAcked((deps.readAcked ?? (() => new Map<string, number>()))(0));
  }
  if (!st.bv) throw new Error("upload-part missing explicit bv after create");
  const stat = deps.stat ?? ((x: string) => { const s = statSync(x); return { size: s.size, mtimeMs: s.mtimeMs }; });
  const now = stat(file);
  if (now.size !== ctx.fp.size || now.mtimeMs !== ctx.fp.mtimeMs) {
    throw new Error("upload-part fp changed after transfer; refusing to confirm " + basename(file));
  }
  if (!ackSeen) throw new Error("upload-part missing explicit transfer ack; refusing to confirm " + basename(file));
  const acked = sup.ackedSinceChild();
  if (acked < now.size) throw new Error("upload-part acked bytes " + acked + " < file size " + now.size + "; refusing to confirm " + basename(file));
  return {
    outputs: [], bv: st.bv,
    confirmed: { size: now.size, mtimeMs: now.mtimeMs, ackedBytes: acked },
    note: (ctx.bv ? "append " : "create ") + basename(file),
  };
}

export function makeUploadPartProcessor(deps: UploadPartDeps = {}): Processor {
  return {
    kind: PART_KINDS.upload,
    resource: "upload",
    lane: "biliup",
    retryable: false,
    interruptible: false,
    validate(job: ProcessJob): string | null {
      try { assertJobInvariants(job, { allowedRoots: ["/"] }); } catch (e) { return (e as Error).message; }
      if (job.inputs.length !== 1) return "upload-part accepts exactly one input";
      if (!isVideoFileName(job.inputs[0])) return "upload-part input must be a video file";
      const p = params(job);
      if (!p.cookies || !p.title || !Number.isInteger(p.tid) || p.tid <= 0 || !p.tag) return "missing biliup metadata";
      if (!existsSync(job.inputs[0])) return "upload-part source missing";
      try {
        const c = ctxOf(job);
        if (c.file !== job.inputs[0]) return "params.ctx.file must equal inputs[0]";
      } catch (e) { return (e as Error).message; }
      return null;
    },
    estimateDiskBytes(): number { return 0; },
    async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
      const sup = supervise(job, ctx, deps);
      const work = runOneBiliupPart(job, ctx, deps, sup);
      work.catch(() => {});
      try {
        return await Promise.race([work, sup.abandoned]);
      } catch (e) {
        if (isSlotBusy(e)) return { outputs: [], retry: { reason: "slot-busy", notBefore: (deps.now ?? Date.now)() + RETRY_BACKOFF_MS } };
        if (e instanceof StallError) return afterStall(job, deps, sup, { bv: ctxOf(job).bv }, e);
        if (isAppendAmbiguous(e)) throw new Error(APPEND_AMBIGUOUS_MARKER + " upload-part append outcome unknown; no confirmation, no cleanup chain");
        throw e;
      } finally { sup.stop(); }
    },
    verifyStopped(): Promise<"safe" | "uncertain"> { return Promise.resolve("uncertain"); },
    recover(): Promise<"uncertain"> { return Promise.resolve("uncertain"); },
  };
}

export const uploadPartProcessor: Processor = makeUploadPartProcessor();
