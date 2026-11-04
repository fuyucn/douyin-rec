/**
 * fleet-agent.ts — the worker side of the `fleet/1` control plane (plans/042 Task 2).
 *
 * Runs inside the resident `task serve` of a worker (never on the master). It dials out to the master over
 * WebSocket and keeps one connection, so the master no longer spawns `node … _<cmd>` over ssh for every
 * question (measured ~28 node processes/minute on an E2.1.Micro worker, ~0.4 vCPU sustained):
 *   - every FLEET_HEARTBEAT_MS it runs the cheap status commands in-process and pushes their stdout;
 *   - it answers `req` frames with the same command registry the hidden CLI commands use.
 *
 * Failure policy: the agent never takes the serve down. Any connection problem only means the master falls
 * back to ssh, which is exactly today's behaviour.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  FLEET_CLOSE,
  FLEET_HEARTBEAT_COMMANDS,
  FLEET_HEARTBEAT_MS,
  FLEET_IDLE_TIMEOUT_MS,
  FLEET_PROTOCOL,
  FLEET_SUPERSEDED_BACKOFF_MS,
  FLEET_UNAUTHORIZED_BACKOFF_MS,
  FLEET_UNKNOWN_COMMAND_EXIT,
  FLEET_WS_PATH,
  parseFleetFrame,
  type FleetCommandOutput,
  type FleetHeartbeat,
  type FleetHeartbeatCommand,
  type FleetHello,
  type FleetResponse,
} from "@drec/core";

/** Same shape as the CLI node command registry (cli/node-commands.ts), injected to respect layering. */
export type FleetNodeCommand = (dataRoot: string, args: string[]) => Promise<{ stdout: string; exitCode: number }>;

/** `<root>/config/fleet.json`, written by the master through `_fleet-join` (mode 0600). */
export interface FleetAgentConfig {
  /** Master base URL, e.g. `http://<master-tailscale-ip>:7860`. */
  controllerUrl: string;
  nodeId: string;
  token: string;
}

