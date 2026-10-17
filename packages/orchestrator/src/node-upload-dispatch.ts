/**
 * Queue entry point for node-side uploads (plan 038 T15b).
 *
 * Turns one node-side upload into a pinned queue order: decide the mode, persist the plan (first writer
 * wins), take one advance step, and leave the rest to the upload poller. Anything not confirmed safe keeps
 * the existing blocking path. Never uploads directly, never deletes anything.
 */
import { formatBiliTitle, processTimeZone, resolveOutputStem, sanitizeStreamKey, type TitleContext } from "@drec/core";
import type { JobState } from "./ledger.js";
import type { NodeSideUploadArgs } from "./node-side-upload.js";
import { completeFromDispatch } from "./node-upload-complete.js";
import { DEFAULT_NODE_UPLOAD, decideUploadMode, rollingEnabledCount } from "./node-upload-config.js";
import { advanceUpload, ensureUploadPlan, type UploadInput } from "./node-upload-queue.js";
import { uploadStatusOf } from "./node-upload-status.js";

/** Titles rendered exactly like the blocking node pipeline (submission → `{title}` titleTemplate → stem). */
export function queueUploadInput(o: NodeSideUploadArgs): UploadInput {
  const { streamKey, cfg, winnerMembers } = o;
  const ctx: TitleContext = {
    sessionBase: o.earliest?.rec.sessionBase || sanitizeStreamKey(streamKey),
    startMs: o.earliest?.rec.startMs || o.broadcastStartMs || Date.now(),
    timeZone: cfg.timeZone ?? processTimeZone(),
    liveTitle: o.earliest?.rec.title,
  };
  const tpl = cfg.uploadMeta.titleTemplate ?? "";
  const stem = resolveOutputStem({ template: tpl, ...ctx });
  const sub = (cfg.uploadMeta.submissionTitleTemplate ?? "").trim();
  const title = sub ? formatBiliTitle(sub, ctx) : tpl.includes("{title}") ? formatBiliTitle(tpl, ctx) : stem;
  const expectedDurationSec = winnerMembers.reduce((s, m) => s + (m.rec.durationSec ?? 0), 0);
  return {
    prep: {
      segments: winnerMembers.flatMap((m) => m.rec.tsFiles),
      stageDir: cfg.stageDir, // replaced by the node's own stage on enqueue
      stem,
      mergeSegments: cfg.steps?.mergeSegments !== false,
      segmentGroupSec: cfg.segmentGroupSec ?? 0,
      minSegmentSec: cfg.minSegmentSec ?? 2,
      tsDirect: cfg.steps?.tsDirect === true,
    },
    meta: {
      cookies: cfg.cookies,
      title,
      tid: cfg.uploadMeta.tid,
      tag: cfg.uploadMeta.tag,
      ...(cfg.uploadMeta.desc ? { desc: cfg.uploadMeta.desc } : {}),
      public: cfg.uploadPrivate === false,
      expectedDurationSec,
      ...(cfg.uploadMeta.partTitleTemplate ? { partTitleTemplate: cfg.uploadMeta.partTitleTemplate, titleCtx: ctx } : {}),
    },
    owner: { streamKey },
  };
}

/**
 * Queue the upload when every gate holds; null = use the blocking path. Once a plan is persisted the order
 * belongs to the queue for good (the reconciler and tryNodeSideUpload both refuse to start another upload).
 */
export async function tryQueueUpload(o: NodeSideUploadArgs, capabilities?: readonly string[]): Promise<{ state: JobState } | null> {
  const { streamKey, winner, transport, ledger, jlog } = o;
  const cfg = o.deps.nodeUpload ?? DEFAULT_NODE_UPLOAD;
  if (cfg.mode !== "queue") return null;
  if (!transport.enqueue || !transport.procStatus) {
    jlog(`队列模式不可用:节点 ${winner.workerId} 的通道不支持入队/查询 → blocking`);
    return null;
  }
  const decision = decideUploadMode({ cfg, capabilities, rollingEnabledCount: await rollingEnabledCount(transport), runNowGuard: true });
  if (decision.mode === "blocking") {
    jlog(`队列模式未启用:${decision.reason} → blocking`);
    return null;
  }
  const input = queueUploadInput(o);
  if (!(input.meta.expectedDurationSec > 0)) {
    jlog(`队列模式不可用:本场时长未知,节点无法做无稿证明 → blocking`);
    return null;
  }
  const plan = ensureUploadPlan(ledger, streamKey, winner.workerId, input);
  // State stays where the blocking node path leaves it (syncing); the step row shows the queue progress.
  ledger.logStep(streamKey, "node_upload", "start", `queued on ${plan.nodeId}`);
  ledger.syncNodeState(streamKey, "node_upload", "running");
  jlog(`节点侧上传进入队列: node=${plan.nodeId} prep=${plan.prepJobId} biliup=${plan.biliupJobId}`);
  try {
    const d = await advanceUpload(transport, plan);
    try { ledger.setUploadStatus(streamKey, JSON.stringify(uploadStatusOf(plan, d, Date.now()))); } catch { /* display only */ }
    completeFromDispatch(ledger, streamKey, d, o.notify);
  } catch (e) {
    // The plan is persisted: the poller retries with the same job ids, so a failed first step is harmless.
    jlog(`队列首次推进失败(${(e as Error)?.message ?? e}),由轮询重试`);
  }
  return { state: ledger.get(streamKey)?.state ?? "syncing" };
}
