/**
 * node-side-upload-policy.ts — the single definition of "may this order run on the node?" (issue #471).
 *
 * Pure, no IO. Both sides must agree on this verdict:
 *   - the orchestrator decides whether to dispatch a node-side upload;
 *   - the app's node output-format lock must assume the same thing (a node-side order keeps no source
 *     copy on the master's stage, which changes whether any source video survives at all).
 * The app (rank 4) cannot import the orchestrator (rank 4.5), so the rule lives in core and the
 * orchestrator re-exports it. Capabilities (biliup / login / disk) need IO and stay in the executor.
 */

/**
 * **Global kill switch** for the experimental node-side upload. `false` disables it for every rule
 * without touching any rule file or database.
 */
export const NODE_SIDE_UPLOAD_ENABLED = true;

/** The parts of a hub pipeline this decision reads. */
export interface NodeSideUploadConfig {
  uploadMode: "stage" | "upload";
  steps?: { nodeSideUpload?: boolean } | null;
}

/**
 * Whether every precondition for node-side upload holds.
 *
 * `enabled` is the kill switch: it is a parameter (default: {@link NODE_SIDE_UPLOAD_ENABLED}) so callers
 * and tests can evaluate the "switched off" branch without mutating module state.
 */
export function shouldUseNodeSideUpload(
  cfg: NodeSideUploadConfig,
  burn: { burnDanmu: boolean; burnLivechat: boolean },
  enabled: boolean = NODE_SIDE_UPLOAD_ENABLED,
): { ok: true } | { ok: false; reason: string } {
  if (!enabled) return { ok: false, reason: "实验功能已被全局开关停用(NODE_SIDE_UPLOAD_ENABLED=false)" };
  if (!cfg.steps?.nodeSideUpload) return { ok: false, reason: "规则未开启 nodeSideUpload" };
  if (cfg.uploadMode !== "upload") return { ok: false, reason: "本场为 stage 模式(产物需落 master)" };
  if (burn.burnDanmu || burn.burnLivechat) {
    return { ok: false, reason: `本场需烧录(danmu=${burn.burnDanmu} livechat=${burn.burnLivechat})` };
  }
  return { ok: true };
}
