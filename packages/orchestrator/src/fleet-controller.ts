/**
 * fleet-controller.ts — the master's fleet setup in one place (plans/042): the hub that workers dial into,
 * plus the join loop that hands credentials to ssh workers that are not connected.
 *
 * Join policy: every `joinEveryMs` look at the ssh workers; one that is not connected (old bundle, never
 * joined, token lost) gets a fresh token at most every `joinRetryMs`. Rounds never overlap. A failed join
 * only logs: the node keeps working over ssh.
 */
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { FleetHub, verifyFleetToken } from "./fleet-hub.js";
import { joinFleetNode } from "./fleet-join.js";

export interface FleetWorkerRef {
  id: string;
  kind: string;
  host?: string;
  dataRoot?: string;
}

export interface FleetController {
  readonly link: FleetHub;
  /** For the http server's `upgrade` event; false for non-fleet paths. */
  upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean;
  stop(): void;
}

export function startFleetController(o: {
  controllerUrl: string;
  /** Hashes of issued node tokens (`<root>/config/fleet-nodes.json`). */
  tokenPath: string;
  loadWorkers: () => FleetWorkerRef[];
  log: (m: string) => void;
  warn: (m: string) => void;
  onRecordingChange?: (nodeId: string) => void;
  joinEveryMs?: number;
  joinRetryMs?: number;
  join?: typeof joinFleetNode;
  now?: () => number;
}): FleetController {
  const now = o.now ?? Date.now;
  const join = o.join ?? joinFleetNode;
  const joinRetryMs = o.joinRetryMs ?? 30 * 60_000;
  const hub = new FleetHub({
    verifyToken: (nodeId, token) => verifyFleetToken(o.tokenPath, nodeId, token),
    log: o.log,
    ...(o.onRecordingChange ? { onRecordingChange: o.onRecordingChange } : {}),
  });

  const lastAttempt = new Map<string, number>();
  let joining = false;
  const joinRound = async (): Promise<void> => {
    if (joining) return;
    joining = true;
    try {
      for (const w of o.loadWorkers()) {
        if ((w.kind !== "ssh" && w.kind !== "tailscale-ssh") || !w.host || !w.dataRoot) continue;
        if (hub.connected(w.id)) continue;
        if (now() - (lastAttempt.get(w.id) ?? -Infinity) < joinRetryMs) continue;
        lastAttempt.set(w.id, now());
        const r = await join({ host: w.host, dataRoot: w.dataRoot, nodeId: w.id, controllerUrl: o.controllerUrl, tokenPath: o.tokenPath });
        if (r.result === "joined") o.log(`[fleet] credentials sent to ${w.id}`);
        else if (r.result === "failed") o.warn(`[fleet] join ${w.id} failed (ssh fallback stays): ${r.detail ?? ""}`);
      }
    } catch (e) {
      o.warn(`[fleet] join loop: ${(e as Error)?.message ?? e}`);
    } finally {
      joining = false;
    }
  };
  const timer = setInterval(() => void joinRound(), o.joinEveryMs ?? 60_000);
  timer.unref?.();

  return {
    link: hub,
    upgrade: (req, socket, head) => hub.handleUpgrade(req, socket, head),
    stop: () => {
      clearInterval(timer);
      hub.close();
    },
  };
}
