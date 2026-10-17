/**
 * Node upload queue dispatch (plan 038 T12): master side of "prep, then biliup" on one pinned node.
 *
 * Two phases because a biliup row needs real input files at enqueue time (the store stats inputs[0]) and the
 * stage part layout is only known once upload-prep has run:
 *   1. enqueue one `upload-prep` row (seq 1);
 *   2. once its receipt is `done`, enqueue one `biliup` row (seq 2) whose inputs are the prep outputs.
 * Both job ids are fixed up front and persisted in `sync_jobs.uploadPlan`, so any re-entry (ssh timeout,
 * master restart) reuses them and the node's idempotent enqueue answers instead of creating a second job.
 * This module never uploads directly, never deletes anything and never calls `_node-abort`.
 */
import { jobIdOf, type EnqueueResult, type ProcessJob, type ProcessReceipt } from "@drec/core";
import type { SyncLedger } from "./ledger.js";
import { ProcUnsupported, type Transport } from "./transport.js";

export interface UploadPlan {
  v: 1;
  /** Execution node, pinned for the life of the order (the winner may change between rounds, this must not). */
  nodeId: string;
  orderKey: string;
  generation: number;
  prepJobId: string;
  biliupJobId: string;
}

export interface PrepSpec {
  segments: string[];
  stageDir: string;
  stem: string;
  mergeSegments: boolean;
  segmentGroupSec: number;
  minSegmentSec: number;
  tsDirect: boolean;
}

export interface BiliupMeta {
  cookies: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  public?: boolean;
  /** Total expected duration of the parts; required for the node's no-draft proof. */
  expectedDurationSec: number;
}

export type UploadDispatch =
  | { phase: "prep-enqueued"; result: EnqueueResult }
  | { phase: "prep-waiting"; state: ProcessReceipt["state"] }
  | { phase: "prep-failed"; state: ProcessReceipt["state"]; error?: string }
  | { phase: "blocked"; reason: string }
  | { phase: "biliup-enqueued"; result: EnqueueResult }
  | { phase: "biliup"; receipt: ProcessReceipt };

type LedgerPlanApi = Pick<SyncLedger, "getUploadPlan" | "claimUploadPlan">;

export function planJobIds(orderKey: string, generation: number): Pick<UploadPlan, "prepJobId" | "biliupJobId"> {
  return {
    prepJobId: jobIdOf("upload-prep", `${orderKey}:prep`, generation),
    biliupJobId: jobIdOf("biliup", `${orderKey}:up`, generation),
  };
}

function parsePlan(json: string): UploadPlan {
  const p = JSON.parse(json) as Partial<UploadPlan>;
  const ok = p.v === 1 && typeof p.nodeId === "string" && typeof p.orderKey === "string"
    && Number.isSafeInteger(p.generation) && typeof p.prepJobId === "string" && typeof p.biliupJobId === "string";
  if (!ok) throw new Error("persisted uploadPlan is malformed");
  return p as UploadPlan;
}

/**
 * Load the persisted plan or create it (first writer wins). An existing plan is never recomputed, and an
 * existing plan pinned to another node is an error: switching nodes could produce a second draft.
 */
export function ensureUploadPlan(ledger: LedgerPlanApi, streamKey: string, nodeId: string, generation = 1): UploadPlan {
  const existing = ledger.getUploadPlan(streamKey);
  if (existing) return checkPinned(parsePlan(existing), nodeId);
  const plan: UploadPlan = { v: 1, nodeId, orderKey: streamKey, generation, ...planJobIds(streamKey, generation) };
  if (!ledger.claimUploadPlan(streamKey, JSON.stringify(plan))) {
    const raced = ledger.getUploadPlan(streamKey);
    if (!raced) throw new Error(`no ledger row for ${streamKey}; cannot persist uploadPlan`);
    return checkPinned(parsePlan(raced), nodeId);
  }
  return plan;
}

function checkPinned(plan: UploadPlan, nodeId: string): UploadPlan {
  if (plan.nodeId !== nodeId) throw new Error(`order ${plan.orderKey} is pinned to node ${plan.nodeId}, not ${nodeId}`);
  return plan;
}

function prepJob(plan: UploadPlan, spec: PrepSpec, owner: ProcessJob["owner"], now: number): ProcessJob {
  const { segments, ...params } = spec;
  return {
    jobId: plan.prepJobId, kind: "upload-prep", logicalKey: `${plan.orderKey}:prep`, generation: plan.generation,
    inputs: segments, params, replaceInputs: false, owner, createdAt: now, orderKey: plan.orderKey, seq: 1,
  };
}

function biliupJob(plan: UploadPlan, meta: BiliupMeta, parts: string[], owner: ProcessJob["owner"], now: number): ProcessJob {
  return {
    jobId: plan.biliupJobId, kind: "biliup", logicalKey: `${plan.orderKey}:up`, generation: plan.generation,
    inputs: parts, params: { ...meta }, replaceInputs: false, owner, createdAt: now,
    orderKey: plan.orderKey, seq: 2, prepJobId: plan.prepJobId,
  };
}

async function enqueueOne(t: Transport, job: ProcessJob): Promise<EnqueueResult> {
  if (!t.enqueue) throw new ProcUnsupported("transport has no enqueue channel");
  const res = await t.enqueue({ v: 1, jobs: [job] });
  const r = res.results.find((x) => x.jobId === job.jobId);
  if (!r) throw new Error(`enqueue response is missing ${job.jobId}`);
  return r;
}

export interface DispatchInput {
  prep: PrepSpec;
  meta: BiliupMeta;
  owner: ProcessJob["owner"];
  now?: () => number;
}

/**
 * Advance one order by at most one step. Safe to call every poll: it only enqueues what the node does not
 * already know, and a transport failure is simply retried by the next call (ids are fixed by the plan).
 */
export async function advanceUpload(t: Transport, plan: UploadPlan, input: DispatchInput): Promise<UploadDispatch> {
  if (!t.procStatus) throw new ProcUnsupported("transport has no status channel");
  if (!(input.meta.expectedDurationSec > 0)) throw new Error("expectedDurationSec is required to enqueue a biliup upload");
  const now = (input.now ?? Date.now)();
  const receipts = await t.procStatus([plan.prepJobId, plan.biliupJobId]);
  const byId = new Map(receipts.map((r) => [r.jobId, r]));
  const up = byId.get(plan.biliupJobId);
  if (up) return { phase: "biliup", receipt: up };
  const prep = byId.get(plan.prepJobId);
  if (!prep) return { phase: "prep-enqueued", result: await enqueueOne(t, prepJob(plan, input.prep, input.owner, now)) };
  if (prep.state === "pending" || prep.state === "running") return { phase: "prep-waiting", state: prep.state };
  if (prep.state !== "done") return { phase: "prep-failed", state: prep.state, ...(prep.error ? { error: prep.error } : {}) };
  if (!prep.outputs?.length) return { phase: "blocked", reason: "prep is done but the receipt carries no outputs (old node bundle?)" };
  return { phase: "biliup-enqueued", result: await enqueueOne(t, biliupJob(plan, input.meta, prep.outputs, input.owner, now)) };
}
