/**
 * run-tree.ts — pure model of one run's horizontal runtime tree (issue #401).
 *
 * Two shapes, chosen by what really happens:
 *  - `parts`: live upload / rolling — root -> node -> one branch per part (parts are produced one by one).
 *  - `pipeline`: hub post-processing — root -> candidate nodes -> select -> the hub step chain.
 * Nothing here invents progress: a step with no source stays `unknown` / `waiting`.
 */
import type { HubJobDTO, RollingDeliveryDTO } from "../api/client";
import type { LivePartView, LiveUploadSnapshot } from "@drec/contracts";
import { STAGE_READY } from "@drec/hub-ledger-contract";
import { presentSet, type FlowCfg } from "../components/flow-build";

export type StepState = "done" | "running" | "waiting" | "failed" | "skipped" | "unknown";

export interface TreeStep { key: string; state: StepState }

export interface PartRow {
  index: number;
  steps: TreeStep[];
  state: StepState;
  error?: string;
  bytes?: number;
  capBytes?: number;
  /** Confirmed parts fold into one line; the current / failed one stays open. */
  collapsed: boolean;
}

export interface PartsNode {
  id: string;
  name: string;
  role: "winner" | "candidate" | "standby";
  parts: PartRow[];
  /** Rolling has counts only: parts after the listed ones that are not yet uploaded. */
  pending: number;
  /** Rolling segments whose upload result is unknown (needs a manual check). */
  ambiguous: number;
  confirmed: number;
}

export interface PartsTree { kind: "parts"; nodes: PartsNode[] }

export interface PipelineCandidate {
  id: string;
  name: string;
  winner: boolean;
  coverage: number;
  durationSec: number;
  complete: boolean;
}

export interface PipelineTree {
  kind: "pipeline";
  candidates: PipelineCandidate[];
  selectState: StepState;
  steps: TreeStep[];
}

export type RunTree = PartsTree | PipelineTree;

const PART_STEPS = ["stream", "seal", "submit", "confirm"] as const;

/** Per-step state of one live-upload part, from its phase. */
export function partSteps(phase: LivePartView["phase"]): TreeStep[] {
  const at = (states: StepState[]): TreeStep[] => PART_STEPS.map((key, i) => ({ key, state: states[i] }));
  switch (phase) {
    case "streaming": return at(["running", "waiting", "waiting", "waiting"]);
    case "sealing": return at(["done", "running", "waiting", "waiting"]);
    case "submitting": return at(["done", "done", "running", "waiting"]);
    case "confirmed": return at(["done", "done", "done", "done"]);
    case "unconfirmed": return at(["done", "done", "done", "unknown"]);
    // The snapshot only keeps the phase, so the step that failed is lost: claim none of them.
    case "failed": return at(["unknown", "unknown", "unknown", "unknown"]);
  }
}

function rowState(steps: TreeStep[]): StepState {
  if (steps.some((s) => s.state === "failed")) return "failed";
  if (steps.some((s) => s.state === "running")) return "running";
  if (steps.every((s) => s.state === "done")) return "done";
  if (steps.some((s) => s.state === "unknown")) return "unknown";
  return "waiting";
}

/** Live-upload snapshot -> one node with one row per part (current part included). */
export function liveNode(snapshot: LiveUploadSnapshot, id: string, name: string, role: PartsNode["role"]): PartsNode {
  const byIndex = new Map<number, PartRow>();
  for (const p of snapshot.parts) {
    const steps = partSteps(p.phase);
    byIndex.set(p.index, {
      index: p.index,
      steps,
      state: p.phase === "failed" ? "failed" : rowState(steps),
      ...(p.error ? { error: p.error } : {}),
      bytes: p.bytes ?? p.uploadedBytes,
      collapsed: p.phase === "confirmed",
    });
  }
  const cur = snapshot.currentPart;
  if (cur && cur.phase !== "confirmed") {
    const steps = partSteps(cur.phase);
    byIndex.set(cur.index, {
      index: cur.index,
      steps,
      state: cur.phase === "failed" ? "failed" : rowState(steps),
      bytes: cur.uploadedBytes,
      ...(cur.bytes ? { capBytes: cur.bytes } : {}),
      collapsed: false,
    });
  }
  const parts = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { id, name, role, parts, pending: 0, ambiguous: 0, confirmed: parts.filter((p) => p.state === "done").length };
}

