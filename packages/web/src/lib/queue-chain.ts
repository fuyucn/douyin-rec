/**
 * queue-chain.ts — presentation facts for the node upload chain (plan 046 PR8).
 *
 * Everything here is derived from fields the backend already sends. Nothing infers "stuck",
 * "failed" or "retried" from a phase or step: labels are either backend values or dictionary
 * lookups, and a missing dictionary key falls back to the raw backend string.
 *
 * TODO(?): NodeUploadStatusDTO only carries the last part receipt, so the UI can show the
 * current/last part and its chain phase, not a per-part upload -> cleanup list. Exposing every
 * part needs a backend DTO field; this PR intentionally does not claim that view.
 *
 * TODO(?): proc-queue skipped rows are not surfaced in NodeUploadStatusDTO (hub-owned skip
 * uses a different logical key and terminal jobs clear nodeUpload). No skipped badge is drawn
 * until a backend DTO exposes those rows. Running -> reconciling also has no production writer
 * yet, so its badge only activates once that state reaches NodeUploadStatusDTO.state.
 */

export type TFunc = (key: string, vars?: Record<string, string | number>) => string;

/** Translate with an explicit fallback instead of leaking an i18n key into the UI. */
export function queueText(
  t: TFunc,
  key: string,
  fallback: string,
  vars?: Record<string, string | number>,
): string {
  const label = t(key, vars);
  return label === key ? fallback : label;
}

/** Step name → display label. Hyphenated chain kinds map to their underscore i18n keys. */
export function stepLabel(t: TFunc, step: string): string {
  const key = `hub.jobs.stepNode.${step.replaceAll("-", "_")}`;
  return queueText(t, key, step);
}

const NODE_UPLOAD_PHASE_KEYS: Record<string, string> = {
  prep: "queue.nodeUpload.prep",
  biliup: "queue.nodeUpload.biliup",
  "part-chain": "queue.nodeUpload.partChain",
  blocked: "queue.nodeUpload.blocked",
};

/** Node-upload phase → label, using the same key map everywhere. */
export function nodeUploadPhaseLabel(t: TFunc, phase: string): string {
  return queueText(t, NODE_UPLOAD_PHASE_KEYS[phase] ?? `queue.nodeUpload.${phase}`, phase);
}

/** proc-queue job state → label. Unknown states stay as the raw backend value. */
export function nodeUploadStateLabel(t: TFunc, state: string): string {
  return queueText(t, `queue.nodeUpload.state.${state}`, state);
}

export interface PartChainProgress {
  doneBytes: number;
  totalBytes: number;
  bps: number | null;
}

export interface PartChainUpload {
  nodeId: string;
  phase: string;
  state: string | null;
  step: string | null;
  attempts: number | null;
  notBefore: number | null;
  heartbeatAt: number | null;
  polledAt: number;
  progress: PartChainProgress | null;
  error: string | null;
}

export interface QueueChainItem {
  nodeUpload?: { phase: string; state: string | null } | null;
}

export type QueueBadgeKind = "part-chain" | "reconciling";

export interface QueueBadge {
  kind: QueueBadgeKind;
  label: string;
  title?: string;
}

/** Direct field → badge mapping. No badge exists without a matching backend field. */
export function queueBadges(item: QueueChainItem, t: TFunc): QueueBadge[] {
  const out: QueueBadge[] = [];
  const upload = item.nodeUpload;
  if (upload?.phase === "part-chain") {
    out.push({ kind: "part-chain", label: nodeUploadPhaseLabel(t, upload.phase) });
  }
  if (upload?.state === "reconciling") {
    out.push({
      kind: "reconciling",
      label: queueText(t, "queue.phase.reconciling", "reconciling"),
      title: queueText(t, "queue.phase.reconcilingTip", "Automatic reconciliation in progress; this is not a failure. Time box: 24 hours."),
    });
  }
  return out;
}

/** Fields for one part-chain observation, in a fixed operator-facing order. */
export function partChainFields(
  s: PartChainUpload,
  t: TFunc,
  notBeforeText: string | null,
  now: number,
): string[] {
  const out: string[] = [];
  if (s.state) out.push(nodeUploadStateLabel(t, s.state));
  if (s.step) out.push(queueText(t, `queue.nodeUpload.step.${s.step}`, s.step));
  if (s.attempts != null) {
    out.push(queueText(t, "queue.nodeUpload.attempt", `attempt ${s.attempts}`, { n: s.attempts }));
  }
  if (s.notBefore != null) {
    out.push(queueText(t, "queue.nodeUpload.notBefore", notBeforeText ?? "not before", { time: notBeforeText ?? "" }));
  }
  if (s.heartbeatAt != null) {
    out.push(queueText(t, "queue.nodeUpload.heartbeat", "heartbeat", {
      time: String(Math.max(0, Math.round((now - s.heartbeatAt) / 1000))),
    }));
  }
  return out;
}

/** Percent complete only when the backend supplied both byte counters. */
export function partChainProgressPct(s: PartChainUpload): number | null {
  const p = s.progress;
  if (!p || p.totalBytes <= 0) return null;
  return Math.min(100, Math.max(0, (p.doneBytes / p.totalBytes) * 100));
}

/** Fact-only freshness line: "polled Ns ago", never a stale/stopped verdict. */
export function partChainPolledAgo(s: PartChainUpload, t: TFunc, now: number): string {
  const seconds = String(Math.max(0, Math.round((now - s.polledAt) / 1000)));
  return queueText(t, "queue.nodeUpload.polledAgo", `status updated ${seconds}s ago`, { time: seconds });
}
