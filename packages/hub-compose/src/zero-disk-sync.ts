/**
 * Zero-disk orchestration on the master (issue #331): capability gate, receipt poll, console view.
 *
 * Extracted from the hub starter (plan 050.4). The master owns the ledger; a node only reports.
 * `recordStreamUpload` is idempotent (terminal rows are never overwritten), so re-polling or a
 * master restart cannot double-record.
 *
 * Everything here used to live inline in `createHubStarter.start`; the semantics - fleet options,
 * TTL defaults, per-round blocked reset, last-good reuse, stale-warning dedupe and the console
 * snapshot - are unchanged.
 */

import { ZeroDiskFleet, blockedKey, recordZeroDiskReceipt } from "@drec/orchestrator";
import type { Transport } from "@drec/orchestrator";
import { isWorkerAssigned } from "@drec/core";
import type { ZeroDiskDelivery } from "@drec/core";
import { hubStore, resolveRuleSyncRoom } from "@drec/app";
import type { TaskStore } from "@drec/app";
import { setZeroDiskLive, setZeroDiskSnapshot, warnRuleIdentityMismatch } from "./hub-runtime.js";

/** One zero-disk delivery target: the pair the round may deliver for. */
export interface ZeroDiskTarget {
  workerId: string;
  platform: string;
  roomSlug: string;
}

export interface ZeroDiskWorker {
  id: string;
  kind: string;
  name?: string;
  capabilities?: string[];
}

/** Delivery bookkeeping handed to the spec builder (see planZeroDiskSpec's ctx.delivery). */
export interface ZeroDiskDeliveryBook {
  lastGood(key: string): ZeroDiskDelivery | undefined;
  remember(key: string, delivery: ZeroDiskDelivery): void;
  staleWarned(key: string): string | undefined;
  setStale(key: string, reason: string): void;
  clearStale(key: string): void;
  block(key: string, reason: string): void;
}

export interface ZeroDiskSyncDeps {
  store: TaskStore;
  log: (msg: string) => void;
  warn: (msg: string) => void;
  /** Error-level alert for a receipt that could not be applied (a real archive is missing). */
  onEvent: (e: import("@drec/core").NotifyEvent) => void;
  hubDir: () => string;
  workers: () => ZeroDiskWorker[];
  transports: () => Map<string, Transport>;
  /** Ledger path the receipts are applied to. */
  dbPath: string;
}

export interface ZeroDiskSync {
  /** May an enabled zero-disk task be pushed to this node? Fails closed on anything unconfirmed. */
  allowsPush(workerId: string): boolean;
  /** Live upload snapshots per non-local worker, for the console. */
  liveRooms(platform: string, roomSlug: string): Array<Record<string, unknown> & { workerId: string; workerName: string }>;
  /** Targets the master currently expects to run zero-disk: (room, non-local node) pairs. */
  targets(): ZeroDiskTarget[];
  /** Capability gate: refresh support and reset this round's blocked reasons. Never throws. */
  beginRound(): Promise<ZeroDiskTarget[]>;
  /** Receipt poll + console snapshot. Never throws into the sync tick. */
  finishRound(targets: ZeroDiskTarget[]): Promise<void>;
  delivery: ZeroDiskDeliveryBook;
  /** Clear the console snapshot (hub stop). */
  clearSnapshot(): void;
}