/** Read and validate the agent config; null when absent or malformed (= agent stays off). */
export function readFleetConfig(path: string): FleetAgentConfig | null {
  try {
    const v = JSON.parse(readFileSync(path, "utf8")) as Partial<FleetAgentConfig>;
    if (typeof v.controllerUrl !== "string" || typeof v.nodeId !== "string" || typeof v.token !== "string") return null;
    if (!/^https?:\/\//.test(v.controllerUrl) || !v.nodeId || !v.token) return null;
    return { controllerUrl: v.controllerUrl, nodeId: v.nodeId, token: v.token };
  } catch {
    return null;
  }
}

/**
 * Validate and persist the agent config (written by `_fleet-join` on behalf of the master).
 * Atomic (tmp + rename) and 0600: the token authenticates this node to the master.
 */
export function writeFleetConfig(path: string, input: unknown): FleetAgentConfig {
  const v = (input ?? {}) as Partial<FleetAgentConfig>;
  if (typeof v.controllerUrl !== "string" || !/^https?:\/\//.test(v.controllerUrl)) throw new Error("controllerUrl must be an http(s) URL");
  if (typeof v.nodeId !== "string" || !v.nodeId) throw new Error("nodeId missing");
  if (typeof v.token !== "string" || v.token.length < 32) throw new Error("token missing or too short");
  const cfg: FleetAgentConfig = { controllerUrl: v.controllerUrl, nodeId: v.nodeId, token: v.token };
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return cfg;
}

/** `http://host:port` → `ws://host:port/api/fleet/ws` (https → wss). */
export function fleetSocketUrl(controllerUrl: string): string {
  const u = new URL(FLEET_WS_PATH, controllerUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
}

/** Reconnect delay after the n-th consecutive failure (0-based): 1s, 2s, 4s … capped at 30s. */
export function fleetBackoffMs(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
}

export interface FleetAgentOptions {
  config: FleetAgentConfig;
  /** This node's data root; requests naming another root are refused. */
  dataRoot: string;
  appVersion: string;
  commands: Readonly<Record<string, FleetNodeCommand>>;
  log?: (m: string) => void;
  /** Injectable for tests; defaults to the Node 24 global WebSocket. */
  WebSocketImpl?: typeof WebSocket;
  heartbeatMs?: number;
  idleTimeoutMs?: number;
  now?: () => number;
}

export interface FleetAgent {
  /** Push a heartbeat now (e.g. a recording started or ended) instead of waiting for the next tick. */
  triggerHeartbeat(): void;
  /** Whether the connection is open and welcomed. */
  connected(): boolean;
  stop(): void;
}

export function startFleetAgent(o: FleetAgentOptions): FleetAgent {
  const WS = o.WebSocketImpl ?? globalThis.WebSocket;
  const log = o.log ?? (() => {});
  const now = o.now ?? Date.now;
  const heartbeatMs = o.heartbeatMs ?? FLEET_HEARTBEAT_MS;
  const idleTimeoutMs = o.idleTimeoutMs ?? FLEET_IDLE_TIMEOUT_MS;
  const url = fleetSocketUrl(o.config.controllerUrl);
  const ownRoot = resolve(o.dataRoot);

  let ws: WebSocket | null = null;
  let welcomed = false;
  let stopped = false;
  let failures = 0;
  let lastFrameAt = 0;
  let heartbeatRunning = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let idleTimer: ReturnType<typeof setInterval> | null = null;

  const send = (frame: object): void => {
    if (ws && ws.readyState === WS.OPEN) ws.send(JSON.stringify(frame));
  };

  const clearTimers = (): void => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (idleTimer) clearInterval(idleTimer);
    heartbeatTimer = idleTimer = null;
  };

  const heartbeat = async (): Promise<void> => {
    if (!welcomed || heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const outputs: Partial<Record<FleetHeartbeatCommand, FleetCommandOutput>> = {};
      for (const cmd of FLEET_HEARTBEAT_COMMANDS) {
        const run = o.commands[cmd];
        if (!run) continue;
        try {
          const r = await run(o.dataRoot, []);
          outputs[cmd] = { stdout: r.stdout, exitCode: r.exitCode, at: now() };
        } catch (e) {
          // Leave it out: the master then falls back to asking (req / ssh) instead of trusting a stale value.
          log(`[fleet] heartbeat ${cmd} failed: ${(e as Error)?.message ?? e}`);
        }
      }
      const frame: FleetHeartbeat = { t: "heartbeat", at: now(), outputs };
      send(frame);
    } finally {
      heartbeatRunning = false;
    }
  };

  const answer = async (id: number, cmd: string, args: string[]): Promise<void> => {
    const res = (r: Omit<FleetResponse, "t" | "id">): void => send({ t: "res", id, ...r });
    const run = o.commands[cmd];
    if (!run) return res({ stdout: "", exitCode: FLEET_UNKNOWN_COMMAND_EXIT, error: `unknown command: ${cmd}` });
    const [root, ...rest] = args;
    // The master addresses a data root; only ever act on our own (a mismatch means a misconfigured worker).
    if (typeof root !== "string" || resolve(root) !== ownRoot) {
      return res({ stdout: "", exitCode: 2, error: `dataRoot mismatch: ${String(root)}` });
    }
    try {
      const r = await run(o.dataRoot, rest);
      res({ stdout: r.stdout, exitCode: r.exitCode });
    } catch (e) {
      res({ stdout: "", exitCode: 1, error: String((e as Error)?.message ?? e) });
    }
  };

  const scheduleReconnect = (delayMs: number): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delayMs);
    reconnectTimer.unref?.();
  };

  const connect = (): void => {
    if (stopped) return;
    let sock: WebSocket;
    try {
      sock = new WS(url);
    } catch (e) {
      log(`[fleet] connect failed: ${(e as Error)?.message ?? e}`);
      scheduleReconnect(fleetBackoffMs(failures++));
      return;
    }
    ws = sock;
    welcomed = false;
    // A dial to an unreachable host can hang without ever firing onclose; give up and redial.
    const connectTimer = setTimeout(() => {
      if (sock.readyState === WS.CONNECTING) sock.close();
    }, 15_000);
    connectTimer.unref?.();

    sock.onopen = () => {
      clearTimeout(connectTimer);
      lastFrameAt = now();
      const hello: FleetHello = {
        t: "hello",
        protocol: FLEET_PROTOCOL,
        nodeId: o.config.nodeId,
        token: o.config.token,
        appVersion: o.appVersion,
        commands: Object.keys(o.commands),
      };
      sock.send(JSON.stringify(hello));
      idleTimer = setInterval(() => {
        // Half-open links (tailscale path change, no RST) never fire onclose on their own.
        if (now() - lastFrameAt > idleTimeoutMs) {
          log("[fleet] no frame from master, reconnecting");
          sock.close();
        }
      }, Math.min(5000, idleTimeoutMs));
      idleTimer.unref?.();
    };

    sock.onmessage = (ev: MessageEvent) => {
      lastFrameAt = now();
      const frame = parseFleetFrame(typeof ev.data === "string" ? ev.data : "");
      if (!frame) return;
      if (frame.t === "welcome") {
        welcomed = true;
        failures = 0;
        log(`[fleet] connected to ${o.config.controllerUrl}`);
        void heartbeat();
        heartbeatTimer = setInterval(() => void heartbeat(), heartbeatMs);
        heartbeatTimer.unref?.();
      } else if (frame.t === "req" && typeof frame.id === "number" && typeof frame.cmd === "string" && Array.isArray(frame.args)) {
        const args = frame.args.filter((a): a is string => typeof a === "string");
        void answer(frame.id, frame.cmd, args);
      }
      // "ping" only refreshes lastFrameAt.
    };

    sock.onclose = (ev: CloseEvent) => {
      clearTimeout(connectTimer);
      if (ws === sock) ws = null;
      const wasWelcomed = welcomed;
      welcomed = false;
      clearTimers();
      if (stopped) return;
      if (ev.code === FLEET_CLOSE.unauthorized) {
        log("[fleet] master rejected this node's token; retrying in 10 minutes (ssh fallback stays active)");
        scheduleReconnect(FLEET_UNAUTHORIZED_BACKOFF_MS);
      } else if (ev.code === FLEET_CLOSE.superseded) {
        scheduleReconnect(FLEET_SUPERSEDED_BACKOFF_MS);
      } else {
        if (wasWelcomed) log(`[fleet] disconnected (code ${ev.code}), reconnecting`);
        scheduleReconnect(fleetBackoffMs(failures++));
      }
    };

    // onerror is always followed by onclose; reconnect handling lives there.
    sock.onerror = () => {};
  };

  connect();

  return {
    triggerHeartbeat: () => void heartbeat(),
    connected: () => welcomed,
    stop: () => {
      stopped = true;
      clearTimers();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = null;
      ws?.close(1000);
      ws = null;
    },
  };
}
