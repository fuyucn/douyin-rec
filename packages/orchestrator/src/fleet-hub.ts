/**
 * fleet-hub.ts — the master side of the `fleet/1` control plane (plans/042 Task 3).
 *
 * Workers' resident `task serve` dial in over WebSocket (see app/fleet-agent.ts). The hub keeps the latest
 * heartbeat per node (cached stdout of the cheap status commands) and relays requests. `SshTransport` asks
 * the hub first and falls back to ssh whenever the hub cannot answer, so a missing, old or disconnected
 * agent behaves exactly like today.
 *
 * Security: a node authenticates with its per-node token; the master stores only SHA-256 hashes in
 * `<root>/config/fleet-nodes.json` (read fresh on every hello, the file is the source of truth).
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  FLEET_CLOSE,
  FLEET_HEARTBEAT_COMMANDS,
  FLEET_IDLE_TIMEOUT_MS,
  FLEET_MAX_FRAME_BYTES,
  FLEET_PING_MS,
  FLEET_PROTOCOL,
  FLEET_ROUTE_FRESH_MS,
  FLEET_WS_PATH,
  parseFleetFrame,
  writeFileAtomicSync,
  type FleetCommandOutput,
  type FleetHeartbeatCommand,
  type FleetPing,
  type FleetRefusal,
  type FleetRequest,
  type FleetWelcome,
} from "@drec/core";

/** A node's reply to a request. */
export interface FleetReply {
  stdout: string;
  exitCode: number;
  /** The agent did not run the command; the caller should use ssh. */
  refused?: FleetRefusal;
  /** The command threw on the node. */
  error?: string;
}

/** What `SshTransport` needs from the hub (an interface so tests can fake it). */
export interface FleetLink {
  /** Node is connected, heard from recently (FLEET_ROUTE_FRESH_MS) and advertised this command. */
  supports(nodeId: string, cmd: string): boolean;
  /** Latest heartbeat output for a status command, or null if missing / older than maxAgeMs. */
  cached(nodeId: string, cmd: FleetHeartbeatCommand, maxAgeMs: number): FleetCommandOutput | null;
  /** Room slugs recording on the node per the latest `recording-status` heartbeat, or null if unknown / stale. */
  recordingRooms(nodeId: string, maxAgeMs: number): ReadonlySet<string> | null;
  /**
   * Room slugs still finalizing (tail upload) per the latest `recording-status` heartbeat. Null when unknown /
   * stale OR when the node's bundle predates the `finalizing` field: such a heartbeat cannot prove a room is done.
   */
  finalizingRooms(nodeId: string, maxAgeMs: number): ReadonlySet<string> | null;
  /** Run a node command over the connection. Rejects on disconnect / timeout (caller falls back to ssh). */
  request(nodeId: string, cmd: string, args: string[], timeoutMs: number): Promise<FleetReply>;
}

// ─── token store ──────────────────────────────────────────────────────────────

interface TokenFile {
  nodes: Record<string, { sha256: string }>;
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function readTokenFile(path: string): TokenFile {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<TokenFile>;
    return { nodes: v && typeof v.nodes === "object" && v.nodes ? v.nodes : {} };
  } catch {
    return { nodes: {} };
  }
}

/** A fresh random node token (plaintext; persist only its hash with {@link saveFleetToken}). */
export const newFleetToken = (): string => randomBytes(32).toString("hex");