/** Rolling progress only has counts, so earlier parts are one summary and only the live one is a row. */
export function rollingNode(rows: RollingDeliveryDTO[], id: string, name: string, role: PartsNode["role"]): PartsNode {
  const confirmed = rows.reduce((n, r) => n + r.confirmed, 0);
  const total = rows.reduce((n, r) => n + r.total, 0);
  const up = rows.find((r) => r.uploading)?.uploading ?? null;
  const parts: PartRow[] = [];
  if (up) {
    const steps: TreeStep[] = [
      { key: "stream", state: "done" }, { key: "seal", state: "done" },
      { key: "submit", state: "running" }, { key: "confirm", state: "waiting" },
    ];
    parts.push({ index: up.index, steps, state: "running", collapsed: false });
  }
  const ambiguous = rows.reduce((n, r) => n + r.ambiguous, 0);
  return { id, name, role, parts, confirmed, ambiguous, pending: Math.max(0, total - confirmed - (up ? 1 : 0) - ambiguous) };
}

/** Live snapshots that belong to a broadcast: a `waiting` pump is not on air yet (issue #408). */
export function broadcastSnaps<T>(items: T[], stateOf: (item: T) => string): T[] {
  return items.filter((item) => stateOf(item) !== "waiting");
}

/** Root state of the running broadcast from its live snapshots (issue #408): never hard-code "running". */
export function liveRootState(states: string[]): StepState {
  if (states.some((s) => s === "streaming" || s === "submitting")) return "running";
  if (states.some((s) => s === "failed")) return "failed";
  if (states.some((s) => s === "stopped")) return "skipped";
  if (states.some((s) => s === "finished")) return "done";
  return "waiting";
}

const ORDER = [
  "pull", "node_upload", "merge", "burn_danmu", "burn_livechat", "upload_plain",
  "append_danmu", "append_livechat", "clean_stage_src", "clean_source", "clean_stage",
] as const;

const NODE_STATE: Record<string, StepState> = {
  pending: "waiting", running: "running", done: "done", failed: "failed", blocked: "waiting", skipped: "skipped",
};

const TERMINAL = new Set(["done", "failed", "needs_manual"]);

function stepState(job: HubJobDTO, key: string): StepState {
  const ns = job.nodeStates.find((n) => n.node === key);
  if (ns) return NODE_STATE[ns.state] ?? "unknown";
  const last = [...job.steps].reverse().find((s) => s.step === key);
  if (last) return last.phase === "done" ? "done" : last.phase === "skipped" ? "skipped" : "running";
  return TERMINAL.has(job.state) ? "unknown" : "waiting";
}

/** Hub job (one past or running broadcast) -> candidates, select, and the hub step chain. */
export function pipelineTree(job: HubJobDTO, cfg: FlowCfg | undefined, workerName: (id: string) => string): PipelineTree {
  const present = presentSet(job, cfg);
  const steps = ORDER.filter((k) => present.has(k)).map((key) => ({ key, state: stepState(job, key) }));
  const selected = job.candidates.length > 0 || job.steps.some((s) => s.step === "select" && s.phase === "done");
  const selectState: StepState = selected ? "done" : TERMINAL.has(job.state) ? "unknown" : "running";
  return {
    kind: "pipeline",
    candidates: job.candidates.map((c) => ({
      id: c.worker, name: workerName(c.worker), winner: c.isWinner,
      coverage: c.coverage, durationSec: c.durationSec, complete: c.complete,
    })),
    selectState,
    steps,
  };
}

/** The run's own state for the root card. A stage/archive close-out and a user stop are `needs_manual` but not faults. */
export function rootStateOf(job: Pick<HubJobDTO, "state" | "error">): StepState {
  if (job.state === "done") return "done";
  if (job.state === "failed") return "failed";
  if (job.state === "needs_manual") {
    if (job.error === STAGE_READY) return "done";
    if (job.error === "用户停止") return "skipped"; // exact value of core's USER_STOP (api-types: error === "用户停止")
    return "failed";
  }
  return "running";
}

export type TreeEdge = [from: string, to: string, dashed?: boolean];

/** Connector list; ids match the `data-tr-id` of the cards the component renders. */
export function treeEdges(tree: RunTree): TreeEdge[] {
  const out: TreeEdge[] = [];
  if (tree.kind === "parts") {
    for (const n of tree.nodes) {
      out.push(["root", `n:${n.id}`]);
      for (const p of n.parts) if (!p.collapsed) out.push([`n:${n.id}`, `p:${n.id}:${p.index}`]);
      if (foldedCount(n) > 0 || n.pending > 0 || n.ambiguous > 0) out.push([`n:${n.id}`, `s:${n.id}`]);
    }
    return out;
  }
  if (tree.candidates.length === 0) out.push(["root", "sel"]);
  for (const c of tree.candidates) {
    out.push(["root", `c:${c.id}`]);
    out.push([`c:${c.id}`, "sel", !c.winner]);
  }
  if (tree.steps.length > 0) out.push(["sel", `h:${tree.steps[0].key}`]);
  return out;
}

/** Confirmed parts shown as one folded line. */
export function foldedCount(n: PartsNode): number {
  return Math.max(n.confirmed, n.parts.filter((p) => p.collapsed).length);
}
