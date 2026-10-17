/**
 * biliup processor (plan 038 T08): create the first part, then append each later part.
 * Stall-based death is intentionally absent here; T15 adds it behind the `biliup-queue` capability.
 */
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { APPEND_AMBIGUOUS_MARKER, type ProcessContext, type ProcessJob, type ProcessResult, type Processor } from "@drec/core";
import { appendGroup, buildUploadArgs, parseBV, runBiliup, uploadPlain } from "./run-biliup.js";
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

function params(job: ProcessJob): BiliupParams {
  const p = job.params as Partial<BiliupParams>;
  const persisted = (job as { bv?: string | null }).bv;
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
  run?: (argv: string[]) => Promise<string>;
  lookup?: ArchiveQuery;
  /** Expected total duration of the parts, used for the no-draft proof. */
  expectedDurationSec?: number;
  probeDuration?: (file: string) => Promise<number>;
}

/** Expected duration comes from the job (master/prep), never silently defaulted to "safe". */
function expectedDuration(job: ProcessJob, deps: BiliupDeps): number {
  const fromJob = Number((job.params as { expectedDurationSec?: unknown }).expectedDurationSec ?? 0);
  return Number.isFinite(fromJob) && fromJob > 0 ? fromJob : (deps.expectedDurationSec ?? 0);
}

export function makeBiliupProcessor(deps: BiliupDeps = {}): Processor {
  return {
    kind: "biliup",
    resource: "upload",
    lane: "biliup",
    retryable: false,
    interruptible: false,
    validate(job: ProcessJob): string | null {
      const p = params(job);
      if (!p.cookies) return "缺少 cookies 路径";
      if (!p.title) return "缺少稿件标题";
      if (!Number.isInteger(p.tid) || p.tid <= 0) return "tid 非法";
      if (!p.tag) return "缺少 tag";
      if (job.inputs.length === 0) return "inputs 不能为空";
      if (job.inputs.some((f) => !existsSync(f))) return "分 P 文件不存在";
      return null;
    },
    estimateDiskBytes(): number { return 0; },
    async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
      const p = params(job);
      const files = job.inputs;
      const meta = { cookies: p.cookies, title: p.title, tid: p.tid, tag: p.tag, ...(p.desc ? { desc: p.desc } : {}), public: p.public === true };
      const run = deps.run ?? runBiliup;
      // Real runs go through runBiliup so step/pid are observable; injected tests get the raw run.
      const runObserved = deps.run
        ? (argv: string[]) => run(argv)
        : (argv: string[]) => runBiliup(argv, {
          onSpawn: (pid?: number) => {
            ctx.setState?.({ childPid: pid ?? null, step: "transfer" });
          },
          onLine: (line: string) => {
            if (/All files uploaded successfully/.test(line)) ctx.setState?.({ step: "submit" });
          },
        });
      let bv = p.bv;
      if (!bv) {
        ctx.setState?.({ step: "gate_wait" });
        // Fail-closed before creating anything: without duration we cannot prove "no draft".
        const expected = expectedDuration(job, deps);
        if (expected <= 0) throw new Error("缺少本次产物的预期时长,无法确认是否已建稿,拒绝建稿");
        const proof = await findRecentArchive(p.cookies, p.title, expected, deps.lookup);
        if (proof === "yes") throw new Error("已存在同标题同时长稿件,拒绝重复建稿");
        if (proof === "unknown") throw new Error("无法确认是否已建稿,转人工核对");
        bv = await uploadPlain({ plain: meta, run: runObserved });
        ctx.setState?.({ bv });
      }
      const appendFrom = p.bv ? 0 : 1; // params.bv means inputs already contain P1
      for (let i = appendFrom; i < files.length; i++) {
        ctx.setState?.({ step: "gate_wait" });
        try {
          await appendGroup({ ...meta, bv, files: [files[i]!], run: runObserved });
        } catch (e) {
          const msg = String((e as Error)?.message ?? e);
          if (msg.includes(APPEND_AMBIGUOUS_MARKER)) throw new Error(`${APPEND_AMBIGUOUS_MARKER} ${msg}`);
          throw e;
        }
      }
      return { outputs: [], bv, note: `${basename(files[0] ?? "")} +${Math.max(0, files.length - 1)} parts` };
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
