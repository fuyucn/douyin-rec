/**
 * Hub task sync: the periodic reconcile that turns master rules into per-worker expected tasks.
 *
 * Extracted from the hub starter (plan 050.3). The loop, its guards and its warning texts are the
 * ones that used to sit inline in `createHubStarter`; the surrounding zero-disk round glue stays
 * in the starter and is injected as `beginRound` / `finishRound`.
 *
 * Round order is part of the contract and must not change:
 *   1. zero-disk capability gate (`beginRound`) - decides which pairs are deliverable this round;
 *   2. platform credential push (`cookieSync`) - must precede task apply, because applying tasks
 *      clears leftover task-level cookie strings on the node (they fall back to the platform one);
 *   3. per-worker expected specs + apply;
 *   4. zero-disk receipt poll + console snapshot (`finishRound`).
 */

import {
  platformForRoom,
} from "@drec/core";
import type { RemoteTaskSpec } from "@drec/core";
import { recordExpectedVersion, recordSyncError, refreshLocalRollingEffective } from "@drec/app";
import type { TaskStore } from "@drec/app";
import type { Transport } from "@drec/orchestrator";
import { getReceiptSettings, hubSyncGate } from "./hub-runtime.js";
import type { CookieSync } from "./cookie-sync.js";

/** The worker fields this loop needs. */
export interface TaskSyncWorker {
  id: string;
  kind: string;
}

/** One zero-disk delivery target: the pair the round may deliver for. */
export interface ZeroDiskTarget {
  workerId: string;
  platform: string;
  roomSlug: string;
}

export interface TaskSyncDeps {
  store: TaskStore;
  manager: {
    isRunning(id: number): boolean;
    requestStop(id: number): void;
  };
  warn: (msg: string) => void;
  log: (msg: string) => void;
  /** Rules directory, re-read per round (same as before). */
  hubDir: () => string;
  /** Expected specs for one worker; the starter owns the zero-disk delivery bookkeeping. */
  desiredFor: (workerId: string) => RemoteTaskSpec[];
  /** Worker list, re-read per round so hub.config.json edits apply without a restart. */
  workers: () => TaskSyncWorker[];
  /** Transport map, rebuilt per round for the same reason. */
  transports: () => Map<string, Transport>;
  cookieSync: CookieSync;
  /**
   * Zero-disk capability gate. Runs before any spec is built and returns this round's targets;
   * failures inside it must not abort the round (the gate then treats nodes as unsupported).
   */
  beginRound: () => Promise<ZeroDiskTarget[]>;
  /** Zero-disk receipt poll + console snapshot. Must not throw into the tick. */
  finishRound: (targets: ZeroDiskTarget[]) => Promise<void>;
}

export interface TaskSync {
  /** Runs one round; concurrent calls collapse into a single re-run (see SyncGate). */
  (req?: { force?: boolean }): Promise<void>;
}