export function createZeroDiskSync(deps: ZeroDiskSyncDeps): ZeroDiskSync {
  const fleet = new ZeroDiskFleet({
    applyReceipt: (r) => {
      const res = recordZeroDiskReceipt(deps.dbPath, r);
      if (res.ok && res.alreadyTerminal) deps.log(`[zero-disk] 台账已是终态,未覆盖: ${r.streamKey}`);
      return res;
    },
    log: (m) => deps.log(m),
    alert: (message) => deps.onEvent({ kind: "error", stage: "直播直传", message }),
  });

  /** Rooms the master refused to push this round (reason shown in the console). Rebuilt every sync. */
  let blocked = new Map<string, string>();
  /** Last delivery built per (node, room): reused when a rebuild fails, so a transient read error cannot stop a live upload. */
  const lastGood = new Map<string, ZeroDiskDelivery>();
  /** Last stale reason logged per (node, room), so the same warning is not repeated every sync tick. */
  const staleWarned = new Map<string, string>();

  setZeroDiskLive((platform, roomSlug) => deps.workers()
    .filter((w) => w.kind !== "local")
    .flatMap((w) => {
      const lv = fleet.live(w.id, platform, roomSlug);
      return lv ? [{ workerId: w.id, workerName: w.name ?? w.id, ...lv }] : [];
    }));

  const targets = (): ZeroDiskTarget[] => {
    const out: ZeroDiskTarget[] = [];
    for (const rule of hubStore.listHubRules(deps.hubDir())) {
      const src = rule.recording?.sourceTaskId ? deps.store.getTask(rule.recording.sourceTaskId) : null;
      if (!src?.streamUpload) continue;
      const sync = resolveRuleSyncRoom(rule, src.room);
      const srcSlug = sync.roomSlug;
      warnRuleIdentityMismatch(rule, sync, deps.warn);
      for (const w of deps.workers()) {
        if (w.kind === "local" || w.id === "local") continue;
        if (!isWorkerAssigned(rule, w.id, w.capabilities)) continue;
        out.push({ workerId: w.id, platform: sync.platform, roomSlug: srcSlug });
      }
    }
    return out;
  };

  // Fleet workers need a resolved name: the orchestrator treats `name` as always present.
  const fleetWorkers = (): Array<{ id: string; name: string; kind: string; transport?: Transport }> => {
    const tmap = deps.transports();
    return deps.workers().map((w) => ({ id: w.id, name: w.name ?? w.id, kind: w.kind, transport: tmap.get(w.id) }));
  };

  return {
    allowsPush: (workerId) => fleet.allowsPush(workerId),

    liveRooms: (platform, roomSlug) => deps.workers()
      .filter((w) => w.kind !== "local")
      .flatMap((w) => {
        const lv = fleet.live(w.id, platform, roomSlug);
        return lv ? [{ workerId: w.id, workerName: w.name ?? w.id, ...lv }] : [];
      }),

    targets,

    async beginRound() {
      const list = targets();
      blocked = new Map();
      // Forget deliveries of pairs that are no longer targeted: a later re-assignment must rebuild.
      const liveKeys = new Set(list.map((x) => blockedKey(x.workerId, x.platform, x.roomSlug)));
      for (const k of [...lastGood.keys()]) if (!liveKeys.has(k)) lastGood.delete(k);
      try {
        const wanted = new Set(list.map((x) => x.workerId));
        await fleet.refreshSupport(fleetWorkers().filter((w) => wanted.has(w.id)));
      } catch (e) {
        deps.warn(`[zero-disk] 能力探测失败(按不支持处理): ${(e as Error).message}`);
      }
      return list;
    },

    async finishRound(list) {
      try {
        const fw = fleetWorkers();
        await fleet.poll(fw, new Set(list.map((x) => x.workerId)));
        setZeroDiskSnapshot(fleet.snapshot(list, fw, blocked));
      } catch (e) {
        deps.warn(`[zero-disk] 回执轮询失败(下轮重试): ${(e as Error).message}`);
      }
    },

    delivery: {
      lastGood: (k) => lastGood.get(k),
      remember: (k, d) => { lastGood.set(k, d); },
      staleWarned: (k) => staleWarned.get(k),
      setStale: (k, reason) => { staleWarned.set(k, reason); },
      clearStale: (k) => { staleWarned.delete(k); },
      block: (k, reason) => { blocked.set(k, reason); },
    },

    clearSnapshot: () => setZeroDiskSnapshot(new Map()),
  };
}
