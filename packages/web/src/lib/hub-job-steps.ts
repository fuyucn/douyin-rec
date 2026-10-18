/**
 * Pure derivation of pipeline step states from ledger events.
 *
 * A `skipped` event is deliberately NOT a completion: the step did not run this round. This keeps
 * the flow graph from showing `pull` as done when the scan-to-pull sidecar recheck skipped it
 * (issue #176).
 */
export type NodeStatus = "done" | "active" | "skipped" | "todo" | "failed" | "blocked";

export interface StepEventLike {
  step: string;
  phase: string;
  at: number;
  detail?: string;
}

export interface NodeStateLike {
  node: string;
  state: string;
}

const NODE_STATE_TO_UI: Record<string, NodeStatus> = {
  running: "active",
  pending: "todo",
  done: "done",
  failed: "failed",
  blocked: "blocked",
  skipped: "skipped",
};

// Mirrors SIDECAR_SKIP_PREFIX / SIDECAR_UNKNOWN_PREFIX in core hub-flow (web shares types only).
// Rows written before issue #176 logged these skips as `done`; the prefix is the only way to tell
// them apart.
const LEGACY_SKIP_DETAIL = /^(跳过·|未确认·)/;

export function deriveStepStatuses(
  job: {
    state: string;
    steps: readonly StepEventLike[];
    nodeStates: readonly NodeStateLike[];
  },
  stepKeys: readonly string[],
  now = Date.now(),
): Record<string, { status: NodeStatus; sec: number | null }> {
  const pair = new Map<string, { start?: number; done?: number; skipped?: number }>();
  for (const s of job.steps) {
    const e = pair.get(s.step) ?? {};
    if (s.phase === "skipped" || (s.phase === "done" && s.detail && LEGACY_SKIP_DETAIL.test(s.detail))) e.skipped = s.at;
    else if (s.phase === "start") e.start = s.at;
    else if (s.phase === "done") e.done = s.at;
    pair.set(s.step, e);
  }
  const success = job.state === "done" || job.state === "needs_manual";
  const nodeStates = new Map(job.nodeStates.map((n) => [n.node, n]));
  const out: Record<string, { status: NodeStatus; sec: number | null }> = {};
  for (const key of stepKeys) {
    const e = pair.get(key);
    const n = nodeStates.get(key);
    if (n) {
      // The workflow safety valve wins over raw events; duration still comes from the start/done pair.
      const status: NodeStatus = NODE_STATE_TO_UI[n.state] ?? "todo";
      const sec = e?.done != null && e.start != null ? Math.round((e.done - e.start) / 1000)
        : status === "active" && e?.start != null ? Math.round((now - e.start) / 1000)
        : null;
      out[key] = { status, sec };
      continue;
    }
    if (e?.done != null) out[key] = { status: "done", sec: e.start != null && e.start <= e.done ? Math.round((e.done - e.start) / 1000) : null };
    // A real start after a skip means the step is running now; the earlier skip is stale.
    else if (e?.start != null && (e.skipped == null || e.start >= e.skipped)) out[key] = { status: "active", sec: Math.round((now - e.start) / 1000) };
    else if (e?.skipped != null) out[key] = { status: "skipped", sec: null };
    else out[key] = { status: success ? "skipped" : "todo", sec: null };
  }
  return out;
}