export function createTaskSync(deps: TaskSyncDeps): TaskSync {
  // One warning per distinct set of skip reasons per process: a persistent master bug must not
  // print on every tick for the life of the serve process.
  const warnedSkipReasons = new Set<string>();

  const run: TaskSync = async (req) => {
    // force comes from SyncGate's accumulated flag: a request that arrived while a round was in
    // flight must land in **that** round (see the SyncGate note).
    const force = hubSyncGate.beginRun(req?.force);
    if (hubSyncGate.running) {
      hubSyncGate.rerunRequested = true;
      return;
    }
    hubSyncGate.running = true;
    try {
      // Rolling upload (issue #40): recompute the local source tasks' derived value every round -
      // once a rule is deleted/unbound/disabled there is no entry left in desiredFor for that task,
      // applyTasks will not write it, and without this fallback the old `true` would stick.
      try {
        refreshLocalRollingEffective(deps.store, deps.hubDir(), undefined, deps.warn);
      } catch (e) {
        deps.warn(`[rolling] 同步 tick 重算边录边传生效值失败: ${(e as Error).message}`);
      }
      const zeroDiskTargets = await deps.beginRound();
      // Issue #563: platform credential push (master = the only login source). Must run before task
      // apply; see the module header.
      const cookiesRound = deps.cookieSync.beginRound();
      for (const w of deps.workers()) {
        const t = deps.transports().get(w.id);
        if (!t?.applyTasks) continue; // this transport cannot sync tasks -> skip (retry next round)
        // local = the master itself: its store is the source, nothing to push (decided in cookie-sync).
        await deps.cookieSync.pushTo({ id: w.id, kind: w.kind }, t, cookiesRound);
        try {
          const desired = deps.desiredFor(w.id);
          // T16: the version is derived from content; an unchanged round reuses the same one, so a
          // false syncLag cannot appear. The receipt is observation only: a settings write failure
          // must never stop this round (one disk/DB fault would otherwise stop task sync).
          let expectedVersion: number | undefined;
          try {
            const receiptSettings = getReceiptSettings();
            expectedVersion = receiptSettings
              ? recordExpectedVersion(receiptSettings, w.id, desired)
              : undefined;
          } catch (e) {
            deps.warn(`[hub] 记录期望版本 ${w.id} 失败(忽略,继续同步): ${(e as Error).message}`);
          }
          const r = await t.applyTasks({ desired, force, ...(expectedVersion !== undefined ? { expectedVersion } : {}) });
          for (const warning of r.warnings ?? []) {
            deps.log(`[hub] 节点 ${w.id} 回执: ${warning}`);
          }
          // A safety-valve rejection means the expected set was NOT fully applied: keep it visible
          // as syncError instead of clearing the receipt.
          try {
            const receiptSettings = getReceiptSettings();
            if (receiptSettings) recordSyncError(receiptSettings, w.id, r.rejected ? `rejected: ${r.rejected}` : null);
          } catch (e) {
            deps.warn(`[hub] 记录同步结果 ${w.id} 失败(忽略): ${(e as Error).message}`);
          }
          // The local worker's pending tasks are hard-stopped in-process through the TaskManager, the
          // same semantics as a remote `_apply-tasks` hard stop: stopping a source task or deleting a
          // rule must take effect immediately instead of waiting for drain (hub settle would otherwise
          // wait for the stream to end and never build the job).
          // Exception = "stop after this stream" (issue #569): when the expected spec carries
          // `enabled=false + drain=true` the task must NOT be hard-stopped; daemon stopGraceful /
          // drainTask already lets the current stream finish on its own.
          const drainKeys = new Set(
            desired
              .filter((s) => s.enabled === false && s.drain === true)
              .map((s) => `${s.platform}:${s.roomSlug}`),
          );
          if (w.kind === "local" && r.pending.length > 0) {
            for (const key of r.pending) {
              if (drainKeys.has(key)) {
                deps.log(`[hub] 任务 ${key} 排空中:不硬停,等本场自然收播`);
                continue;
              }
              const task = deps.store.listTasks().find((x) => {
                try {
                  const p = platformForRoom(x.room);
                  return `${p.id}:${p.extractRoomSlug(x.room)}` === key;
                } catch {
                  return false;
                }
              });
              if (task && deps.manager.isRunning(task.id)) deps.manager.requestStop(task.id); // don't await exit, that would stall the tick
            }
          }
          if (r.applied.length > 0 || r.removed.length > 0 || r.pending.length > 0) {
            deps.log(`[hub] 任务同步 ${w.id}: applied=${r.applied.length} removed=${r.removed.length}`
              + ` pending=${r.pending.length}${force ? " (forced)" : ""}`);
          }
          // Issue #480: a node skips malformed specs instead of failing the whole batch - surface the
          // count so a master bug does not look like a healthy sync. Old nodes never send the field.
          if (r.skipped && r.skipped.length > 0) {
            const reasonSet = [...new Set(r.skipped.map((s) => s.reason))].sort().join("|");
            if (!warnedSkipReasons.has(reasonSet)) {
              warnedSkipReasons.add(reasonSet);
              deps.warn(`[hub] 任务同步 ${w.id}: 节点跳过 ${r.skipped.length} 条坏配置`
                + `(其余照常应用;坏条目对应的本机任务不会被删除): ${r.skipped.map((s) => `#${s.index + 1} ${s.reason}`).join("; ")}`);
            }
          }
          // Node-side safety valve (T-2) hit: the master side must see it, otherwise a rejected push
          // is silent in the UI - the user only notices that nothing changed.
          if (r.rejected) {
            deps.warn(`[hub] 任务同步 ${w.id} 被节点安全阀拒绝(rejected=${r.rejected}, force=${force}):`
              + `本轮期望未完整生效(节点受管任务保持原状)。`
              + `若确认要缩容/清空该节点,在节点上设 DREC_ALLOW_SHRINK=1 后重试;`
              + `若 master 侧配置读取异常,先检查 config/hub/ 目录。`);
          }
        } catch (e) {
          const msg = (e as Error).message;
          // The failure reason must land in the receipt: log alone cannot answer "was the expected
          // set applied" after a restart. Nested in its own try so a receipt failure cannot escalate
          // into a second exception.
          try {
            const receiptSettings = getReceiptSettings();
            if (receiptSettings) recordSyncError(receiptSettings, w.id, msg);
          } catch (recordErr) {
            deps.warn(`[hub] 记录同步失败原因 ${w.id} 失败: ${(recordErr as Error).message}`);
          }
          // Node offline / command failed -> warn only, next round reconciles; never break reconcile.
          deps.warn(`[hub] 任务同步 ${w.id} 失败: ${msg}`);
        }
      }
      // Collect zero-disk receipts (-> master ledger) and refresh the console view. Never throws into
      // the sync tick: a polling failure must not stop task sync.
      await deps.finishRound(zeroDiskTargets);
    } finally {
      if (hubSyncGate.endRun()) void run();
    }
  };
  return run;
}
