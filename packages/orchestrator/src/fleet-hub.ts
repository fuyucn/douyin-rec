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
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
  FLEET_WS_PATH,
  parseFleetFrame,
  type FleetCommandOutput,
  type FleetHeartbeatCommand,
} from "@drec/core";

/** What `SshTransport` needs from the hub (an interface so tests can fake it). */
export interface FleetLink {
  /** Node is connected, authenticated and answering. */
  connected(nodeId: string): boolean;
  /** Node's agent advertised this command. */
  supports(nodeId: string, cmd: string): boolean;
  /** Latest heartbeat output for a status command, or null if missing / older than maxAgeMs. */
  cached(nodeId: string, cmd: FleetHeartbeatCommand, maxAgeMs: number): FleetCommandOutput | null;
  /** Run a node command over the connection. Rejects on disconnect / timeout (caller falls back to ssh). */
  request(nodeId: string, cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number; error?: string }>;
}

export interface FleetNodeState {
  nodeId: string;
  appVersion: string;
  connectedAt: number;
  lastFrameAt: number;
  lastHeartbeatAt: number | null;
}

// ─── token store ──────────────────────────────────────────────────────────────

interface TokenFile {
  nodes: Record<string, { sha256: string; issuedAt: number }>;
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

/** Issue (or rotate) a node's token; returns the plaintext once — only its hash is stored. */
export function issueFleetToken(path: string, nodeId: string, now = Date.now()): string {
  const token = randomBytes(32).toString("hex");
  const file = readTokenFile(path);
  file.nodes[nodeId] = { sha256: sha256(token), issuedAt: now };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return token;
}

/** Constant-time check of a presented token against the stored hash. */
export function verifyFleetToken(path: string, nodeId: string, token: string): boolean {
  const entry = readTokenFile(path).nodes[nodeId];
  if (!entry || typeof token !== "string" || !token) return false;
  const a = Buffer.from(sha256(token), "hex");
  const b = Buffer.from(entry.sha256, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── hub ──────────────────────────────────────────────────────────────────────

interface Conn {
  ws: WebSocket;
  state: FleetNodeState;
  commands: Set<string>;
  outputs: Partial<Record<FleetHeartbeatCommand, FleetCommandOutput>>;
  pending: Map<number, { resolve: (r: { stdout: string; exitCode: number; error?: string }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>;
}

export interface FleetHubOptions {
  verifyToken: (nodeId: string, token: string) => boolean;
  log?: (m: string) => void;
  now?: () => number;
  pingMs?: number;
  idleTimeoutMs?: number;
  /** Called when a node's recording rooms change between heartbeats (lets the master reconcile at once). */
  onRecordingChange?: (nodeId: string) => void;
}

export class FleetHub implements FleetLink {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: FLEET_MAX_FRAME_BYTES });
  private readonly conns = new Map<string, Conn>();
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private readonly idleTimeoutMs: number;
  private readonly pingTimer: ReturnType<typeof setInterval>;
  private nextId = 1;

  constructor(private readonly o: FleetHubOptions) {
    this.log = o.log ?? (() => {});
    this.now = o.now ?? Date.now;
    this.idleTimeoutMs = o.idleTimeoutMs ?? FLEET_IDLE_TIMEOUT_MS;
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

  connected(nodeId: string): boolean {
    return this.conns.has(nodeId);
  }

  supports(nodeId: string, cmd: string): boolean {
    return this.conns.get(nodeId)?.commands.has(cmd) ?? false;
  }

  cached(nodeId: string, cmd: FleetHeartbeatCommand, maxAgeMs: number): FleetCommandOutput | null {
    const out = this.conns.get(nodeId)?.outputs[cmd];
    return out && this.now() - out.at <= maxAgeMs ? out : null;
  }

  request(nodeId: string, cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; exitCode: number; error?: string }> {
    const c = this.conns.get(nodeId);
    if (!c) return Promise.reject(new Error(`fleet: ${nodeId} not connected`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        c.pending.delete(id);
        reject(new Error(`fleet: ${cmd} on ${nodeId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      c.pending.set(id, { resolve, reject, timer });
      c.ws.send(JSON.stringify({ t: "req", id, cmd, args }));
    });
  }

  nodes(): FleetNodeState[] {
    return [...this.conns.values()].map((c) => ({ ...c.state }));
  }

  close(): void {
    clearInterval(this.pingTimer);
    for (const c of this.conns.values()) c.ws.close(1001);
    this.conns.clear();
    this.wss.close();
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
        const t = this.now();
        conn = {
          ws,
          state: { nodeId, appVersion: String(frame.appVersion ?? ""), connectedAt: t, lastFrameAt: t, lastHeartbeatAt: null },
          commands: new Set(Array.isArray(frame.commands) ? frame.commands.filter((x): x is string => typeof x === "string") : []),
          outputs: {},
          pending: new Map(),
        };
        this.conns.set(nodeId, conn);
        ws.send(JSON.stringify({ t: "welcome", protocol: FLEET_PROTOCOL }));
        this.log(`[fleet] node ${nodeId} connected (${conn.state.appVersion})`);
        return;
      }
      conn.state.lastFrameAt = this.now();
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
          ...(typeof frame.error === "string" ? { error: frame.error } : {}),
        });
      }
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (conn && this.conns.get(conn.state.nodeId) === conn) this.drop(conn, null, "disconnected");
    });
    ws.on("error", () => { /* close follows */ });
  }

  private applyHeartbeat(conn: Conn, outputs: Record<string, unknown>): void {
    const prevRooms = conn.outputs["recording-status"]?.stdout;
    for (const cmd of FLEET_HEARTBEAT_COMMANDS) {
      const o = outputs[cmd] as Partial<FleetCommandOutput> | undefined;
      if (!o || typeof o.stdout !== "string" || typeof o.exitCode !== "number" || typeof o.at !== "number") continue;
      // Freshness is judged by the master's clock: node clocks may drift, receipt time cannot.
      conn.outputs[cmd] = { stdout: o.stdout, exitCode: o.exitCode, at: this.now() };
    }
    conn.state.lastHeartbeatAt = this.now();
    const nextRooms = conn.outputs["recording-status"]?.stdout;
    if (prevRooms !== undefined && nextRooms !== undefined && roomsKey(prevRooms) !== roomsKey(nextRooms)) {
      this.o.onRecordingChange?.(conn.state.nodeId);
    }
  }

  /** Ping live connections; drop the ones that went silent (half-open links never close on their own). */
  private sweep(): void {
    const t = this.now();
    for (const c of [...this.conns.values()]) {
      if (t - c.state.lastFrameAt > this.idleTimeoutMs) {
        this.drop(c, 1001, "idle");
        continue;
      }
      c.ws.send(JSON.stringify({ t: "ping" }));
    }
  }

  private drop(c: Conn, code: number | null, why: string): void {
    if (this.conns.get(c.state.nodeId) === c) this.conns.delete(c.state.nodeId);
    for (const p of c.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`fleet: ${c.state.nodeId} ${why}`));
    }
    c.pending.clear();
    if (code !== null) c.ws.close(code);
    this.log(`[fleet] node ${c.state.nodeId} ${why}`);
  }
}

/** Order-insensitive identity of the recording rooms in a `recording-status` stdout (rolling progress ignored). */
function roomsKey(stdout: string): string {
  try {
    const v = JSON.parse(stdout) as { rooms?: Array<{ platform?: string; roomSlug?: string }> };
    return (v.rooms ?? []).map((r) => `${r.platform}:${r.roomSlug}`).sort().join(",");
  } catch {
    return stdout;
  }
}

// ─── process-wide link (set by the master at hub start) ───────────────────────

let activeLink: FleetLink | null = null;

/** The master registers its hub once; every `SshTransport` built afterwards consults it. */
export function setFleetLink(link: FleetLink | null): void {
  activeLink = link;
}

export function getFleetLink(): FleetLink | null {
  return activeLink;
}
