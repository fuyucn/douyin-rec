/**
 * Platform login-state push (issue #563).
 *
 * The master is the single login source: once per hub sync tick it reads its platform cookies
 * from its own store and pushes them down to every remote worker. This has to run **before**
 * task sync, because task sync clears leftover per-task cookie strings on the node, which fall
 * back to the platform string - so the platform string must already be in place.
 *
 * Extracted from the hub starter loop (plan 050.2). Behaviour is unchanged: same push gate
 * (`shouldPushCookies`), same per-worker warning dedupe, and the same split between "the node's
 * old bundle does not support it" (never record applied) and "this push did not land" (retry
 * next round).
 */

import { CookieSyncUnsupported } from "@drec/orchestrator";
import type { Transport } from "@drec/orchestrator";
import {
  collectPlatformCookies, cookiesFingerprint, cookiesPushVerdict, readCookiesApplied,
  recordCookiesApplied, shouldPushCookies,
} from "@drec/app";
import type { TaskStore } from "@drec/app";
import type { ApplyCookiesPayload } from "@drec/core";

/** One tick's snapshot of the master's platform cookies. */
export interface CookieSyncRound {
  payload: ApplyCookiesPayload;
  fingerprint: string;
  /** `false` = no platform has a stored login state, so there is nothing to push this round. */
  hasCookies: boolean;
}

export interface CookieSyncDeps {
  store: TaskStore;
  warn: (msg: string) => void;
  log: (msg: string) => void;
}

/** The two worker fields the push needs to decide whether to send anything at all. */
export interface CookieSyncWorker {
  id: string;
  kind: string;
}

export interface CookieSync {
  /** Read the master's platform cookies for this tick. Never throws. */
  beginRound(): CookieSyncRound;
  /** Push one round's cookies to one worker. Never throws. */
  pushTo(worker: CookieSyncWorker, transport: Transport, round: CookieSyncRound): Promise<void>;
}

export function createCookieSync(deps: CookieSyncDeps): CookieSync {
  // Dedupe state belongs to the instance: one warning per distinct reason / worker, exactly as
  // the inline block had it.
  const warnedUnsupported = new Set<string>();
  const warnSeen = new Map<string, string>();
  const unsupportedSeen = new Set<string>();
  let readWarn = "";

  const warnOnce = (workerId: string, msg: string): void => {
    if (warnSeen.get(workerId) !== msg) deps.warn(msg);
    warnSeen.set(workerId, msg);
  };

  return {
    beginRound(): CookieSyncRound {
      // The read can fail on SQLITE_BUSY or a corrupt value, and the tick's promise is
      // fire-and-forget: catch it here, or one failed read rejects the whole sync round.
      let payload: ApplyCookiesPayload = { platformCookies: {} };
      try {
        payload = collectPlatformCookies(deps.store);
      } catch (e) {
        const msg = `[hub] 读取平台登录态失败(本轮不下发): ${(e as Error).message}`;
        if (readWarn !== msg) deps.warn(msg);
        readWarn = msg;
      }
      return {
        payload,
        fingerprint: cookiesFingerprint(payload),
        hasCookies: Object.keys(payload.platformCookies).length > 0,
      };
    },

    async pushTo(worker, transport, round) {
      // local = the master itself: its store is the source, there is nothing to push.
      if (worker.kind === "local" || !round.hasCookies) return;
      const id = worker.id;
      try {
        if (!shouldPushCookies(readCookiesApplied(deps.store, id), round.fingerprint, Date.now())) {
          return; // same content, still inside the re-verify window: nothing to do this round
        }
        if (!transport.applyCookies) throw new CookieSyncUnsupported("transport 未注入登录态下发");
        const r = await transport.applyCookies(round.payload);
        // Verdict (see `cookiesPushVerdict`): applied, unchanged and unsupported all count as
        // "accounted for"; rejected and missing do not - recording a fingerprint for those would
        // mean the next push never happens, i.e. a silent failure.
        const verdict = cookiesPushVerdict(round.payload, r);
        for (const p of verdict.unsupported) {
          const key = `${id}|${p}`;
          if (!unsupportedSeen.has(key)) {
            unsupportedSeen.add(key);
            deps.warn(`[hub] 节点 ${id} 没有平台 ${p}(旧 bundle),该平台不对它下发`);
          }
        }
        if (!verdict.ok) {
          warnOnce(id, `[hub] 登录态下发 ${id} 未完全应用(missing=${verdict.missing.join(",") || "-"} rejected=${verdict.rejected.join(",") || "-"}),下轮重试`);
        } else {
          recordCookiesApplied(deps.store, id, round.fingerprint);
          warnSeen.delete(id);
          if (r.applied.length > 0) deps.log(`[hub] 登录态下发 ${id}: applied=${r.applied.join(",")}`);
        }
      } catch (e) {
        // "The old bundle does not support it" and "this push did not land" must stay distinct:
        // the former must not record applied, otherwise a node that upgrades only receives
        // cookies the next time the master's login changes.
        if (e instanceof CookieSyncUnsupported) {
          if (!warnedUnsupported.has(id)) {
            warnedUnsupported.add(id);
            deps.warn(`[hub] 节点 ${id} 不支持登录态下发(旧 bundle),升级后自动补发`);
          }
          return;
        }
        warnOnce(id, `[hub] 登录态下发 ${id} 失败(下轮重试): ${(e as Error).message}`);
      }
    },
  };
}
