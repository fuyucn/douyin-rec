/**
 * 409 rules for `runNow` / `-N` re-submissions (plan 038 T17).
 *
 * The rule is keyed by the original broadcast key with any `-N` suffix removed, because `-N` jobs are separate
 * ledger rows for the same recording: a BV on `key` must stop `key-2` from posting a second draft.
 * Everything unknown fails closed (409). Only `force` passes, and a forced rerun logs the old BV.
 */
import type { UploadPlan } from "./node-upload-queue.js";
import { canFallbackToBlocking } from "./node-upload-config.js";
import type { SyncLedger } from "./ledger.js";
import type { Transport } from "./transport.js";

export interface RunNowGuardDeps {
  ledger: Pick<SyncLedger, "listKeys" | "get" | "getUploadPlan">;
  transports: Map<string, Transport>;
  log?: (m: string) => void;
}

/** True for `base` itself and for `base-<digits>` (a `-N` re-submission of the same recording). */
export function isSameBroadcast(key: string, baseKey: string): boolean {
  if (key === baseKey) return true;
  if (!key.startsWith(`${baseKey}-`)) return false;
  return /^\d+$/.test(key.slice(baseKey.length + 1));
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
  d: RunNowGuardDeps, baseKey: string, opts: { force: boolean },
): Promise<string | null> {
  const keys = d.ledger.listKeys().map((k) => k.streamKey).filter((k) => isSameBroadcast(k, baseKey));
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
