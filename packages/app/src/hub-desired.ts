/**
 * hub-desired.ts — master 侧「某个 worker 应该持有哪些受管任务」的唯一构造函数(issue #481 抽离)。
 *
 * 为什么单独成模块:这段逻辑决定「房间是否缺席 desired」,而缺席会触发节点侧两阶段删除。
 * 放在 cli 的 start() 闭包里无法被测试驱动;抽成纯函数(依赖全部经 ctx 注入)后,回归测试可以
 * 直接喂「divergent 规则 + 源任务」并断言产出的 spec 用的是源任务房间、且房间没有缺席。
 *
 * 语义(与 #442 / #481 一致):
 *   - 规则启用 ∧ 本节点未被勾选 → deleted:true 点名删除(用户明确的重配意图);
 *   - 规则停用 / 能力不满足 → enabled:false 停用保留(本机源任务停用就靠这条写回);
 *   - 规则未绑定 / 源任务不存在 → 缺席(节点两阶段删除);
 *   - 同步身份 = 规则绑定的**源任务房间**(issue #481:文件名 stem 只是文件身份,
 *     不一致时只告警,绝不让房间缺席)。
 */
import {
  isWorkerTargeted, resolveSpecAssignment, STREAM_UPLOAD_SPOOL_REQUIRED, zeroDiskRuleError,
  type RemoteTaskSpec, type ZeroDiskDelivery,
} from "@drec/core";
import { resolveRuleSyncRoom, type HubRule } from "./hub-store.js";
import { rollingSpecFields } from "./rolling-effective.js";
import { buildZeroDiskDelivery, planZeroDiskSpec } from "./zero-disk-node.js";
import type { Task } from "./store.js";

/** Minimal worker projection the builder needs. */
export interface HubDesiredWorker {
  id: string;
  capabilities?: readonly string[];
  dataRoot?: string;
}

export interface HubDesiredCtx {
  rules: readonly HubRule[];
  getTask(id: number): Task | null;
  workers: readonly HubDesiredWorker[];
  /** Master upload login file (same one its own pipeline uses); undefined = none. */
  cookiesPath?: string;
  /** Node-local cookie resolution for the source task. */
  resolveCookies(task: Task): string | null;
  /** Zero-disk capability gate for one node. */
  allowsPush(workerId: string): boolean;
  /** Node-side blocked-reason key (workerId|platform|roomSlug); supplied so app stays independent of orchestrator. */
  blockedKey(workerId: string, platform: string, roomSlug: string): string;
  delivery: {
    lastGood(key: string): ZeroDiskDelivery | undefined;
    remember(key: string, delivery: ZeroDiskDelivery): void;
    staleWarned(key: string): string | undefined;
    setStale(key: string, reason: string): void;
    clearStale(key: string): void;
    block(key: string, reason: string): void;
  };
  warn(msg: string): void;
  /** Called on a stem/source-room mismatch; the caller dedupes so this can fire every tick. */
  onRuleIdentityMismatch?(rule: HubRule, sync: { platform: string; roomSlug: string; mismatched: boolean }): void;
}