/** Store `token`'s hash as the node's only valid token (replaces any previous one). Atomic, 0600. */
export function saveFleetToken(path: string, nodeId: string, token: string): void {
  const file = readTokenFile(path);
  file.nodes[nodeId] = { sha256: sha256(token) };
  mkdirSync(dirname(path), { recursive: true });
  writeFileAtomicSync(path, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
}

/** Constant-time check of a presented token against the stored hash. */
export function verifyFleetToken(path: string, nodeId: string, token: string): boolean {
  const entry = readTokenFile(path).nodes[nodeId];
  if (!entry || typeof token !== "string" || !token || typeof entry.sha256 !== "string") return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(entry.sha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── hub ──────────────────────────────────────────────────────────────────────

interface Conn {
  nodeId: string;
  ws: WebSocket;
  lastFrameAt: number;
  commands: Set<string>;
  outputs: Partial<Record<FleetHeartbeatCommand, FleetCommandOutput>>;
  /** Parsed once per `recording-status` heartbeat: the slugs, and an order-free identity for change detection. */
  rooms: { slugs: ReadonlySet<string>; finalizing: ReadonlySet<string> | null; key: string; at: number } | null;
  pending: Map<number, { resolve: (r: FleetReply) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface FleetHubOptions {
  verifyToken: (nodeId: string, token: string) => boolean;
  log?: (m: string) => void;
  now?: () => number;
  pingMs?: number;
  idleTimeoutMs?: number;
  routeFreshMs?: number;
  /** Called when a node's recording rooms change between heartbeats (lets the master refresh at once). */
  onRecordingChange?: (nodeId: string) => void;
}

export class FleetHub implements FleetLink {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: FLEET_MAX_FRAME_BYTES });
  private readonly conns = new Map<string, Conn>();
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly routeFreshMs: number;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private nextId = 1;

  constructor(private readonly o: FleetHubOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.idleTimeoutMs = o.idleTimeoutMs ?? FLEET_IDLE_TIMEOUT_MS;
    this.routeFreshMs = o.routeFreshMs ?? FLEET_ROUTE_FRESH_MS;
    this.pingTimer = setInterval(() => this.sweep(), o.pingMs ?? FLEET_PING_MS);
    this.pingTimer.unref?.();
  }

  /** Attach to an http server's `upgrade` event. Returns false for paths that are not the fleet route. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const path = (req.url ?? "").split("?")[0];
    if (path !== FLEET_WS_PATH) return false;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws));
    return true;
  }

  /** Node is connected and was heard from recently enough to route a request to it. */
  connected(nodeId: string): boolean {
    return this.live(nodeId) !== null;
  }

  supports(nodeId: string, cmd: string): boolean {
    return this.live(nodeId)?.commands.has(cmd) ?? false;
  }

  cached(nodeId: string, cmd: FleetHeartbeatCommand, maxAgeMs: number): FleetCommandOutput | null {
    const out = this.conns.get(nodeId)?.outputs[cmd];
    return out && this.now() - out.at <= maxAgeMs ? out : null;
  }

  recordingRooms(nodeId: string, maxAgeMs: number): ReadonlySet<string> | null {
    const rooms = this.conns.get(nodeId)?.rooms;
    return rooms && this.now() - rooms.at <= maxAgeMs ? rooms.slugs : null;
  }

  finalizingRooms(nodeId: string, maxAgeMs: number): ReadonlySet<string> | null {
    const rooms = this.conns.get(nodeId)?.rooms;
    return rooms && this.now() - rooms.at <= maxAgeMs ? rooms.finalizing : null;
  }

  request(nodeId: string, cmd: string, args: string[], timeoutMs: number): Promise<FleetReply> {
    const c = this.live(nodeId);
    if (!c) return Promise.reject(new Error(`fleet: ${nodeId} not connected`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`fleet: ${cmd} on ${nodeId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      c.pending.set(id, { resolve, reject, timer });
      c.ws.send(JSON.stringify({ t: "req", id, cmd, args } satisfies FleetRequest));
    });
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const c of [...this.conns.values()]) this.drop(c, 1001, "hub closed");
    this.wss.close();
  }

  private live(nodeId: string): Conn | null {
    const c = this.conns.get(nodeId);
    return c && this.now() - c.lastFrameAt <= this.routeFreshMs ? c : null;
  }

  private accept(ws: WebSocket): void {
    let conn: Conn | null = null;
    // An unauthenticated socket must say hello quickly or go away.
    const helloTimer = setTimeout(() => ws.close(FLEET_CLOSE.protocol), 10_000);
    helloTimer.unref?.();

    ws.on("message", (data) => {
      const frame = parseFleetFrame(String(data));
      if (!frame) return;
      if (!conn) {
        clearTimeout(helloTimer);
        if (frame.t !== "hello" || frame.protocol !== FLEET_PROTOCOL || typeof frame.nodeId !== "string") {
          ws.close(FLEET_CLOSE.protocol);
          return;
        }
        if (!this.o.verifyToken(frame.nodeId, typeof frame.token === "string" ? frame.token : "")) {
          this.log(`[fleet] rejected node ${frame.nodeId}: bad token`);
          ws.close(FLEET_CLOSE.unauthorized);
          return;
        }
        const nodeId = frame.nodeId;
        const prev = this.conns.get(nodeId);
        if (prev) this.drop(prev, FLEET_CLOSE.superseded, "superseded by a new connection");
        conn = {
          nodeId,
          ws,
          lastFrameAt: this.now(),
          commands: new Set(Array.isArray(frame.commands) ? frame.commands.filter((x): x is string => typeof x === "string") : []),
          outputs: {},
          rooms: null,
          pending: new Map(),
        };
        this.conns.set(nodeId, conn);
        ws.send(JSON.stringify({ t: "welcome", protocol: FLEET_PROTOCOL } satisfies FleetWelcome));
        this.log(`[fleet] node ${nodeId} connected (${String(frame.appVersion ?? "")})`);
        return;
      }
      conn.lastFrameAt = this.now();
      if (frame.t === "heartbeat" && frame.outputs && typeof frame.outputs === "object") {
        this.applyHeartbeat(conn, frame.outputs as Record<string, unknown>);
      } else if (frame.t === "res" && typeof frame.id === "number") {
        const p = conn.pending.get(frame.id);
        if (!p) return; // late reply after timeout
        conn.pending.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({
          stdout: typeof frame.stdout === "string" ? frame.stdout : "",
          exitCode: typeof frame.exitCode === "number" ? frame.exitCode : 1,
          ...(frame.refused === "unknown-command" || frame.refused === "data-root-mismatch" ? { refused: frame.refused } : {}),
          ...(typeof frame.error === "string" ? { error: frame.error } : {}),
        });
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (conn && this.conns.get(conn.nodeId) === conn) this.drop(conn, null, "disconnected");
    });
    ws.on("error", () => { /* close follows */ });
  }

  private applyHeartbeat(conn: Conn, outputs: Record<string, unknown>): void {
    const at = this.now(); // freshness by the master's clock: node clocks may drift, receipt time cannot
    for (const cmd of FLEET_HEARTBEAT_COMMANDS) {
      const o = outputs[cmd] as { stdout?: unknown; exitCode?: unknown } | undefined;
      if (!o || typeof o.stdout !== "string" || typeof o.exitCode !== "number") continue;
      conn.outputs[cmd] = { stdout: o.stdout, exitCode: o.exitCode, at };
      if (cmd === "recording-status") this.applyRooms(conn, o.stdout, o.exitCode, at);
    }
  }

  private applyRooms(conn: Conn, stdout: string, exitCode: number, at: number): void {
    const parsed = exitCode === 0 ? parseRecordingRooms(stdout) : null;
    if (!parsed) {
      conn.rooms = null; // unknown: callers fall back to asking
      return;
    }
    const finalizing = parseFinalizingRooms(stdout);
    const key = parsed.map((r) => `${r.platform}:${r.roomSlug}`).sort().join(",")
      + "|" + (finalizing ?? []).map((r) => `${r.platform}:${r.roomSlug}`).sort().join(",");
    const changed = conn.rooms !== null && conn.rooms.key !== key;
    conn.rooms = {
      slugs: new Set(parsed.map((r) => r.roomSlug)),
      finalizing: finalizing ? new Set(finalizing.map((r) => r.roomSlug)) : null,
      key,
      at,
    };
    if (changed) this.o.onRecordingChange?.(conn.nodeId);
  }

  /** Ping live connections; drop the ones that went silent (half-open links never close on their own). */
  private sweep(): void {
    const t = this.now();
    for (const c of [...this.conns.values()]) {
      if (t - c.lastFrameAt > this.idleTimeoutMs) {
        this.drop(c, 1001, "idle");
        continue;
      }
      c.ws.send(JSON.stringify({ t: "ping" } satisfies FleetPing));
    }
  }

  private drop(c: Conn, code: number | null, why: string): void {
    if (this.conns.get(c.nodeId) === c) this.conns.delete(c.nodeId);
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`fleet: ${c.nodeId} ${why}`));
    }
    c.pending.clear();
    if (code !== null) c.ws.close(code);
    this.log(`[fleet] node ${c.nodeId} ${why}`);
  }
}

/** The recording rooms in a `recording-status` stdout (rolling progress ignored), or null if it does not parse. */
export function parseRecordingRooms(stdout: string): Array<{ platform: string; roomSlug: string }> | null {
  try {
    const v = JSON.parse(stdout) as { rooms?: unknown };
    if (!Array.isArray(v.rooms)) return null;
    return v.rooms.map((r) => {
      const x = (r ?? {}) as { platform?: unknown; roomSlug?: unknown };
      return { platform: String(x.platform), roomSlug: String(x.roomSlug) };
    });
  } catch {
    return null;
  }
}

/**
 * The finalizing rooms in a `recording-status` stdout, or null when the field is absent / malformed (a node
 * bundle that predates it): callers must then not treat absence from `rooms` as "done".
 */
export function parseFinalizingRooms(stdout: string): Array<{ platform: string; roomSlug: string }> | null {
  try {
    const v = JSON.parse(stdout) as { finalizing?: unknown };
    if (!Array.isArray(v.finalizing)) return null;
    return v.finalizing.map((r) => {
      const x = (r ?? {}) as { platform?: unknown; roomSlug?: unknown };
      return { platform: String(x.platform), roomSlug: String(x.roomSlug) };
    });
  } catch {
    return null;
  }
}
