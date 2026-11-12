/**
 * Hub operator actions: manual node re-run, stop/ack/run-now, drain-support probe, pool providers.
 *
 * Extracted from the hub starter (plan 050.5). These handlers are called straight through by the
 * web API, so their 400/409 verdicts, ledger transitions and probe ordering are unchanged - only
 * the assembly site moves. `retryNode` stays byte-for-byte identical: it re-drives a workflow node
 * on a job the reconciler may still be touching, and a silent change there would duplicate uploads.
 */

import {
  buildWorkflow, deriveStageProducts, runWorkflowNodes, withOutputStem,
} from "@drec/orchestrator";
import type { PipelineCfg, PipelineDeps, Reconciler, ResourcePool, SyncLedger, Transport, WorkflowNodeKey } from "@drec/orchestrator";
import type { NotifyEvent } from "@drec/core";
import {
  burnFlags, closeStageReady, effectiveStageFormat, isJobAbort, isJobLive, runWithJob,
  stageSessionDir, throwIfAborted, USER_STOP,
} from "@drec/core";
import {
  setAckJob, setPoolProviders, setProbeDrainSupport, setRetryNode, setRunNow, setStopJob,
} from "./hub-runtime.js";

/** Result shape the web API forwards verbatim (`code` becomes the HTTP status). */
export interface HubActionResult {
  ok: boolean;
  error?: string;
  code?: number;
}

/** Worker entry the actions need; `kind === "local"` is skipped by the drain probe. */
export interface HubActionWorker {
  id: string;
  kind: string;
  name?: string;
  capabilities?: string[];
}

export interface HubActionsDeps {
  log(msg: string): void;
  warn(msg: string): void;
  ledger: SyncLedger;
  pool: ResourcePool;
  /** Resolve a room's pipeline config; null = the room is not enabled for hub. */
  resolveCfg(platform: string, slug: string): PipelineCfg | null;
  /** Worker list, re-read per call so hot config edits take effect. */
  workers(): HubActionWorker[];
  /** Transport map, rebuilt per call for the same reason. */
  transports(): Map<string, Transport>;
  pipelineDeps: PipelineDeps;
  onEvent(e: NotifyEvent): void;
  /** Session stage dir for a stream key (`hubCfg.stageDir ?? rootStageDir`). */
  stageDir(): string;
}

export interface HubActions {
  /** Re-run one node of a finished or live room, sharing the reconciler's stream lock. */
  retryNode(streamKey: string, node: WorkflowNodeKey, force?: boolean): Promise<HubActionResult>;
  /**
   * Drain-support probe (issue #569): only the bound recording nodes are asked; local is skipped
   * because it always drains. Any old bundle or unreachable node fails the room - the API then
   * keeps recording instead of falling back to a hard stop, which would cut the current segment.
   */
  probeDrainSupport(workerIds: string[]): Promise<{ ok: boolean; error?: string }>;
  /** Publish every handler. Call once the reconciler exists; order matches the inline version. */
  install(reconciler: Reconciler): void;
  /** Clear every published handler so post-stop requests fail closed (self-review: stale runner). */
  uninstall(): void;
}

