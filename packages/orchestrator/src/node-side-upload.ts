/**
 * node-side-upload.ts — 节点侧上传(**experimental**,见 plans/027)的 master 侧全部逻辑。
 *
 * ⚠️ 本文件是实验功能的**唯一入口**。要快速开关/回退,只动这一个文件:
 *   - **全局停用**:把 `NODE_SIDE_UPLOAD_ENABLED` 改成 `false` → 即使规则里开了
 *     `pipeline.steps.nodeSideUpload` 也一律回落现状(不改任何规则文件)。
 *   - **彻底移除**:删本文件 + `@drec/app` 的 `node-pipeline.ts` + cli 的
 *     `node-pipeline-commands.ts`,再删 pipeline.ts 里的调用点(见 `maybeRunNodeSideUpload`)。
 *
 * 背景(为什么做):实测 pull(rsync 回传录像)是后处理主要耗时(165s~4198s),而 9/16 房间
 * 不烧录、其 merge 只是 `-c copy` 纯 I/O —— 这类房间可让 winner 节点本地 remux + 上传,
 * 省掉整场录像回传。
 *
 * 边界(硬性):
 *   - **仅 upload 模式**:stage 模式的产物必须落 master 的 stage 目录(用户要拿这些文件),
 *     省回传会让该模式失去意义;且 stage 不上传,节点侧执行无任何收益。
 *   - **仅不烧录**:burn 是全量重编码,需 11 核 + 中文字体;弱节点(2 vCPU,~77% steal)
 *     实测仅 0.38x 实时,烧不动。
 *   - 节点缺能力(biliup / B站 cookie / 旧 bundle)→ 回落现状,**记明原因,绝不静默**。
 */
import type { NodePipelineSpec } from "@drec/core";
import type { JobState, SyncLedger } from "./ledger.js";
import type { PipelineCfg, PipelineDeps } from "./pipeline.js";
import type { Transport } from "./transport.js";
import type { NotifyEvent } from "@drec/core";

/**
 * **实验功能总开关(kill switch)**。`false` = 全局停用节点侧上传,任何规则设置都不生效。
 * 出问题时把它改 false 即可一键回退,不必动规则文件或数据库。
 */
export const NODE_SIDE_UPLOAD_ENABLED = true;

/** 是否满足「走节点侧上传」的全部前置条件(纯函数,便于单测;不查节点能力——那要 IO,在 executor 里做)。 */
export function shouldUseNodeSideUpload(
  cfg: Pick<PipelineCfg, "uploadMode" | "steps">,
  burn: { burnDanmu: boolean; burnLivechat: boolean },
): { ok: true } | { ok: false; reason: string } {
  if (!NODE_SIDE_UPLOAD_ENABLED) return { ok: false, reason: "实验功能已被全局开关停用(NODE_SIDE_UPLOAD_ENABLED=false)" };
  if (!cfg.steps?.nodeSideUpload) return { ok: false, reason: "规则未开启 nodeSideUpload" };
  if (cfg.uploadMode !== "upload") return { ok: false, reason: "本场为 stage 模式(产物需落 master)" };
  if (burn.burnDanmu || burn.burnLivechat) {
    return { ok: false, reason: `本场需烧录(danmu=${burn.burnDanmu} livechat=${burn.burnLivechat})` };
  }
  return { ok: true };
}

export interface NodeSideUploadArgs {
  streamKey: string;
  cfg: PipelineCfg;
  winner: { workerId: string; rec: { tsFiles: string[]; xmlPath?: string } };
  winnerMembers: readonly { workerId: string; rec: { tsFiles: string[]; xmlPath?: string } }[];
  transport: Transport;
  ledger: SyncLedger;
  jlog: (m: string) => void;
  notify: (e: NotifyEvent) => void;
  deps: PipelineDeps;
}

/**
 * 执行节点侧上传。返回非 null = 已由节点完成(调用方直接 return);
 * 返回 null = **回落现状**(能力不足等),调用方继续走 pull 回 master 的常规路径。
 */
