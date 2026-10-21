/**
 * zero-disk-policy.ts — zero-disk streaming upload is a sub-mode of rolling upload.
 *
 * Zero-disk writes no source files, so it cannot participate in the file-based hub
 * pipeline (scan / select / merge / burn). It is only safe when the rule is rolling,
 * has no burn steps, and is pinned to exactly ONE node (the master's local worker or a
 * single side node): every node that records the room creates its own archive, and an
 * archive cannot be deleted afterwards. A side node reports its result back and the
 * master writes the ledger (issue #331).
 */
import { normalizeUploadMode, pipelineBurns, type BurnSteps } from "./rolling-policy.js";

export interface ZeroDiskRule {
  enabled?: boolean;
  mode?: unknown;
  workers?: readonly string[];
  steps?: BurnSteps | null;
}

/**
 * Returns a user-facing error when `streamUpload` is enabled under an incompatible
 * hub rule, or null when it is allowed. A task without a hub rule is still allowed
 * for backwards-compatible manual/debug runs.
 */
export function zeroDiskRuleError(
  streamUpload: boolean | null | undefined,
  rule: ZeroDiskRule | null | undefined,
): string | null {
  if (streamUpload !== true || rule == null) return null;
  // A disabled rule records nothing, so zero-disk cannot run under it. Allow pausing a
  // zero-disk room without forcing the user to turn the sub-option off first.
  if (rule.enabled === false) return null;
  if (normalizeUploadMode(rule.mode) !== "rolling") {
    return "0 落盘只能在 rolling 上传方式下使用";
  }
  if (pipelineBurns(rule.steps)) {
    return "0 落盘只能在关闭烧录后使用(rolling 只上传 plain,烧录分 P 会被丢掉)";
  }
  const workers = rule.workers ?? [];
  if (workers.length === 0) {
    return "0 落盘必须恰好勾选一个节点(本机或某个远端节点)";
  }
  if (workers.length > 1) {
    return "0 落盘只能勾选一个节点:多个节点同录会各自建稿,稿件无法删除";
  }
  return null;
}
