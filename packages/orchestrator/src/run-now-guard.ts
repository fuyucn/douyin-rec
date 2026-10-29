/**
 * 409 rules for `runNow` / `-N` re-submissions (plan 038 T17).
 *
 * The rule is keyed by the original broadcast key with any `-N` suffix removed, because `-N` jobs are separate
 * ledger rows for the same recording: a BV on `key` must stop `key-2` from posting a second draft.
 * The family also covers same-day `_HHMM` siblings that are not provably a separate broadcast (gap > 60 min), so
 * a derived job of the same broadcast (issue #292) is bound by the base key's BV. Everything unknown fails closed (409). Only `force` passes, and a forced rerun logs the old BV.
 */
import { SAME_BROADCAST_GAP_MS } from "@drec/core";
import type { UploadPlan } from "./node-upload-queue.js";
import { canFallbackToBlocking } from "./node-upload-config.js";
import type { SyncLedger } from "./ledger.js";
import type { Transport } from "./transport.js";

export interface RunNowGuardDeps {
  ledger: Pick<SyncLedger, "listKeys" | "get" | "getUploadPlan" | "getCandidates">;
  transports: Map<string, Transport>;
  log?: (m: string) => void;
}

/** True for `base` itself and for `base-<digits>` (a `-N` re-submission of the same recording). */
export function isSameBroadcast(key: string, baseKey: string): boolean {
  if (key === baseKey) return true;
  if (!key.startsWith(`${baseKey}-`)) return false;
  return /^\d+$/.test(key.slice(baseKey.length + 1));
}

const DAY_FAMILY_RE = /^(.+:\d{4}-\d{2}-\d{2})(_\d{4})?(-\d+)?$/;

/** True for a `_HHMM` key, i.e. a second cluster of the same room and day (a new broadcast or a drifted start). */
export function isDerivedKey(key: string): boolean {
  return DAY_FAMILY_RE.exec(key)?.[2] != null;
}

/**
 * Same-day sibling keys of `key` (`base`, `base_HHMM`, with any `-N`) that are NOT provably a separate broadcast.
 * Provably separate = both time spans are known and the gap between them is > SAME_BROADCAST_GAP_MS. Anything
 * unknown (no candidate rows, no span for this broadcast) counts as the same broadcast: uncertain means manual.
 */
function sameBroadcastSiblings(
  d: RunNowGuardDeps, key: string, self: { startMs?: number; endMs?: number } | undefined,
): string[] {
  const family = DAY_FAMILY_RE.exec(key);
  if (!family) return [];
  const spanOf = (k: string): { start: number; end: number } | null => {
    const c = d.ledger.getCandidates(k);
    if (c.length === 0) return null;
    return { start: Math.min(...c.map((x) => x.startMs)), end: Math.max(...c.map((x) => x.endMs)) };
  };
  const mine = self?.startMs != null && self.endMs != null && self.endMs >= self.startMs
    ? { start: self.startMs, end: self.endMs }
    : spanOf(key);
  return d.ledger.listKeys().map((k) => k.streamKey).filter((k) => {
    if (k === key || DAY_FAMILY_RE.exec(k)?.[1] !== family[1]) return false;
    const other = spanOf(k);
    if (!mine || !other) return true;
    const gap = Math.max(mine.start - other.end, other.start - mine.end);
    return gap <= SAME_BROADCAST_GAP_MS;
  });
}

function planIds(json: string): { nodeId: string; ids: string[] } | null {
  try {
    const p = JSON.parse(json) as Partial<UploadPlan>;
    if (typeof p.nodeId !== "string" || typeof p.prepJobId !== "string" || typeof p.biliupJobId !== "string") return null;
    return { nodeId: p.nodeId, ids: [p.prepJobId, p.biliupJobId] };
  } catch {
    return null;
  }
}

/** Returns the 409 message, or null when the rerun may proceed. */
export async function runNowConflict(
  d: RunNowGuardDeps, baseKey: string, opts: { force: boolean; self?: { startMs?: number; endMs?: number } },
): Promise<string | null> {
  const keys = [...new Set([
    ...d.ledger.listKeys().map((k) => k.streamKey).filter((k) => isSameBroadcast(k, baseKey)),
    ...sameBroadcastSiblings(d, baseKey, opts.self),
  ])];
  const reasons: string[] = [];
  for (const key of keys) {
    const bv = d.ledger.get(key)?.bv;
    if (bv) reasons.push(`${key} already has BV ${bv}`);
    const raw = d.ledger.getUploadPlan(key);
    if (raw == null) continue;
    const plan = planIds(raw);
    const t = plan ? d.transports.get(plan.nodeId) : undefined;
    if (!plan || !t) { reasons.push(`${key} has a queued upload whose node state cannot be read`); continue; }
    const r = await canFallbackToBlocking(t, plan.ids);
    if (!r.ok) reasons.push(`${key}: ${r.reason}`);
  }
  if (reasons.length === 0) return null;
  if (opts.force) {
    d.log?.(`[runNow] force over: ${reasons.join("; ")}`);
    return null;
  }
  return `rerun refused: ${reasons.join("; ")}. Rerun with force only after deleting the old draft, or when resuming it on purpose.`;
}
