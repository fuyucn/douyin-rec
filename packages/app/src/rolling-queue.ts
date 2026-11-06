/**
 * app/rolling-queue.ts — plan 046 PR6 (方案 A): the recorder's seal hook only enqueues upload-part rows.
 *
 * The switch (settings.`ROLLING_QUEUE_MODE_SETTING`, default off) is read once per factory build. When off,
 * nothing here runs and the legacy rolling-upload path stays byte-identical. When on:
 *   - the recorder never spawns biliup, never takes the node upload slot or the account gate;
 *   - each sealed part becomes one deterministic upload-part row (orderKey = same-broadcast key,
 *     seq = part index, params.partWorkflow = "rolling" so the confirmed upload chains cleanup-part);
 *   - the serve runner is the only uploader, and cleanup-part (PR2) is the only deleter;
 *   - the legacy sidecar is imported once per confirmed part as a done row (idempotent), never rewritten.
 */
import { existsSync, statSync } from "node:fs";
import {
  PART_KINDS, ROLLING_QUEUE_MODE_SETTING, jobIdOf, parseBoolFlag,
  type PartCtx, type ProcessJob,
} from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { TaskStore } from "./store.js";
import { drecRoot } from "./paths.js";
import { dbPathForDataRoot } from "./timezone.js";
import { nodeAllowedRoots } from "./node-enqueue.js";

export interface QueuePartInput {
  file: string;
  /** 0-based part index as the recorder numbers segments; queue seq is index + 1. */
  index: number;
  orderKey: string;
  bv?: string;
  title?: string;
  expectedDurationSec?: number;
  taskId?: number;
  log?: (message: string) => void;
}

/** Settings read for the switch. Missing row / unreadable db / invalid value => false (fail closed). */
export function rollingQueueModeEnabled(dbPath: string = dbPathForDataRoot(drecRoot())): boolean {
  try {
    if (!existsSync(dbPath)) return false;
    const store = new TaskStore(dbPath);
    try {
      return parseBoolFlag(store.getSetting(ROLLING_QUEUE_MODE_SETTING) ?? undefined, false);
    } finally { store.close(); }
  } catch {
    return false;
  }
}

function openQueue(log?: (m: string) => void): ProcQueueStore | null {
  try { return new ProcQueueStore(procQueueDbPath(drecRoot())); }
  catch (e) { log?.("[rolling-queue] 任务表不可用: " + String((e as Error)?.message ?? e)); return null; }
}

function partJob(input: QueuePartInput, generation: number, seq: number, fp: { size: number; mtimeMs: number }): ProcessJob {
  const logicalKey = input.orderKey + ":part:" + String(seq);
  const ctx: PartCtx = {
    v: 1, orderKey: input.orderKey, index: seq, file: input.file, fp,
    ...(input.bv ? { bv: input.bv } : {}),
  };
  return {
    jobId: jobIdOf(PART_KINDS.upload, logicalKey, generation),
    kind: PART_KINDS.upload, logicalKey, generation, inputs: [input.file],
    params: {
      ctx, partWorkflow: "rolling",
      ...(input.title ? { title: input.title } : {}),
      ...(input.expectedDurationSec && input.expectedDurationSec > 0 ? { expectedDurationSec: input.expectedDurationSec } : {}),
    },
    replaceInputs: false,
    owner: { ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), streamKey: input.orderKey },
    createdAt: Date.now(), orderKey: input.orderKey, seq,
  };
}

function fpOf(file: string): { size: number; mtimeMs: number } | null {
  try { const s = statSync(file); return { size: s.size, mtimeMs: s.mtimeMs }; } catch { return null; }
}

/** Enqueue one sealed part. Returns false when the store rejects it (caller keeps the source). */
export function enqueueRollingUploadPart(input: QueuePartInput): boolean {
  const fp = fpOf(input.file);
  if (!fp) { input.log?.("[rolling-queue] 入队失败:源文件无法 stat: " + input.file); return false; }
  const store = openQueue(input.log);
  if (!store) return false;
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const r = store.enqueue(partJob(input, generation, input.index + 1, fp), { allowedRoots: nodeAllowedRoots(drecRoot()) });
    if (r.state !== "pending" && r.state !== "running") {
      input.log?.("[rolling-queue] 段 " + input.index + " 入队被拒(" + r.state + "): " + (r.error ?? ""));
      return false;
    }
    return true;
  } catch (e) {
    input.log?.("[rolling-queue] 段 " + input.index + " 入队异常: " + String((e as Error)?.message ?? e));
    return false;
  } finally { store.close(); }
}

/** Empty/fragment sealed part: a skipped placeholder keeps seq gapless for later parts. */
export function enqueueRollingSkipPart(input: QueuePartInput & { reason?: string }): boolean {
  const fp = fpOf(input.file);
  if (!fp) return false;
  const store = openQueue(input.log);
  if (!store) return false;
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const r = store.enqueueSourceGone(partJob(input, generation, input.index + 1, fp), { allowedRoots: nodeAllowedRoots(drecRoot()) });
    if (r.state !== "skipped" && r.state !== "pending" && r.state !== "done") {
      input.log?.("[rolling-queue] 段 " + input.index + " 占位被拒(" + r.state + "): " + (r.error ?? ""));
      return false;
    }
    return true;
  } catch (e) {
    input.log?.("[rolling-queue] 段 " + input.index + " 占位异常: " + String((e as Error)?.message ?? e));
    return false;
  } finally { store.close(); }
}

/**
 * Backward-compat import: a part the legacy uploader already confirmed becomes a done row so later parts
 * inherit its bv from the queue. Idempotent (existing done row is reported, never rewritten).
 */
export function importRollingConfirmedPart(input: QueuePartInput & { bv: string }): boolean {
  const fp = fpOf(input.file);
  if (!fp) return false; // deleted source: nothing to import (cleanup already ran in the old path)
  const store = openQueue(input.log);
  if (!store) return false;
  try {
    const generation = store.currentOrderGeneration(input.orderKey);
    const r = store.importConfirmedPart(partJob({ ...input, bv: input.bv }, generation, input.index + 1, fp), {
      allowedRoots: nodeAllowedRoots(drecRoot()), bv: input.bv,
    });
    if (r.state !== "done") {
      input.log?.("[rolling-queue] 段 " + input.index + " 兼容导入未成功(" + r.state + "): " + (r.error ?? ""));
      return false;
    }
    return true;
  } catch (e) {
    input.log?.("[rolling-queue] 段 " + input.index + " 兼容导入异常: " + String((e as Error)?.message ?? e));
    return false;
  } finally { store.close(); }
}
