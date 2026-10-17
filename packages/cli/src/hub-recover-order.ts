/**
 * hub-recover-order (plan 038 T11): operator recovery for an upload order whose latest generation
 * ended in a terminal-but-not-done state. It only ever writes NEW queue rows (a fresh generation);
 * it never deletes sources, never uploads by itself and never revives old rows.
 *
 * Modes (each refuses unless the evidence it needs is present):
 * - prep:    the prep stage failed before any biliup row ran -> re-enqueue prep + biliup.
 * - bv:      a draft BV exists -> new biliup row appends only the parts the operator confirms are missing.
 * - restart: no draft may exist -> new biliup row creates the draft from scratch, but only after the
 *            all-state archive lookup positively proves there is none.
 */
import { existsSync } from "node:fs";
import {
  isSameChild, jobIdOf, probeChild, type ChildFingerprint, type EnqueueRequest, type EnqueueResponse, type ProcessJob,
} from "@drec/core";
import { ProcQueueStore, procQueueDbPath, type ProcJobRecord } from "@drec/proc-queue";
import { findRecentArchive, type ArchiveQuery } from "@drec/processors";

export type RecoverMode = "prep" | "bv" | "restart";

export interface RecoverRequest {
  orderKey: string;
  mode: RecoverMode;
  /** bv mode: the draft BV id the operator verified on the creator center. */
  bv?: string;
  /** bv mode: 1-based index of the first part that is NOT on the draft yet (must be >= 2). */
  fromPart?: number;
}

export interface RecoverDeps {
  lookup?: ArchiveQuery;
  fileExists?: (path: string) => boolean;
  probe?: (pid: number) => ChildFingerprint | null;
  now?: () => number;
}

export interface RecoverPlan {
  ok: boolean;
  orderKey: string;
  mode: RecoverMode;
  fromGeneration: number;
  newGeneration: number;
  jobs: ProcessJob[];
  /** Set when ok=false: why recovery was refused. */
  refusal?: string;
  notes: string[];
}

const BV_RE = /^BV[0-9A-Za-z]{10}$/;

function refuse(base: Omit<RecoverPlan, "ok" | "jobs" | "notes">, refusal: string, notes: string[] = []): RecoverPlan {
  return { ...base, ok: false, jobs: [], refusal, notes };
}

function clone(row: ProcJobRecord, generation: number, createdAt: number, over: Partial<ProcessJob> = {}): ProcessJob {
  return {
    jobId: jobIdOf(row.kind, row.logicalKey, generation),
    kind: row.kind,
    logicalKey: row.logicalKey,
    generation,
    inputs: [...row.inputs],
    ...(row.outputs ? { outputs: [...row.outputs] } : {}),
    params: { ...row.params },
    replaceInputs: row.replaceInputs,
    owner: { ...row.owner },
    createdAt,
    orderKey: row.orderKey,
    seq: row.seq,
    notBefore: null,
    prepJobId: row.prepJobId,
    ...over,
  };
}

/** A recorded child that may still be running blocks every mode (a second uploader would double-post). */
function liveChild(row: ProcJobRecord, probe: (pid: number) => ChildFingerprint | null): boolean {
  if (row.childPid == null) return false;
  const cur = probe(row.childPid);
  if (cur == null) return false;
  // A live pid without a recorded start time cannot be told apart from pid reuse: treat it as ours.
  if (!row.childPidStartedAt) return true;
  return isSameChild({ pid: row.childPid, startedAt: row.childPidStartedAt }, cur);
}

/** The prep a biliup row waits on must be done with its outputs on disk, or the new row would never claim. */
function prepReady(rows: readonly ProcJobRecord[], store: ProcQueueStore, biliup: ProcJobRecord, exists: (p: string) => boolean): string | null {
  if (!biliup.prepJobId) return null;
  const prep = rows.find((r) => r.jobId === biliup.prepJobId) ?? store.get(biliup.prepJobId);
  if (!prep || prep.state !== "done") return `prep ${biliup.prepJobId} is not done; use --prep`;
  const missing = (prep.resultOutputs ?? prep.outputs ?? []).filter((p) => !exists(p));
  return missing.length ? "prep outputs are missing on disk; use --prep" : null;
}

function planPrep(cur: ProcJobRecord[], gen: number, at: number): { jobs: ProcessJob[]; notes: string[] } | { error: string } {
  const preps = cur.filter((r) => r.kind === "upload-prep");
  const biliups = cur.filter((r) => r.kind === "biliup");
  if (preps.length === 0) return { error: "no upload-prep row in the latest generation" };
  if (preps.every((r) => r.state === "done")) return { error: "prep already done; use --bv or --restart" };
  if (biliups.some((r) => r.everClaimed || r.bv)) return { error: "a biliup row already ran; use --bv or --restart" };
  const idMap = new Map(preps.map((r) => [r.jobId, jobIdOf(r.kind, r.logicalKey, gen)]));
  const jobs = [
    ...preps.map((r) => clone(r, gen, at)),
    ...biliups.map((r) => clone(r, gen, at, { prepJobId: r.prepJobId ? (idMap.get(r.prepJobId) ?? r.prepJobId) : null })),
  ];
  return { jobs, notes: [] };
}

