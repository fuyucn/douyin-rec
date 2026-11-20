/**
 * Hub 节点重试能力集合(纯函数,供组件与回归测试共用)。
 *
 * `RETRYABLE_NODES` 是后端 `createHubActions().retryNode` 的 CORE allowlist 的前端镜像
 * (packages/hub-compose/src/hub-actions.ts):只有这些节点点重试会被后端接受,其余(清理类
 * clean_*)一律返回 400。两边必须保持一致,`test/web/hub-job-retry.test.ts` 对此做静态对拍。
 */

/** 后端 `retryNode` CORE allowlist 的六节点:merge / 烧录 / 上传主件 / append 分 P。 */
export const RETRYABLE_NODES: readonly string[] = [
  "merge",
  "burn_danmu",
  "burn_livechat",
  "upload_plain",
  "append_danmu",
  "append_livechat",
];

/** 上传类节点:默认拒绝(可能已建稿/已 append),必须二次确认后才发带 force 的请求。 */
export const RETRY_CONFIRM_NODES: readonly string[] = [
  "upload_plain",
  "append_danmu",
  "append_livechat",
];

/** 节点是否显示重试按钮(仅当后端接受该节点时为 true)。 */
export function isRetryableNode(node: string): boolean {
  return RETRYABLE_NODES.includes(node);
}

/** 节点重试是否必须经确认弹窗(上传类节点防重复投稿/重复分 P)。 */
export function needsRetryConfirm(node: string): boolean {
  return RETRY_CONFIRM_NODES.includes(node);
}

/**
 * 一次「点重试」应该做什么(唯一的判定入口,组件只按它发请求)。
 *
 * - `none`:后端不接受该节点 → 不发任何请求(按钮也不该渲染)。
 * - `confirm`:上传类节点 → 先弹确认框,确认后才发一次带 force 的请求。
 * - `send`:直接发一次不带 force 的请求。
 */
export type RetryPlan =
  | { kind: "none" }
  | { kind: "confirm"; force: true }
  | { kind: "send"; force: false };

export function planRetry(node: string): RetryPlan {
  if (!isRetryableNode(node)) return { kind: "none" };
  if (needsRetryConfirm(node)) return { kind: "confirm", force: true };
  return { kind: "send", force: false };
}

/** 发送重试请求的回调(与组件里的 onRetry 同签名)。 */
export type RetryDispatch = (streamKey: string, node: string, force: boolean) => void | Promise<void>;

/** 一次点击的结果:`sent` 已发请求 / `needs-confirm` 待确认 / `ignored` 不该发。 */
export type RetryOutcome = "sent" | "needs-confirm" | "ignored";

/**
 * 节点重试的唯一发送入口(组件只用它,不再自己拼条件):
 * - 后端不接受的节点 → `ignored`,**不发任何请求**;
 * - 上传类节点未确认 → `needs-confirm`,先弹确认框,确认后带 force 发**一次**;
 * - 其余可重试节点 → 直接发**一次**不带 force 的请求。
 */
export function retryRequest(
  node: string,
  streamKey: string,
  dispatch: RetryDispatch,
  opts: { confirmed?: boolean } = {},
): RetryOutcome {
  const plan = planRetry(node);
  if (plan.kind === "none") return "ignored";
  if (plan.kind === "confirm" && opts.confirmed !== true) return "needs-confirm";
  const force = plan.kind === "confirm" ? true : plan.force;
  void dispatch(streamKey, node, force);
  return "sent";
}