/** 计算一个 worker 的期望任务集(纯函数;不读全局状态,副作用全部经 ctx)。 */
export function desiredSpecsForWorker(workerId: string, ctx: HubDesiredCtx): RemoteTaskSpec[] {
  const out: RemoteTaskSpec[] = [];
  const worker = ctx.workers.find((w) => w.id === workerId);
  const capsOfThis = worker?.capabilities;
  for (const rule of ctx.rules) {
    // 规则文件消失 / sourceTaskId 解绑 / 源任务不存在 → 缺席(节点两阶段删除)。
    const src = rule.recording?.sourceTaskId ? ctx.getTask(rule.recording.sourceTaskId) : null;
    if (!src) continue;
    // Issue #481: sync identity is the SOURCE TASK room; a divergent filename stem must never drop the
    // room from desired (that would two-phase delete the remote managed task).
    const sync = resolveRuleSyncRoom(rule, src.room);
    const srcSlug = sync.roomSlug;
    ctx.onRuleIdentityMismatch?.(rule, sync);
    // #442:删除意图只来自「未勾选」这一个维度。
    const ruleDisabled = rule.enabled === false;
    const targeted = isWorkerTargeted(rule, workerId);
    if (!ruleDisabled && !targeted) {
      out.push({
        platform: sync.platform,
        roomSlug: srcSlug,
        room: src.room,
        name: src.name,
        quality: src.quality,
        engine: src.engine,
        danmu: src.danmu,
        segmentSec: src.segmentSec,
        outputFormat: src.outputFormat,
        scheduleStart: src.scheduleStart,
        scheduleEnd: src.scheduleEnd,
        enabled: false,
        useCookie: src.useCookie,
        cookies: null,
        outDir: null,
        webhook: null,
        anchorName: src.anchorName,
        rollingUpload: src.rollingUpload,
        rollingEffective: src.rollingUpload,
        assigned: false,
        deleted: true,
      });
      continue;
    }
    const { assigned, enabled: specEnabledBase } = resolveSpecAssignment(rule, workerId, capsOfThis, src.enabled);
    const zdKey = ctx.blockedKey(workerId, sync.platform, srcSlug);
    const zd = planZeroDiskSpec({
      streamUpload: src.streamUpload,
      workerId,
      assigned,
      enabled: specEnabledBase,
      allowsPush: ctx.allowsPush(workerId),
      ruleError: zeroDiskRuleError(src.streamUpload, { enabled: rule.enabled, mode: rule.pipeline?.upload?.mode, workers: rule.workers, steps: rule.pipeline?.steps }),
      build: () => buildZeroDiskDelivery({
        platform: sync.platform,
        roomSlug: srcSlug,
        ...(ctx.cookiesPath ? { masterCookiesPath: ctx.cookiesPath } : {}),
        ...(worker?.dataRoot ? { workerDataRoot: worker.dataRoot } : {}),
      }),
      ...(ctx.delivery.lastGood(zdKey) ? { lastGood: ctx.delivery.lastGood(zdKey)! } : {}),
    });
    if (zd.delivery && !zd.stale) ctx.delivery.remember(zdKey, zd.delivery);
    if (zd.stale && ctx.delivery.staleWarned(zdKey) !== zd.stale) {
      ctx.delivery.setStale(zdKey, zd.stale);
      ctx.warn(`[zero-disk] 无法重建下发对象(${zd.stale});沿用上次的,避免停掉在传的稿件`);
    }
    if (!zd.stale) ctx.delivery.clearStale(zdKey);
    if (zd.blocked) ctx.delivery.block(zdKey, zd.blocked);
    const isLocalWorker = workerId === "local";
    const rollingFields = rollingSpecFields(
      { enabled: rule.enabled, mode: rule.pipeline?.upload?.mode, workers: rule.workers, steps: rule.pipeline?.steps },
      src.rollingUpload,
      isLocalWorker,
    );
    out.push({
      platform: sync.platform,
      roomSlug: srcSlug,
      room: src.room,
      name: src.name,
      quality: src.quality,
      engine: src.engine,
      danmu: src.danmu,
      segmentSec: src.segmentSec,
      outputFormat: src.outputFormat,
      scheduleStart: src.scheduleStart,
      scheduleEnd: src.scheduleEnd,
      enabled: zd.enabled,
      useCookie: src.useCookie,
      cookies: ctx.resolveCookies(src),
      outDir: src.outDir,
      webhook: src.webhook,
      anchorName: src.anchorName,
      assigned,
      ...rollingFields,
      streamUpload: src.streamUpload,
      // Pinned by the core constant: workers never receive the forbidden no-spool value.
      streamUploadSpool: STREAM_UPLOAD_SPOOL_REQUIRED,
      ...(zd.delivery ? { zeroDiskDelivery: zd.delivery } : {}),
    });
  }
  return out;
}
