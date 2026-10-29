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
import { presentSet, type FlowCfg } from "../components/flow-build";

export type StepState = "done" | "running" | "waiting" | "failed" | "skipped" | "unknown";

export interface TreeStep { key: string; state: StepState }

export interface PartRow {
  index: number;
  steps: TreeStep[];
  state: StepState;
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
    case "failed": return at(["done", "done", "failed", "waiting"]);
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
      state: rowState(steps),
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
      state: rowState(steps),
      bytes: cur.uploadedBytes,
      ...(cur.bytes ? { capBytes: cur.bytes } : {}),
      collapsed: false,
    });
  }
  const parts = [...byIndex.values()].sort((a, b) => a.index - b.index);
  return { id, name, role, parts, pending: 0, confirmed: parts.filter((p) => p.state === "done").length };
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
  return { id, name, role, parts, confirmed, pending: Math.max(0, total - confirmed - (up ? 1 : 0) - ambiguous) };
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
