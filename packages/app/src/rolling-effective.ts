/**
 * rolling-effective.ts — master 本机任务的「边录边传生效值」启动刷新(issue #40)。
 *
 * 为什么需要:本机(local worker)的生效值平时由 hub 同步(cli `desiredFor` → applyTasks)写入源任务,
 * 但 serve 刚启动、首轮同步还没跑完的窗口里 daemon 可能已经在起录制 —— 此时派生列还是 NULL,
 * 会按「旧开关迁移」放行,绕过多节点重复投稿闸门。启动时先用**同一个唯一判定**(core
 * `resolveRollingPolicy`)把绑定了 hub 规则的本机任务算一遍,堵住这段窗口。
 *
 * 判定仍只在 master 做;录制端只读 `rollingEffective`。无规则的任务写 NULL(= 回落旧开关迁移,单机行为不变)。
 */
import { platformForRoom, resolveRollingPolicy, rollingReasonText, type RollingPolicy, type RollingPolicyRule } from "@drec/core";
import { listHubRules } from "./hub-store.js";
import type { TaskStore } from "./store.js";

/** 「请求了边录边传却被拦下」的原因只在变化时打一行日志(同步 tick 每分钟重算,不能刷屏)。 */
const loggedReasons = new WeakMap<TaskStore, Map<number, string>>(); // 按 store 隔离:任务 id 只在同一库内唯一
function noteRollingReason(store: TaskStore, taskId: number, policy: RollingPolicy, log?: (msg: string) => void): void {
  let loggedReason = loggedReasons.get(store);
  if (!loggedReason) loggedReasons.set(store, (loggedReason = new Map()));
  const blocked = policy.reason === "needs-burn" || policy.reason === "multi-node";
  const prev = loggedReason.get(taskId);
  if (!blocked) {
    loggedReason.delete(taskId);
    return;
  }
  if (prev === policy.reason) return;
  loggedReason.set(taskId, policy.reason);
  log?.(`[rolling] 任务 ${taskId} 的边录边传未生效: ${rollingReasonText(policy.reason)}`);
}

/**
 * master 下发给某节点的任务规格里,边录边传两个字段怎么填(cli `desiredFor` 调用;抽成纯函数以便单测):
 *   - `rollingEffective`:唯一判定的结果,录制端只读它;
 *   - `rollingUpload`(旧字段):**远端**恒等于生效值 —— 尚不认识新字段的旧节点包只读它,行为同改前;
 *     **本机(local)**透传源任务的旧开关(那是用户旧值/迁移来源,applyTasks 写的是源任务本身,不能覆盖)。
 */
export function rollingSpecFields(
  rule: RollingPolicyRule | null,
  legacyTaskFlag: boolean,
  isLocalWorker: boolean,
): { rollingUpload: boolean; rollingEffective: boolean } {
  const { effective } = resolveRollingPolicy(rule, legacyTaskFlag);
  return { rollingUpload: isLocalWorker ? legacyTaskFlag : effective, rollingEffective: effective };
}

/**
 * 重算本机(非 hub 受管)源任务的派生值并写库。**唯一的本机重算入口**,调用点:
 *   serve 启动 / 每个 hub 同步 tick / 规则增删改 / 起录前兜底(S3,`taskIds` 限定单个任务)。
 * 规则被删、解绑、停用都在这里落到「回落」:无绑定规则 → 写 NULL(读取按旧开关迁移,不再残留旧的 true);
 * 规则停用 → 唯一判定直接给 false。返回写入了派生值的任务数(无规则任务清为 NULL 不计)。
 */
export function refreshLocalRollingEffective(
  store: TaskStore,
  hubDir: string,
  taskIds?: readonly number[],
  log?: (msg: string) => void,
): number {
  const bySource = new Map<number, ReturnType<typeof listHubRules>[number]>();
  for (const rule of listHubRules(hubDir)) {
    const id = rule.recording?.sourceTaskId;
    if (id != null) bySource.set(id, rule);
  }
  let n = 0;
  for (const t of store.listTasks()) {
    if (taskIds && !taskIds.includes(t.id)) continue;
    if (t.managedBy === "hub") continue; // 受管任务的生效值由 master 下发,不在本机重算
    const rule = bySource.get(t.id);
    // 绑定必须同房间(与 cli desiredFor 同口径)。
    const bound = rule && platformForRoom(t.room).extractRoomSlug(t.room) === rule.roomSlug ? rule : undefined;
    if (!bound) {
      store.updateTask(t.id, { rollingEffective: null });
      continue;
    }
    // 与 cli `desiredFor`(master 下发)传**同一组**入参(含 steps → 烧录互斥),两处判定结果恒一致。
    const policy = resolveRollingPolicy(
      { enabled: bound.enabled, mode: bound.pipeline?.upload?.mode, workers: bound.workers, steps: bound.pipeline?.steps },
      t.rollingUpload,
    );
    store.updateTask(t.id, { rollingEffective: policy.effective });
    noteRollingReason(store, t.id, policy, log);
    n++;
  }
  return n;
}
