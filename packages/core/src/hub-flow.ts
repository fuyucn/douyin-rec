/**
 * hub-flow.ts — hub pipeline 的 DAG 拓扑(只读契约)。
 *
 * 为什么在 core:orchestrator 的 `buildWorkflow` 是**执行**侧真相(带 run 函数、资源标记),
 * 而 app/web 的队列页只需**拓扑**(哪些节点、谁在谁后面)来推导「下面做什么」。
 * 把拓扑单独抽到这里,避免 web 端复制一份常量漂移;执行侧仍以 buildWorkflow 为准。
 */
import type { HubStepName } from "./hub-ledger-contract.js";

/** pipeline 节点(与 HubStepName 的 merge/burn/upload/append 子集对齐;select/pull/clean_* 是前奏/收尾)。 */
export type HubFlowNode =
  | "merge" | "burn_danmu" | "burn_livechat"
  | "upload_plain" | "append_danmu" | "append_livechat";

/**
 * 节点 → 直接后继(与 orchestrator `buildWorkflow` 的 edges 一致):
 * merge → {burn_danmu, burn_livechat, upload_plain};upload_plain+burn_danmu → append_danmu;
 * upload_plain+burn_livechat → append_livechat;append_danmu → append_livechat(B 站分 P 顺序)。
 *
 * ⚠️ `append_danmu → append_livechat` 在 `buildWorkflow` 里是**条件边**(仅 upload 模式且开了
 * burnDanmu 时才加,见 workflow.ts 的 `appendDanmuOn`)。这里无条件收录以保持拓扑完整 ——
 * 只影响展示(`readyNodes` 在烧 danmu 关闭时本就不会返回 append_livechat),
 * 执行真相始终在 orchestrator。
 */
export const HUB_FLOW_EDGES: ReadonlyArray<readonly [HubFlowNode, HubFlowNode]> = [
  ["merge", "burn_danmu"],
  ["merge", "burn_livechat"],
  ["merge", "upload_plain"],
  ["upload_plain", "append_danmu"],
  ["burn_danmu", "append_danmu"],
  ["upload_plain", "append_livechat"],
  ["burn_livechat", "append_livechat"],
  ["append_danmu", "append_livechat"],
];

/**
 * 展示用拓扑序(与 edges 一致的一个合法拓扑排序):
 * merge → burn_danmu → burn_livechat → upload_plain → append_danmu → append_livechat。
 * 队列页「下面做什么」按此顺序列出尚未完成的节点。执行本身是并行的(见 edges),此序仅用于展示。
 */
export const HUB_FLOW_ORDER: readonly HubFlowNode[] = [
  "merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat",
];

/** 节点直接后继(去重,保持声明序)。 */
export function nextNodesOf(node: string): HubFlowNode[] {
  const out: HubFlowNode[] = [];
  for (const [from, to] of HUB_FLOW_EDGES) {
    if (from === node && !out.includes(to)) out.push(to);
  }
  return out;
}

/**
 * 给定「已完成/已跳过」节点集合,推导**下一步该跑的节点**(所有前驱已满足的 pending 节点)。
 * 纯拓扑推导,不含资源/配置(禁用步骤由调用方从 cfg 过滤)。
 * @param doneOrSkipped 已终态(done/skipped)的节点集合。
 * @returns 立即可跑的下一个节点(可能有多个 = 分叉并行轨),按声明序。
 */
export function readyNodes(doneOrSkipped: ReadonlySet<string>): HubFlowNode[] {
  const all: HubFlowNode[] = ["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"];
  const parents = new Map<HubFlowNode, HubFlowNode[]>();
  for (const [from, to] of HUB_FLOW_EDGES) {
    const list = parents.get(to) ?? [];
    list.push(from);
    parents.set(to, list);
  }
  return all.filter((n) => {
    if (doneOrSkipped.has(n)) return false;
    const ps = parents.get(n) ?? [];
    return ps.every((p) => doneOrSkipped.has(p));
  });
}

/** 步骤名 → 是否 pipeline 节点(供 web 过滤 select/pull/clean_*)。 */
export function isHubFlowNode(step: string): step is HubFlowNode {
  return (["merge", "burn_danmu", "burn_livechat", "upload_plain", "append_danmu", "append_livechat"] as const)
    .includes(step as HubFlowNode);
}

/**
 * 编译期守护:`HubFlowNode` 里的每个名字都必须是合法的 `HubStepName`(挡住拼写错误 /
 * 写错 snake_case)。`Exclude<A,B> extends never` = A 里没有 B 之外的成员。
 *
 * 注意:**不是**「新增 HubStepName 会强制登记」——那是反向断言且恒真(实测恒真,挡不住)。
 * 单向依赖(core 不该知道下游会用哪些节点),故只守「本文件写出来的名字都合法」。
 */
type _AllFlowNodesAreStepNames = Exclude<HubFlowNode, HubStepName> extends never ? true : never;
const _FLOW_NODE_CHECK: _AllFlowNodesAreStepNames = true;
void _FLOW_NODE_CHECK;
