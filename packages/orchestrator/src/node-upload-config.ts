/**
 * nodeUpload config + the queue/blocking decision (plan 038 T13).
 *
 * Everything here fails closed toward the existing blocking path: queue mode needs an explicit opt-in AND
 * every safety condition below, and any value we cannot confirm counts as "not safe".
 */
import { BILIUP_QUEUE_CAPABILITY, type ProcessReceipt } from "@drec/core";
import { ProcUnsupported, type Transport } from "./transport.js";

/** Capability a node advertises once stall death, deploy guard and the -N gate are all in place (T15). */
export const QUEUE_CAPABILITY = BILIUP_QUEUE_CAPABILITY;

export interface NodeUploadConfig {
  mode: "blocking" | "queue";
  /** How often the master polls each node's queue (ms). */
  pollMs: number;
  /** Warn once when a node has been unreachable for this long (ms). */
  unreachableAlertMs: number;
  /** Default biliup concurrency per node; the node's own setting wins. */
  concurrency: number;
}

export const DEFAULT_NODE_UPLOAD: Readonly<NodeUploadConfig> = {
  mode: "blocking",
  pollMs: 60_000,
  unreachableAlertMs: 10 * 60_000,
  concurrency: 1,
};

const posInt = (v: unknown, fallback: number, min = 1): number =>
  typeof v === "number" && Number.isFinite(v) && Math.floor(v) >= min ? Math.floor(v) : fallback;

/** Parse `hub.config.json#nodeUpload`. Missing or malformed values fall back to the safe defaults. */
export function parseNodeUploadConfig(raw: unknown): NodeUploadConfig {
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    // Only the exact string "queue" opts in; anything else (typos included) stays blocking.
    mode: o.mode === "queue" ? "queue" : "blocking",
    pollMs: posInt(o.pollMs, DEFAULT_NODE_UPLOAD.pollMs, 5_000),
    unreachableAlertMs: posInt(o.unreachableAlertMs, DEFAULT_NODE_UPLOAD.unreachableAlertMs, 1_000),
    concurrency: posInt(o.concurrency, DEFAULT_NODE_UPLOAD.concurrency),
  };
}

export interface QueueGateInput {
  cfg: NodeUploadConfig;
  /** Processor kinds / capability strings reported by `_node-capabilities`. */
  capabilities?: readonly string[];
  /** Number of tasks on the node with rolling upload enabled; null/undefined = could not be determined. */
  rollingEnabledCount?: number | null;
  /** True only once the `-N`/runNow 409 gate exists (T17); without it a manual rerun could double-post. */
  runNowGuard: boolean;
}

export type UploadModeDecision = { mode: "queue" } | { mode: "blocking"; reason: string };

/** Pure decision: queue only when explicitly configured and every precondition is confirmed. */
export function decideUploadMode(i: QueueGateInput): UploadModeDecision {
  const no = (reason: string): UploadModeDecision => ({ mode: "blocking", reason });
  if (i.cfg.mode !== "queue") return no("nodeUpload.mode is blocking (default)");
  if (!i.capabilities?.includes(QUEUE_CAPABILITY)) return no(`node does not advertise ${QUEUE_CAPABILITY}`);
  if (i.rollingEnabledCount == null) return no("could not confirm whether rolling upload is enabled on the node");
  if (i.rollingEnabledCount > 0) return no(`${i.rollingEnabledCount} task(s) on the node use rolling upload`);
  if (!i.runNowGuard) return no("the -N/runNow 409 gate is not in place");
  return { mode: "queue" };
}

/**
 * How many tasks on the node have rolling upload enabled, read from the node's task list (config, not a
 * snapshot of what is recording right now: a disabled task can be started by the schedule at any minute).
 * null = unknown (no channel, node unreachable, or an old bundle whose DTO has no rolling fields).
 */
export async function rollingEnabledCount(t: Transport): Promise<number | null> {
  if (!t.listTasks) return null;
  try {
    const { tasks } = await t.listTasks();
    if (tasks.some((x) => typeof x.rollingEffective !== "boolean" && typeof x.rollingUpload !== "boolean")) return null;
    return tasks.filter((x) => x.rollingEffective === true || x.rollingUpload === true).length;
  } catch {
    return null;
  }
}

const BLOCKING_STATES: ReadonlySet<ProcessReceipt["state"]> = new Set(["pending", "running", "uncertain"]);

/**
 * May this order fall back to the blocking path? Refused while any of its queue rows is pending, running or
 * uncertain (uncertain is terminal in proc-queue but the outcome is unknown), and whenever the node cannot be
 * asked: an unknown queue state must never be treated as an empty queue.
 */
export async function canFallbackToBlocking(
  t: Transport, ids: readonly string[],
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!t.procStatus) return { ok: false, reason: "node has no status channel; queue state unknown" };
  let receipts: ProcessReceipt[];
  try {
    receipts = await t.procStatus([...ids]);
  } catch (e) {
    const why = e instanceof ProcUnsupported ? "node does not support queue status" : `node unreachable (${(e as Error).message})`;
    return { ok: false, reason: `${why}; queue state unknown` };
  }
  const open = receipts.filter((r) => BLOCKING_STATES.has(r.state));
  if (open.length === 0) return { ok: true };
  return { ok: false, reason: `queue rows still ${[...new Set(open.map((r) => r.state))].join("/")}: ${open.map((r) => r.jobId).join(", ")}` };
}
