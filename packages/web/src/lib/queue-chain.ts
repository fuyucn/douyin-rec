/**
 * queue-chain.ts — presentation facts for the per-part upload chain (plan 046 PR8).
 *
 * Everything here is derived from fields the backend already sends. Nothing infers "stuck",
 * "failed" or "retried" from a phase or step: labels are either backend values or dictionary
 * lookups, and a missing dictionary key falls back to the raw backend string.
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
  state: string;
  nodeUpload?: { phase: string } | null;
  doneSteps?: ReadonlyArray<{ step: string; phase: string }>;
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
  if (item.nodeUpload?.phase === "part-chain") {
    out.push({ kind: "part-chain", label: queueText(t, "queue.nodeUpload.partChain", "part chain") });
  }
  if (item.state === "reconciling") {
    out.push({
      kind: "reconciling",
      label: queueText(t, "queue.phase.reconciling", "reconciling"),
      title: queueText(t, "queue.phase.reconcilingTip", "Automatic reconciliation in progress; this is not a failure. Time box: 24 hours."),
    });
  }
  return out;
}

/** Skipped ledger steps stay visible in the flow as their own badges. */
export function skippedStepBadges(
  item: QueueChainItem,
  t: TFunc,
): Array<{ key: string; step: string; label: string }> {
  const skipped = queueText(t, "room.runtime.stageState.skipped", "skipped");
  const rows = (item.doneSteps ?? [])
    .filter((step) => step.phase === "skipped")
    .map((step, index) => ({
      // A step can repeat across sessions; the index keeps the React key unique.
      key: `${step.step}-${index}`,
      step: stepLabel(t, step.step),
      label: skipped,
    }));
  if (rows.length === 0 && item.state === "skipped") {
    rows.push({ key: "state-skipped", step: "", label: skipped });
  }
  return rows;
}

/** Fields for one part-chain observation, in a fixed operator-facing order. */
export function partChainFields(
  s: PartChainUpload,
  t: TFunc,
  notBeforeText: string | null,
  now: number,
): string[] {
  const out: string[] = [];
  if (s.state) out.push(s.state);
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
