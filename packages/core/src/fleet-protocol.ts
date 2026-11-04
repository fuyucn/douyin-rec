/**
 * fleet-protocol.ts — the master ↔ worker control-plane protocol `fleet/1` (plans/042).
 *
 * A worker's resident `task serve` dials out to the master over WebSocket (tailscale network) and keeps
 * one connection. Everything the master used to learn by spawning `node … _<cmd>` over ssh now flows here:
 *   - heartbeat: cached stdout of the cheap status commands, so status polls need no round trip at all;
 *   - req/res:   any node command, answered by the same registry the hidden CLI commands use.
 * Payloads carry the commands' stdout verbatim, so the master parses them with its existing ssh parsers.
 *
 * Pure types + codec helpers only (no IO): shared by the node agent (app) and the master hub (orchestrator).
 */

export const FLEET_PROTOCOL = 1;
/** Master route the agent dials (HTTP upgrade). */
export const FLEET_WS_PATH = "/api/fleet/ws";
/** Largest frame either side accepts (an inventory of a busy node fits comfortably). */
export const FLEET_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Agent heartbeat cadence. */
export const FLEET_HEARTBEAT_MS = 10_000;
/** Master application-level ping cadence (the browser-style WebSocket client cannot see protocol pings). */
export const FLEET_PING_MS = 15_000;
/** Either side treats a connection with no frame for this long as dead. */
export const FLEET_IDLE_TIMEOUT_MS = 45_000;
/**
 * The master only routes requests to a node heard from within this window (a live agent sends a heartbeat
 * every FLEET_HEARTBEAT_MS). A half-open link stops producing frames long before FLEET_IDLE_TIMEOUT_MS
 * drops it; without this, requests in that gap would each wait out their full timeout before falling back.
 */
export const FLEET_ROUTE_FRESH_MS = 25_000;
/** A heartbeat command that has not settled after this long is skipped for that heartbeat. */
export const FLEET_HEARTBEAT_COMMAND_TIMEOUT_MS = 20_000;

/** Close codes (4000–4999 is the application range). */
export const FLEET_CLOSE = Object.freeze({
  /** Bad token / unknown node: the agent backs off for FLEET_UNAUTHORIZED_BACKOFF_MS. */
  unauthorized: 4401,
  /** A newer connection for the same node replaced this one. */
  superseded: 4409,
  /** Protocol version mismatch or malformed frame. */
  protocol: 4400,
});
/** Agent backoff after `unauthorized` or `protocol` (retrying sooner cannot succeed). */
export const FLEET_UNAUTHORIZED_BACKOFF_MS = 10 * 60_000;
export const FLEET_SUPERSEDED_BACKOFF_MS = 30_000;

/** Commands whose stdout rides on heartbeats (cheap, polled constantly by the master). */
export const FLEET_HEARTBEAT_COMMANDS = ["recording-status", "disk", "node-status"] as const;
export type FleetHeartbeatCommand = (typeof FLEET_HEARTBEAT_COMMANDS)[number];

/**
 * Per command: how often the agent refreshes it (`everyMs`) and how old a cached value the master still
 * answers polls with (`maxAgeMs`). One table so the two sides cannot drift: maxAgeMs must stay above
 * everyMs plus one heartbeat of slack, or the master would ask over the connection between refreshes.
 * Only recording state changes quickly; node-status opens two sqlite databases, disk changes slowly.
 */
export const FLEET_HEARTBEAT_PLAN: Readonly<Record<FleetHeartbeatCommand, { everyMs: number; maxAgeMs: number }>> = Object.freeze({
  "recording-status": { everyMs: 10_000, maxAgeMs: 15_000 },
  "node-status": { everyMs: 30_000, maxAgeMs: 45_000 },
  disk: { everyMs: 60_000, maxAgeMs: 120_000 },
});

/** One command's result as the hidden CLI command would print it. */
export interface FleetCommandResult {
  stdout: string;
  exitCode: number;
}

/** A cached heartbeat value on the master, stamped with the master's receipt time. */
export interface FleetCommandOutput extends FleetCommandResult {
  at: number;
}

export interface FleetHello {
  t: "hello";
  protocol: number;
  nodeId: string;
  token: string;
  appVersion: string;
  /** Node command names this agent can answer over `req`. */
  commands: string[];
}

export interface FleetHeartbeat {
  t: "heartbeat";
  /** Only the commands refreshed this time; the master keeps the others. */
  outputs: Partial<Record<FleetHeartbeatCommand, FleetCommandResult>>;
}

export interface FleetRequest {
  t: "req";
  id: number;
  cmd: string;
  /** Full argv after the command name, starting with the master's view of `<dataRoot>`. */
  args: string[];
}

/**
 * Why an agent declined to run a request. The master then uses ssh: an old bundle (unknown command) or a
 * misconfigured worker (data root mismatch) is exactly what the ssh path already handles.
 */
export type FleetRefusal = "unknown-command" | "data-root-mismatch";

export interface FleetResponse extends FleetCommandResult {
  t: "res";
  id: number;
  /** The agent did not run the command (see FleetRefusal); stdout/exitCode carry no meaning. */
  refused?: FleetRefusal;
  /** The command threw instead of returning (exitCode 1); the message, for the master's error. */
  error?: string;
}

export interface FleetWelcome {
  t: "welcome";
  protocol: number;
}

export interface FleetPing {
  t: "ping";
}

export type FleetNodeFrame = FleetHello | FleetHeartbeat | FleetResponse;
export type FleetMasterFrame = FleetWelcome | FleetRequest | FleetPing;

/** Parse one text frame; returns null for anything that is not a well-formed object with a string `t`. */
export function parseFleetFrame(text: string): { t: string; [k: string]: unknown } | null {
  if (text.length > FLEET_MAX_FRAME_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const t = (v as { t?: unknown }).t;
  return typeof t === "string" ? (v as { t: string }) : null;
}
