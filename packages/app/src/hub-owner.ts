/**
 * plan 046 PR7: write the node-side skipped(hub-owned) history row for one sealed part.
 *
 * This is deliberately a thin app-layer adapter: PR6 will move the seal hook into the queue path;
 * until then rolling-upload calls it through an injected seam. It never uploads or deletes anything.
 */
import { statSync } from "node:fs";
import { jobIdOf, PART_KINDS, partLogicalKey, type PartCtx, type ProcessJob } from "@drec/core";
import { ProcQueueStore, procQueueDbPath } from "@drec/proc-queue";
import { drecRoot } from "./paths.js";
import { nodeAllowedRoots } from "./node-enqueue.js";

export interface HubOwnedSkipInput {
  file: string;
  index: number;
  /** Explicit queue seq across sessions of the same broadcast (defaults to index + 1). */
  seq?: number;
  streamKey: string;
  title?: string;
  expectedDurationSec?: number;
  confirmedAt?: number;
  taskId?: number;
  log?: (message: string) => void;
}

/** Write one terminal skip row. Returns true when the store accepted or already held the skip. */
export function enqueueHubOwnedSkip(input: HubOwnedSkipInput): boolean {
  let size: number;
  let mtimeMs: number;
  try {
    const st = statSync(input.file);
    size = st.size;
    mtimeMs = st.mtimeMs;
  } catch (e) {
    input.log?.("[hub-owner] skip row not written: source cannot be stat-ed: " + String((e as Error)?.message ?? e));
    return false;
  }
  const orderKey = input.streamKey;
  const seq = input.seq ?? input.index + 1;
  // Same logical key as the upload-part producer: one segment can never have two job ids (PR6 rework).
  const logicalKey = partLogicalKey(orderKey, seq);
  const store = new ProcQueueStore(procQueueDbPath(drecRoot()));
  try {
    const generation = store.currentOrderGeneration(orderKey);
    const ctx: PartCtx = {
      v: 1, orderKey, index: seq, file: input.file, fp: { size, mtimeMs },
    };
    const job: ProcessJob = {
      jobId: jobIdOf(PART_KINDS.upload, logicalKey, generation),
      kind: PART_KINDS.upload, logicalKey, generation, inputs: [input.file],
      params: {
        ctx,
        ...(input.title ? { title: input.title } : {}),
        ...(input.expectedDurationSec && input.expectedDurationSec > 0 ? { expectedDurationSec: input.expectedDurationSec } : {}),
        ...(input.confirmedAt ? { confirmedAt: input.confirmedAt } : {}),
      },
      replaceInputs: false,
      owner: { ...(input.taskId !== undefined ? { taskId: input.taskId } : {}), streamKey: orderKey },
      createdAt: input.confirmedAt ?? Date.now(), orderKey, seq,
    };
    const result = store.enqueueSkipped(job, { allowedRoots: nodeAllowedRoots(drecRoot()), reason: "skip-hub-owned" });
    if (result.state !== "skipped") {
      input.log?.("[hub-owner] skip row rejected (" + result.state + "): " + (result.error ?? "unknown"));
      return false;
    }
    return true;
  } catch (e) {
    input.log?.("[hub-owner] skip row write failed: " + String((e as Error)?.message ?? e));
    return false;
  } finally {
    store.close();
  }
}

