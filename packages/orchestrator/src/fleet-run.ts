/**
 * fleet-run.ts — route one node command through the fleet long connection (plans/042 Task 3).
 *
 * `SshTransport` calls this with the structured command (`cmd`, `args` after the data root) and an ssh
 * thunk. Order:
 *   1. status commands (`recording-status`, `disk`, `node-status`) from a fresh enough heartbeat;
 *   2. any other command the agent advertised, as a request over the connection;
 *   3. otherwise — or on disconnect, timeout, or a refusal (unknown command, foreign data root) — ssh.
 * Results keep ssh semantics: exit 0 resolves with stdout, anything else rejects. Every command routed here
 * is idempotent (status reads, apply-tasks with expectedVersion, jobId-keyed enqueue/cancel), so a request
 * whose reply was lost may safely be retried over ssh.
 */
import { FLEET_HEARTBEAT_PLAN, type FleetHeartbeatCommand } from "@drec/core";
import type { FleetLink } from "./fleet-hub.js";

const isHeartbeatCommand = (cmd: string): cmd is FleetHeartbeatCommand => cmd in FLEET_HEARTBEAT_PLAN;

function settle(r: { stdout: string; exitCode: number; error?: string }, cmd: string): string {
  if (r.exitCode === 0) return r.stdout;
  throw new Error(`fleet rc=${r.exitCode} (${cmd}): ${(r.error ?? r.stdout).slice(-1500)}`);
}

export async function runOverFleet(
  link: FleetLink | null,
  o: { nodeId: string; dataRoot: string; cmd: string; args: readonly string[]; timeoutMs: number },
  ssh: () => Promise<string>,
): Promise<string> {
  if (!link) return ssh();
  if (isHeartbeatCommand(o.cmd) && o.args.length === 0) {
    const hit = link.cached(o.nodeId, o.cmd, FLEET_HEARTBEAT_PLAN[o.cmd].maxAgeMs);
    if (hit) return settle(hit, o.cmd);
  }
  if (!link.supports(o.nodeId, o.cmd)) return ssh();
  let r;
  try {
    r = await link.request(o.nodeId, o.cmd, [o.dataRoot, ...o.args], o.timeoutMs);
  } catch {
    return ssh(); // disconnected / timed out: ssh is today's path
  }
  if (r.refused) return ssh(); // old agent without the command, or a misconfigured data root
  return settle(r, o.cmd);
}

/** Recording room slugs from a fresh heartbeat, or null when the master has to ask the node. */
export function cachedRecordingRooms(link: FleetLink | null, nodeId: string): ReadonlySet<string> | null {
  return link?.recordingRooms(nodeId, FLEET_HEARTBEAT_PLAN["recording-status"].maxAgeMs) ?? null;
}
