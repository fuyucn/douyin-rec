/**
 * zero-disk-policy.ts — zero-disk streaming upload is a sub-mode of rolling upload.
 *
 * Zero-disk writes no source files, so it cannot participate in the file-based hub
 * pipeline (scan / select / merge / burn). It is only safe when the rule is rolling,
 * has no burn steps, and is pinned to the master's local worker: that worker writes
 * the upload result into the same ledger the master reads.
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
  if (rule.enabled === false) {
    return "0 落盘是 rolling 的子选项,但该房间的 hub 规则已停用";
  }
  if (normalizeUploadMode(rule.mode) !== "rolling") {
    return "0 落盘只能在 rolling 上传方式下使用";
  }
  if (pipelineBurns(rule.steps)) {
    return "0 落盘只能在关闭烧录后使用(rolling 只上传 plain,烧录分 P 会被丢掉)";
  }
  const workers = rule.workers ?? [];
  if (workers.length !== 1 || workers[0] !== "local") {
    return "0 落盘当前只支持勾选 local 一个节点(上传台账写在 master 本机)";
  }
  return null;
}
