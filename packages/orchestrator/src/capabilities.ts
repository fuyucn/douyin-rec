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