async function planBiliup(
  req: RecoverRequest, cur: ProcJobRecord[], rows: ProcJobRecord[], store: ProcQueueStore, gen: number, at: number, deps: RecoverDeps,
): Promise<{ jobs: ProcessJob[]; notes: string[] } | { error: string }> {
  const open = cur.filter((r) => r.kind === "biliup" && r.state !== "done");
  if (open.length !== 1) return { error: `expected exactly one unfinished biliup row, found ${open.length}` };
  const row = open[0]!;
  const exists = deps.fileExists ?? existsSync;
  const prepErr = prepReady(rows, store, row, exists);
  if (prepErr) return { error: prepErr };
  if (row.inputs.some((f) => !exists(f))) return { error: "part files are missing on disk; use --prep" };
  if (req.mode === "bv") return planBv(req, row, gen, at);
  return planRestart(row, gen, at, deps);
}

function planBv(req: RecoverRequest, row: ProcJobRecord, gen: number, at: number): { jobs: ProcessJob[]; notes: string[] } | { error: string } {
  if (!req.bv || !BV_RE.test(req.bv)) return { error: "--bv must be a valid BV id" };
  if (row.bv && row.bv !== req.bv) return { error: `queue recorded ${row.bv}, which differs from --bv ${req.bv}` };
  const from = req.fromPart;
  if (!Number.isInteger(from) || (from as number) < 2) return { error: "--from-part is required (>= 2): the first part missing from the draft" };
  const rest = row.inputs.slice((from as number) - 1);
  if (rest.length === 0) return { error: `--from-part ${from} leaves nothing to append (${row.inputs.length} parts)` };
  const job = clone(row, gen, at, { inputs: rest, params: { ...row.params, bv: req.bv } });
  return { jobs: [job], notes: [`verify parts 1..${(from as number) - 1} already exist on ${req.bv} before applying`] };
}

async function planRestart(row: ProcJobRecord, gen: number, at: number, deps: RecoverDeps): Promise<{ jobs: ProcessJob[]; notes: string[] } | { error: string }> {
  if (row.bv || typeof row.params.bv === "string") return { error: "a draft BV is known; use --bv, not --restart" };
  const p = row.params as { cookies?: unknown; title?: unknown; expectedDurationSec?: unknown };
  const expected = Number(p.expectedDurationSec ?? 0);
  if (typeof p.cookies !== "string" || typeof p.title !== "string" || !(expected > 0)) {
    return { error: "cookies/title/expectedDurationSec missing; cannot prove there is no draft" };
  }
  const proof = await findRecentArchive(p.cookies, p.title, expected, deps.lookup);
  if (proof !== "no") return { error: `archive lookup says "${proof}"; cannot confirm no draft exists (check the creator center, then use --bv)` };
  return { jobs: [clone(row, gen, at)], notes: ["archive lookup confirmed no draft with this title/duration"] };
}

/** Pure planner: reads the queue, never writes. */
export async function planRecoverOrder(store: ProcQueueStore, req: RecoverRequest, deps: RecoverDeps = {}): Promise<RecoverPlan> {
  const at = (deps.now ?? Date.now)();
  const rows = store.list({ limit: 100_000 }).filter((r) => r.orderKey === req.orderKey);
  const from = rows.reduce((m, r) => Math.max(m, r.generation), 0);
  const base = { orderKey: req.orderKey, mode: req.mode, fromGeneration: from, newGeneration: from + 1 };
  if (rows.length === 0) return refuse(base, "unknown orderKey");
  const cur = rows.filter((r) => r.generation === from);
  const active = cur.filter((r) => r.state === "pending" || r.state === "running");
  if (active.length) return refuse(base, `generation ${from} is still active (${active.length} rows); cancel or wait first`);
  if (!cur.some((r) => r.kind === "biliup")) return refuse(base, "no biliup row in the latest generation");
  if (cur.every((r) => r.state === "done")) return refuse(base, "latest generation is already done; nothing to recover");
  const probe = deps.probe ?? probeChild;
  if (cur.some((r) => liveChild(r, probe))) return refuse(base, "a recorded child process may still be running");
  const gen = from + 1;
  const out = req.mode === "prep" ? planPrep(cur, gen, at) : await planBiliup(req, cur, rows, store, gen, at, deps);
  if ("error" in out) return refuse(base, out.error);
  return { ...base, ok: true, jobs: out.jobs, notes: out.notes };
}

export interface RecoverResult {
  plan: RecoverPlan;
  applied: boolean;
  response?: EnqueueResponse;
}

export interface RecoverRunDeps extends RecoverDeps {
  /** Batch enqueue seam (real: app handleEnqueue with batch=true). */
  enqueue: (req: EnqueueRequest) => EnqueueResponse;
}

/** Plan, and when `apply` is set, enqueue the new generation atomically. Dry-run writes nothing. */
export async function runRecoverOrder(dataRoot: string, req: RecoverRequest, apply: boolean, deps: RecoverRunDeps): Promise<RecoverResult> {
  const dbPath = procQueueDbPath(dataRoot);
  const base = { orderKey: req.orderKey, mode: req.mode, fromGeneration: 0, newGeneration: 1 };
  if (!existsSync(dbPath)) return { plan: refuse(base, "no proc queue db under this data root"), applied: false };
  const store = new ProcQueueStore(dbPath, { readOnly: true });
  let plan: RecoverPlan;
  try {
    plan = await planRecoverOrder(store, req, deps);
  } finally {
    store.close();
  }
  if (!plan.ok || !apply) return { plan, applied: false };
  const response = deps.enqueue({ v: 1, jobs: plan.jobs });
  const bad = response.results.find((r) => r.state === "rejected" || r.state === "stale");
  if (bad) return { plan: { ...plan, ok: false, refusal: `enqueue refused ${bad.jobId}: ${bad.error ?? bad.state}` }, applied: false, response };
  return { plan, applied: true, response };
}