export async function tryNodeSideUpload(o: NodeSideUploadArgs): Promise<{ state: JobState; bv?: string } | null> {
  const { streamKey, cfg, winner, winnerMembers, transport, ledger, jlog, notify } = o;

  // 能力探测:旧 bundle 无 _node-capabilities / 节点缺 biliup / 无 cookie → 回落现状。
  if (!transport.nodeCapabilities || !transport.nodePipeline) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} 的 bundle 不支持(_node-pipeline 缺失) → 回落 pull 回 master`);
    return null;
  }
  let caps;
  try {
    caps = await transport.nodeCapabilities();
  } catch (e) {
    jlog(`节点侧上传能力探测失败(${(e as Error)?.message ?? e}) → 回落 pull 回 master`);
    return null;
  }
  // 调用方保证 upload 模式(见 shouldUseNodeSideUpload),这里直接按 upload 校验能力。
  if (!caps.biliup) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} 无 biliup → 回落 pull 回 master`);
    return null;
  }
  if (!caps.cookies && !cfg.cookies) {
    jlog(`节点侧上传不可用:节点 ${winner.workerId} 无 B站 cookie 且 master 未下发 → 回落 pull 回 master`);
    return null;
  }
  jlog(`节点侧上传可用(biliup=${caps.biliup} cookies=${caps.cookies} 磁盘=${caps.diskFreeGB.toFixed(1)}GB)→ 节点本地处理,省掉回传`);

  const spec: NodePipelineSpec = {
    streamKey,
    tsFiles: winnerMembers.flatMap((m) => m.rec.tsFiles),
    xmlPath: winner.rec.xmlPath,
    segmentGroupSec: cfg.segmentGroupSec,
    mergeSegments: cfg.steps?.mergeSegments !== false,
    uploadMode: "upload",
    stageDir: cfg.stageDir,
    uploadMeta: cfg.uploadMeta,
    uploadPrivate: cfg.uploadPrivate !== false,
    timeZone: cfg.timeZone,
    minSegmentSec: cfg.minSegmentSec,
    cookies: cfg.cookies || undefined,
    cleanSourceAfterDone: cfg.cleanup?.sourceAfterDone === true,
  };

  ledger.logStep(streamKey, "pull", "start");
  jlog(`节点侧执行: remux + 上传(无录像回传)`);
  const t0 = Date.now();
  let result;
  try {
    result = await transport.nodePipeline(spec);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    jlog(`节点侧执行失败: ${msg}`);
    ledger.logStep(streamKey, "pull", "done", `节点侧执行失败: ${msg.slice(0, 120)}`);
    // 节点侧失败 → 不静默:标 failed 让 reconciler 决定重试/人工。绝不吞掉。
    ledger.markFailed(streamKey, `节点侧上传失败: ${msg.slice(0, 200)}`);
    notify({ kind: "error", stage: "同步", message: `节点侧上传失败 ${streamKey}: ${msg.slice(0, 200)}` });
    return { state: "failed" };
  }
  const elapsed = Math.round((Date.now() - t0) / 1000);
  if (!result.ok) {
    const msg = result.error ?? "未知错误";
    jlog(`节点侧执行失败: ${msg}(${elapsed}s)`);
    ledger.logStep(streamKey, "pull", "done", `节点侧失败: ${msg.slice(0, 120)}`);
    ledger.markFailed(streamKey, `节点侧上传失败: ${msg.slice(0, 200)}`);
    notify({ kind: "error", stage: "同步", message: `节点侧上传失败 ${streamKey}: ${msg.slice(0, 200)}` });
    return { state: "failed" };
  }

  ledger.logStep(streamKey, "pull", "done", `节点侧完成 ${elapsed}s${result.products?.length ? ` · ${result.products.length} 产物` : ""}`);
  jlog(`节点侧完成(${elapsed}s)${result.bv ? ` BV=${result.bv}` : ""}`);

  ledger.markDone(streamKey, result.bv ?? "");
  return { state: "done", bv: result.bv };
}
