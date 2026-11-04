/**
 * fleet-run.ts — route `SshTransport`'s node commands through the fleet long connection (plans/042 Task 3).
 *
 * `SshTransport` speaks in shell command lines (`node <root>/dist/douyin-rec.mjs _disk <root>`). This wrapper
 * recognises those lines and answers them without spawning anything on the node:
 *   1. status commands (`_recording-status`, `_disk`, `_node-status`, `_is-done`) from the latest heartbeat;
 *   2. any other command the agent advertised, as a request over the connection;
 *   3. otherwise — or on disconnect, timeout, unknown command, data-root mismatch — the original ssh call.
 * Results keep ssh semantics: exit 0 resolves with stdout, anything else rejects. Every command routed here
 * is idempotent (status reads, apply-tasks with expectedVersion, jobId-keyed enqueue/cancel), so a request
 * whose reply was lost may safely be retried over ssh.
 */
import { FLEET_UNKNOWN_COMMAND_EXIT, type FleetHeartbeatCommand } from "@drec/core";
import type { FleetLink } from "./fleet-hub.js";

/** How old a heartbeat value may be and still answer a poll (heartbeats arrive every 10s). */
export const FLEET_CACHE_MAX_AGE_MS: Readonly<Record<FleetHeartbeatCommand, number>> = Object.freeze({
  "recording-status": 15_000,
  "node-status": 30_000,
  disk: 120_000,
});

/** Parse `<nodePrefix> _<cmd> <args…>` into the registry name and argv (args start with the data root). */
export function parseNodeCommand(line: string, nodePrefix: string): { cmd: string; args: string[] } | null {
  const head = `${nodePrefix} _`;
  if (!line.startsWith(head)) return null;
  // A plain single-quoted word ('slug') is how SshTransport quotes room slugs; unquote that one form only.
  const words = line.slice(head.length).split(" ").filter(Boolean).map((w) => (/^'[^']*'$/.test(w) ? w.slice(1, -1) : w));
  const [cmd, ...args] = words;
  // Shell metacharacters mean the line relies on the remote shell; leave it to ssh.
  if (!cmd || /[^a-z0-9-]/.test(cmd) || args.some((a) => /["'`$\\|;&<>()]/.test(a))) return null;
  return { cmd, args };
}

const isHeartbeatCommand = (cmd: string): cmd is FleetHeartbeatCommand => cmd in FLEET_CACHE_MAX_AGE_MS;

function settle(r: { stdout: string; exitCode: number; error?: string }, cmd: string): string {
  if (r.exitCode === 0) return r.stdout;
  throw new Error(`fleet rc=${r.exitCode} (${cmd}): ${(r.error ?? r.stdout).slice(-1500)}`);
}

export function withFleet(
  ssh: (argv: string[]) => Promise<string>,
  o: { nodeId: string; nodePrefix: string; link: () => FleetLink | null; timeoutMs: number },
): (argv: string[]) => Promise<string> {
  return async (argv) => {
    const link = o.link();
    const parsed = link && argv.length === 1 ? parseNodeCommand(argv[0], o.nodePrefix) : null;
    if (!link || !parsed) return ssh(argv);
    const { cmd, args } = parsed;

    if (isHeartbeatCommand(cmd) && args.length === 1) {
      const hit = link.cached(o.nodeId, cmd, FLEET_CACHE_MAX_AGE_MS[cmd]);
      if (hit) return settle(hit, cmd);
    }
    if (cmd === "is-done" && args.length === 2) {
      const hit = link.cached(o.nodeId, "recording-status", FLEET_CACHE_MAX_AGE_MS["recording-status"]);
      const rooms = hit && hit.exitCode === 0 ? recordingRooms(hit.stdout) : null;
      if (rooms) return (rooms.includes(args[1]) ? "false" : "true") + "\n";
    }

    if (!link.connected(o.nodeId) || !link.supports(o.nodeId, cmd)) return ssh(argv);
    let r: { stdout: string; exitCode: number; error?: string };
    try {
      r = await link.request(o.nodeId, cmd, args, o.timeoutMs);
    } catch {
      return ssh(argv); // disconnected / timed out: ssh is today's path
    }
    // The agent could not run it at all (unknown command, foreign data root): let ssh decide.
    if (r.error !== undefined && (r.exitCode === FLEET_UNKNOWN_COMMAND_EXIT || r.exitCode === 2)) return ssh(argv);
    return settle(r, cmd);
  };
}

/** Room slugs in a `recording-status` stdout, or null if it does not parse. */
function recordingRooms(stdout: string): string[] | null {
  try {
    const v = JSON.parse(stdout) as { rooms?: Array<{ roomSlug?: unknown }> };
    if (!Array.isArray(v.rooms)) return null;
    return v.rooms.map((r) => String(r.roomSlug));
  } catch {
    return null;
  }
}
