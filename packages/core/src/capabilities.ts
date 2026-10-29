/**
 * capabilities.ts — hub 的「能力门控」纯函数(与 biliup Fleet 的 placement `check()` 同思路)。
 *
 * worker 声明 `capabilities`(如 `danmu:douyin`),hub 规则声明 `requires`。房间只派给
 * **能力 ⊇ 要求**的 worker。与 `workers`(手动勾选)取交集 —— 门控只做**过滤**,不做去重,
 * 因此**不改变「多节点冗余录制 + coverage 选优」的语义**:勾选的多台若都合格,仍全部参与。
 *
 * 为什么需要:现在 `workers` 是裸 id 数组、零校验,能把「出口拿不到弹幕的 VPS」勾进「要弹幕的
 * 房间」→ 静默 0 条弹幕。门控把这件事变成**一等配置**,并给出「哪台被排除、缺什么能力」的理由。
 */

/** 一台 worker 被某房间排除的原因(供日志/UI「为什么它没参与」)。 */
export interface CapabilityRejection {
  workerId: string;
  /** 该 worker 缺少的能力标签(按 requires 顺序)。 */
  missing: string[];
}

/** 该 worker 的能力是否满足房间要求(worker 能力 ⊇ requires)。无要求恒为 true。 */
export function satisfiesCapabilities(
  workerCapabilities: readonly string[] | undefined,
  requires: readonly string[] | undefined,
): boolean {
  if (!requires || requires.length === 0) return true;
  const have = new Set(workerCapabilities ?? []);
  return requires.every((r) => have.has(r));
}

/** 规则的 workers 勾选是否包含该 worker。workers 缺省/空 = 全选(旧配置语义)。 */
export function isWorkerTargeted(rule: { workers?: readonly string[] }, workerId: string): boolean {
  return !rule.workers || rule.workers.length === 0 || rule.workers.includes(workerId);
}

/**
 * 「房间规则是否把这个房间派给该 worker」—— **归属判定的单一真理源**(issue #73)。
 * = 规则启用(缺省视为启用)∧ workers 勾选含该节点(空 = 全选)∧ 该节点能力满足 `requires`。
 *
 * 消费点必须共用它,不得各写一份:master 下发(cli desiredFor → `assigned`/`enabled`)、
 * reconciler 的失联判定与成员过滤、状态探测范围(recordingStatusWorkerIds)、
 * 本机抑制名单(localSuppressedSourceTaskIds)。
 * 注意:「未派给」≠「删除」—— 节点上对应任务只停用保留(T3),真删见 #75。
 */
export function isWorkerAssigned(
  rule: { enabled?: boolean; workers?: readonly string[]; requires?: readonly string[] },
  workerId: string,
  workerCapabilities: readonly string[] | undefined,
): boolean {
  return rule.enabled !== false && isWorkerTargeted(rule, workerId) && satisfiesCapabilities(workerCapabilities, rule.requires);
}

/**
 * master 下发给某节点的任务规格里,`assigned` 与 `enabled` 怎么填(cli `desiredFor` 调用;纯函数便于单测)。
 *
 * - 远端节点:`enabled = assigned ∧ 源任务 enabled`;未派给 → enabled:false「停用保留」(T3,不是删除)。
 * - 本机(`local`):applyTasks 写的是**源任务本身**,其 enabled 是全局录制意图,不能因「没勾选本机」
 *   写成 false(否则连远端一起停);仅「规则停用」才停。本机的「不该录」由 localSuppressedSourceTaskIds 表达。
 *   `assigned` 对本机仍如实计算(master 总览不据此过滤)。
 */
export function resolveSpecAssignment(
  rule: { enabled?: boolean; workers?: readonly string[]; requires?: readonly string[] },
  workerId: string,
  workerCapabilities: readonly string[] | undefined,
  srcEnabled: boolean,
): { assigned: boolean; enabled: boolean } {
  const assigned = isWorkerAssigned(rule, workerId, workerCapabilities);
  const enabled = workerId === "local" ? (rule.enabled !== false ? srcEnabled : false) : assigned && srcEnabled;
  return { assigned, enabled };
}

/**
 * 从候选 worker 里筛出满足 `requires` 的,并列出被排除者及缺失能力。
 *
 * **按 worker id 去重**:候选可能来自 broadcast members,而同一 worker 一场可能有多个会话
 * (断流重连)→ 不去重会让 `rejected`/`eligible` 重复列出同一台(警告文案刷三遍)。
 *
 * @param candidateIds  候选 worker id(通常是已按 `workers` 勾选过滤后的集合;可含重复)
 * @param capsOf        取某 worker 能力标签(缺省返回 undefined = 无能力)
 * @param requires      房间要求的能力(空/缺省 = 全通过)
 */
export function gateWorkers(
  candidateIds: readonly string[],
  capsOf: (workerId: string) => readonly string[] | undefined,
  requires: readonly string[] | undefined,
): { eligible: string[]; rejected: CapabilityRejection[] } {
  const eligible: string[] = [];
  const rejected: CapabilityRejection[] = [];
  const seen = new Set<string>();
  const reqs = requires ?? [];
  for (const id of candidateIds) {
    if (seen.has(id)) continue; // 去重:同一 worker 多会话只判一次
    seen.add(id);
    // requires 空/缺省 → 无要求,全通过(先于能力判定,避免对 undefined 取 filter)。
    if (reqs.length === 0) { eligible.push(id); continue; }
    const have = new Set(capsOf(id) ?? []);
    const missing = reqs.filter((r) => !have.has(r));
    if (missing.length === 0) eligible.push(id);
    else rejected.push({ workerId: id, missing });
  }
  return { eligible, rejected };
}

/**
 * 被排除原因的一行人话(对齐 biliup `explain()` 风格),供日志/通知。
 * 例:`没有 worker 满足能力要求：「orcale-vps-1」缺少能力 danmu:douyin`
 */
export function explainRejections(rejections: readonly CapabilityRejection[], nameOf?: (id: string) => string): string {
  if (rejections.length === 0) return "";
  const parts = rejections.map((r) => {
    const name = nameOf ? nameOf(r.workerId) : r.workerId;
    return `「${name}」缺少能力 ${r.missing.join("、")}`;
  });
  return `没有 worker 满足能力要求：${parts.join("；")}`;
}
