/**
 * hub-ledger-contract.ts — hub 台账的**只读契约**:表名 / job 状态 / 子步骤名 / 节点状态名。
 *
 * 为什么在 core:台账由 orchestrator 的 SyncLedger 写(DDL + 状态机),但 app(L4) 的
 * hub 任务页要**直接只读同一个 sqlite 文件**(不能 import orchestrator,方向反了)。
 * 这些字符串就是两边的接口,集中在 core 避免各写一份漂移。
 */

/** job 状态(sync_jobs.state)。retrying = 单节点重跑中(非终态)。 */
export const HUB_JOB_STATES = [
  "pending", "settling", "syncing", "merging", "uploading",
  "retrying",
  "done", "failed", "needs_manual",
] as const;
export type HubJobState = (typeof HUB_JOB_STATES)[number];

/** 终态集合(reconciler 不再推进;UI 也不再显示「进行中」)。 */
export const HUB_TERMINAL_STATES = ["done", "failed", "needs_manual"] as const satisfies readonly HubJobState[];
export type HubTerminalState = (typeof HUB_TERMINAL_STATES)[number];

/** 细粒度子步骤规范名(流程图节点;upload/append 仅 upload 模式打点)。 */
export const HUB_STEP_NAMES = [
  "select", "pull", "merge",
  "burn_danmu", "burn_livechat",
  "upload_plain", "append_danmu", "append_livechat",
  // 上传后完整性核验(T11):与 clean_* 同为收尾节点,判定「实际分 P 数 == 期望」才删源。
  "clean_verify",
  "clean_stage_src", "clean_source", "clean_stage",
] as const;
export type HubStepName = (typeof HUB_STEP_NAMES)[number];

/** 单节点安全阀状态(sync_node_states.state)。 */
export const HUB_NODE_STATE_NAMES = ["pending", "running", "done", "failed", "blocked", "skipped"] as const;
export type HubNodeStateName = (typeof HUB_NODE_STATE_NAMES)[number];

/** 台账表名(历史读取方按此探测旧库缺表)。 */
export const HUB_TABLE_NAMES = [
  "sync_jobs", "sync_job_events", "sync_job_steps", "sync_candidates", "sync_node_states", "sync_parts",
] as const;

/**
 * streamKey(`{platform}:{roomSlug}:{date}`) → 安全目录名:把 `:` `/` 换成 `_`。
 *
 * **必须单一真理源**:job 日志/舞台目录由 orchestrator 写(pipeline),又被 app(hub-jobs 读日志)
 * 与 cli(hubStarter 建目录)按同一规则算出路径。任何一处手抄不一致 → 定位错位、读不到日志。
 * 故收口在此,所有消费方都调它,不再各写一份 `key.replace(/[:/]/g, "_")`。
 */
export function sanitizeStreamKey(key: string): string {
  return key.replace(/[:/]/g, "_");
}
