/**
 * processors/cleanup-part.ts — the ONE queue processor allowed to delete recording sources
 * (plan 046 PR2: §3 principle 1, §4.1 ctx, §5.4, §8 risk 3).
 *
 * Contracts only in this PR: nothing enqueues `cleanup-part` rows yet (PR5 wires the chain),
 * so shipped behaviour is unchanged. Semantics:
 *   - params.ctx is the only input: an absolute video file + fingerprint + confirmed draft id.
 *   - Never queries the archive (§5.4): Bilibili list/part data lags; the deletion evidence is
 *     the confirmed upload ctx (completeAndChain already required a bv; this re-checks it).
 *   - Fingerprint mismatch => keep both files and reject (§5.4 constraint 2: never delete another
 *     file just because the path matches). The runner alerts rejections once, so the processor
 *     does not alert again (same convention as remux.ts).
 *   - Source already gone => idempotent success.
 *   - assertLease before the first irreversible unlink; alias first, source second; a failure of
 *     either step keeps the other file and throws (retryable, never silent).
 */
import { existsSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  PART_KINDS, assertJobInvariants, isVideoFileName, type PartCtx,
  type ProcessContext, type ProcessJob, type ProcessResult, type Processor,
} from "@drec/core";

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

/**
 * cleanup-part processor (plan 046 §5.4). Inputs stay exactly one video file; the deletion
 * evidence is the confirmed upload ctx, not any Bilibili query.
 */
export function makeCleanupPartProcessor(deps: CleanupPartDeps = {}): Processor {
  const exists = deps.exists ?? ((p: string): boolean => existsSync(p));
  const stat = deps.stat ?? ((p: string) => { const s = statSync(p); return { size: s.size, mtimeMs: s.mtimeMs }; });
  const unlink = deps.unlink ?? ((p: string): void => { unlinkSync(p); });
  return {
    kind: PART_KINDS.cleanup,
    resource: "cpu",
    // copy lane: pure local IO, never blocks or shares the biliup upload slot (plan 046 §5.6).
    lane: "copy",
    retryable: true,
    interruptible: true,
    validate(job: ProcessJob): string | null {
      try {
        assertJobInvariants(job, { allowedRoots: deps.allowedRoots?.() ?? ["/"] });
      } catch (e) { return (e as Error).message; }
      if (job.inputs.length !== 1) return "cleanup-part 只接受 1 个输入,收到 " + job.inputs.length;
      if (job.replaceInputs) return "cleanup-part 自己按 ctx 精确删除,不走通用 replaceInputs";
      if (!isVideoFileName(job.inputs[0])) return "cleanup-part 输入须是视频文件(拒 xml/ass/边车): " + basename(job.inputs[0]);
      const checked = readCtx(job);
      return checked.ok ? null : checked.error;
    },
    // Deletion only frees space; nothing is written (runner disk admission stays a no-op).
    estimateDiskBytes(): number { return 0; },
    async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
      const checked = readCtx(job);
      if (!checked.ok) throw new Error(checked.error); // validate already gates this; defense in depth
      const c = checked.ctx;
      const file = c.file;
      const name = basename(file);
      if (!exists(file)) return { outputs: [], note: "源文件已不存在,幂等完成: " + name };
      const now = stat(file);
      if (now.size !== c.fp.size || now.mtimeMs !== c.fp.mtimeMs) {
        throw new Error(
          "cleanup-part 指纹不符,拒绝删除 " + name + ":磁盘 " + now.size + "B/" + now.mtimeMs
            + " ≠ 入队 " + c.fp.size + "B/" + c.fp.mtimeMs + "(文件被替换?两份都保留待人工)",
        );
      }
      // Every unlink below is irreversible: the lease must still be ours (§5.4).
      ctx.assertLease();
      const alias = uploadAliasPath(file);
      const aliasWasThere = exists(alias);
      if (aliasWasThere) {
        try { unlink(alias); }
        catch (e) { throw new Error("cleanup-part 删除别名失败,源文件保留 " + name + ": " + (e as Error).message); }
      }
      try { unlink(file); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          // Raced away after the stat: same meaning as the pre-check — nothing left to delete.
          return { outputs: [], note: "源文件在删除前已消失,幂等完成: " + name };
        }
        throw new Error(
          "cleanup-part 删除源文件失败" + (aliasWasThere ? "(别名已删,源文件仍在,可安全重试)" : "")
            + ": " + name + ": " + (e as Error).message,
        );
      }
      ctx.log("cleanup-part 已删 " + name + (aliasWasThere ? " 及其上传别名" : ""));
      return { outputs: [], note: "deleted " + name };
    },
    // Re-running a cleanup only re-checks existence + fingerprint; safe to rerun after any abort.
    async recover(): Promise<"rerun"> { return "rerun"; },
  };
}

export const cleanupPartProcessor: Processor = makeCleanupPartProcessor();