export function createHubActions(deps: HubActionsDeps): HubActions {
  // 正在进行的重跑(streamKey):检查与占用必须同步完成,否则并发请求会双双通过
  // isJobLive/hasStreamLock 检查、再被 withStreamLock 排队串行执行两次(上传类节点会重复投稿)。
  const retryingKeys = new Set<string>();

  // 手动单节点重跑:UI → web API → 这里。与 reconciler 共享同一 ResourcePool 流锁,保证同场不并发;
  // 上传类节点默认拒绝(可能已建稿/已 append),force 才放行(UI 二次确认)。
  const retryNode = async (
    streamKey: string,
    node: WorkflowNodeKey,
    force = false,
  ): Promise<HubActionResult> => {
    const CORE: WorkflowNodeKey[] = ["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"];
    const unsafe = (n: WorkflowNodeKey): boolean =>
      n === "upload_plain" || n === "append_danmu" || n === "append_livechat";
    if (!CORE.includes(node)) return { ok: false, error: `不可重跑的节点: ${node}`, code: 400 };
    if (unsafe(node) && !force) return { ok: false, error: `${node} 属上传类节点,需确认后才可重跑`, code: 400 };
    const parts = streamKey.split(":");
    if (parts.length < 3) return { ok: false, error: `非法 streamKey: ${streamKey}`, code: 400 };
    const platform = parts[0];
    const roomSlug = parts[1];
    const stageSub = stageSessionDir(deps.stageDir(), streamKey);
    const job = deps.ledger.get(streamKey);
    // 同场 pipeline 正在跑(持流锁 / live job)→ 不排队,直接 409。
    // 否则会静默等在锁后,等当前上传完成又重跑一次,造成重复烧录/重复分 P。
    if (isJobLive(streamKey) || deps.pool.hasStreamLock(streamKey)) {
      return { ok: false, error: "任务正在执行,不能重跑节点", code: 409 };
    }
    // 已建稿后重传 P1 会重复投稿;已有 append done 再跑 append 会重复分 P → 拒绝(除非 force 且 UI 二次确认)。
    if (node === "upload_plain" && job?.bv) {
      const appended = ["append_danmu", "append_livechat"].some(
        (k) => deps.ledger.getNodeState(streamKey, k as WorkflowNodeKey)?.state === "done",
      );
      if (appended) return { ok: false, error: `已建稿(${job.bv})且已有分 P,不能重跑 P1(会重复投稿)`, code: 409 };
    }
    if (retryingKeys.has(streamKey)) {
      return { ok: false, error: "该场已有重跑在执行,请稍后", code: 409 };
    }
    retryingKeys.add(streamKey);
    return runWithJob(streamKey, async () => {
      try {
        return await deps.pool.withStreamLock(streamKey, async () => {
          throwIfAborted();
          deps.ledger.setState(streamKey, "retrying", {}, { force: true }); // 人工重跑:允许 done 场重跑单节点
          const cfg = deps.resolveCfg(platform, roomSlug);
          if (!cfg) {
            deps.ledger.setState(streamKey, "failed", { error: `房间未开 hub: ${streamKey}` });
            return { ok: false, error: `房间未开 hub: ${streamKey}`, code: 400 };
          }
          // 分段模式:产出/烧录/上传是一个整体(逐段 remux + 多文件建稿),不做单节点重跑
          // (单段重烧会与已建稿的分 P 错位)。用「重新运行」整场重跑(幂等:已建稿只补 append)。
          if (cfg.steps?.mergeSegments === false) {
            return { ok: false, error: "分段上传模式不支持单节点重跑,请用「重新运行」整场重跑", code: 400 };
          }
          deps.ledger.backfillNodeStates(streamKey);
          const derived = deriveStageProducts(stageSub, effectiveStageFormat(cfg.outputFormat, cfg.uploadMode));
          if (!derived) {
            deps.ledger.setState(streamKey, "failed", { error: `stage 产物缺失,无法重跑: ${stageSub}` });
            return { ok: false, error: `stage 产物缺失,无法重跑: ${stageSub}`, code: 409 };
          }
          const products = job?.outputStem ? withOutputStem(derived, job.outputStem) : derived;
          const workflow = buildWorkflow({
            streamKey, stageSub, products, deps: deps.pipelineDeps, cfg, log: deps.log,
            willUpload: cfg.uploadMode === "upload",
            ...burnFlags(cfg.steps),
            segmentCount: 0,
          });
          const r = await runWorkflowNodes({
            streamKey, nodes: workflow.nodes, edges: workflow.edges, ctx: workflow.ctx,
            pool: deps.pool, forceRetry: new Set<WorkflowNodeKey>([node]),
          });
          if (r.ok) {
            if (cfg.uploadMode === "upload") {
              const bv = deps.ledger.get(streamKey)?.bv ?? "";
              deps.ledger.markDone(streamKey, bv);
              if (bv) deps.onEvent({ kind: "uploadDone", bv, url: `https://www.bilibili.com/video/${bv}`, streamKey });
            } else {
              // stage 模式正常收口必须带显式标记(issue #188):空 error 会被队列判成红灯事故。
              closeStageReady(deps.ledger, streamKey, cfg.uploadMode);
            }
            return { ok: true };
          }
          const errText = r.failed.length
            ? deps.ledger.getNodeState(streamKey, r.failed[0])?.error ?? `节点失败: ${r.failed.join(",")}`
            : `节点被阻断: ${r.blocked.join(",")}`;
          if (errText === USER_STOP || r.blocked.some((k) => deps.ledger.getNodeState(streamKey, k)?.error === USER_STOP)) {
            deps.ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
            return { ok: false, error: USER_STOP, code: 409 };
          }
          deps.ledger.setState(streamKey, "failed", { error: errText });
          return { ok: false, error: errText, code: 500 };
        });
      } catch (e) {
        if (isJobAbort(e)) {
          deps.ledger.setState(streamKey, "needs_manual", { error: USER_STOP });
          return { ok: false, error: USER_STOP, code: 409 };
        }
        throw e;
      }
    }).finally(() => retryingKeys.delete(streamKey));
  };

  // 远端排空能力探测(issue #569):master 只查绑定的录制节点;本机(local)跳过(自己就支持)。
  // 任一节点旧 bundle / 不可达就失败 —— API 保持录制,绝不回退成硬停(硬停会截断当前分段)。
  const probeDrainSupport = async (workerIds: string[]): Promise<{ ok: boolean; error?: string }> => {
    for (const id of workerIds) {
      const w = deps.workers().find((x) => x.id === id);
      if (!w) {
        // 老规则可能残留已删除的 worker id:desired 构造会忽略它(没有通道可下发),探测同样跳过,
        // 不能因此把整个房间的排空永久判失败(issue #569 review P2)。
        deps.warn(`[hub] 排空探测:规则的 worker ${id} 不在 hub 配置里,跳过`);
        continue;
      }
      if (w.kind === "local") continue;
      let t: Transport | undefined;
      try {
        t = deps.transports().get(id);
      } catch (e) {
        return { ok: false, error: `节点 ${w.name ?? id} 通道配置无效: ${(e as Error).message}` };
      }
      if (!t) return { ok: false, error: `节点 ${w.name ?? id} 没有可用通道` };
      if (!t.nodeCapabilities) {
        return { ok: false, error: `节点 ${w.name ?? id} 不支持优雅排空(旧 bundle),请先升级节点` };
      }
      try {
        const caps = await t.nodeCapabilities();
        if (caps.drain !== true) {
          return { ok: false, error: `节点 ${w.name ?? id} 不支持优雅排空(旧 bundle),请先升级节点` };
        }
      } catch (e) {
        return { ok: false, error: `节点 ${w.name ?? id} 不可达,无法确认排空: ${(e as Error).message}` };
      }
    }
    return { ok: true };
  };

  return {
    retryNode,
    probeDrainSupport,
    install(reconciler) {
      setRetryNode((streamKey, node, o?: { force?: boolean }) =>
        retryNode(streamKey, node, o?.force === true));
      setStopJob((streamKey) => reconciler.stopJob(streamKey));
      setAckJob((streamKey, o) => reconciler.ackJob(streamKey, o));
      setRunNow((opts) => reconciler.runNow(opts));
      setProbeDrainSupport(probeDrainSupport);
      // 队列页的「排队位次 / 资源占用」来源:读同一 ResourcePool 实例(进程内共享)。
      setPoolProviders({ poolSnapshot: () => deps.pool.snapshot(), blockedBroadcasts: () => reconciler.blockedBroadcasts() });
    },
    uninstall() {
      setRetryNode(undefined);
      setStopJob(undefined);
      setAckJob(undefined);
      setRunNow(undefined);
      setProbeDrainSupport(undefined);
      setPoolProviders({});
    },
  };
}

