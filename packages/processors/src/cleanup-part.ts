import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  PART_KINDS, assertJobInvariants, isVideoFileName, type PartCtx,
  type ProcessJob, type ProcessResult, type Processor,
} from "@drec/core";

const CLEANUP_PROOF_HOLD = "cleanup-part has no qualified per-part observation executor; preserve source and alias for manual review";

/** Hard-link directory biliup renders part titles into (mirrors ALIAS_DIR in biliup.ts). */
export const UPLOAD_ALIAS_DIR = ".upload";

/**
 * The alias path derived from the part file itself — one rule, never a second copy inside ctx.
 * TODO(?): biliup names the alias after the rendered part title, so a title-named alias is not
 * recoverable from the file name alone; PR5 wiring should share one naming rule with biliup.
 */
export function uploadAliasPath(file: string): string {
  return join(dirname(file), UPLOAD_ALIAS_DIR, basename(file));
}

export interface CleanupPartDeps {
  /** Second contract pass against the node's roots; enqueue/claim keep the authoritative check. */
  allowedRoots?: () => readonly string[];
  exists?: (path: string) => boolean;
  stat?: (path: string) => { size: number; mtimeMs: number };
  unlink?: (path: string) => void;
}

type CtxResult = { ok: true; ctx: PartCtx } | { ok: false; error: string };

/** Shape + cross-field checks for the persisted ctx (the processor's only pointer). */
function readCtx(job: ProcessJob): CtxResult {
  const raw: unknown = job.params.ctx;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: "params.ctx 须为对象" };
  const c = raw as Record<string, unknown>;
  if (c.v !== 1) return { ok: false, error: "params.ctx.v 须为 1" };
  if (typeof c.orderKey !== "string" || c.orderKey === "") return { ok: false, error: "params.ctx.orderKey 须为非空字符串" };
  if (!Number.isSafeInteger(c.index) || (c.index as number) < 1) return { ok: false, error: "params.ctx.index 须为 ≥1 的整数" };
  if (typeof c.file !== "string" || c.file === "" || !isAbsolute(c.file)) return { ok: false, error: "params.ctx.file 须为绝对路径" };
  if (!isVideoFileName(c.file)) return { ok: false, error: "params.ctx.file 只允许视频扩展名(拒 xml/ass/边车): " + basename(c.file) };
  if (resolve(c.file) !== resolve(job.inputs[0] ?? "")) return { ok: false, error: "params.ctx.file 与 inputs[0] 不一致" };
  const fp: unknown = c.fp;
  if (typeof fp !== "object" || fp === null || Array.isArray(fp)) return { ok: false, error: "params.ctx.fp 须为对象" };
  const f = fp as Record<string, unknown>;
  for (const key of ["size", "mtimeMs"] as const) {
    if (typeof f[key] !== "number" || !Number.isFinite(f[key]) || (f[key] as number) < 0) {
      return { ok: false, error: "params.ctx.fp." + key + " 须为有限的非负数" };
    }
  }
  if (typeof c.bv !== "string" || c.bv === "") return { ok: false, error: "cleanup-part 须携带已确认稿件 bv(无 bv 不删)" };
  return { ok: true, ctx: c as unknown as PartCtx };
}

export function makeCleanupPartProcessor(deps: CleanupPartDeps = {}): Processor {
  return {
    kind: PART_KINDS.cleanup,
    resource: "cpu",
    // copy lane: pure local IO, never blocks or shares the biliup upload slot (plan 046 §5.6).
    lane: "copy",
    retryable: false,
    interruptible: true,
    validate(job: ProcessJob): string | null {
      try {
        assertJobInvariants(job, { allowedRoots: deps.allowedRoots?.() ?? ["/"] });
      } catch (e) { return (e as Error).message; }
      if (job.inputs.length !== 1) return "cleanup-part 只接受 1 个输入,收到 " + job.inputs.length;
      if (job.replaceInputs) return "cleanup-part 自己按 ctx 精确删除,不走通用 replaceInputs";
      if (!isVideoFileName(job.inputs[0])) return "cleanup-part 输入须是视频文件(拒 xml/ass/边车): " + basename(job.inputs[0]);
      const checked = readCtx(job);
      return checked.ok ? CLEANUP_PROOF_HOLD : checked.error;
    },
    estimateDiskBytes(): number { return 0; },
    async run(job: ProcessJob): Promise<ProcessResult> {
      const checked = readCtx(job);
      throw new Error(checked.ok ? CLEANUP_PROOF_HOLD : checked.error);
    },
    async recover(): Promise<"uncertain"> { return "uncertain"; },
  };
}

export const cleanupPartProcessor: Processor = makeCleanupPartProcessor();
