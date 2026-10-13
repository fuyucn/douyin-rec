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
import { platformForRoom, resolveRollingPolicy, type RollingPolicyRule } from "@drec/core";
import { listHubRules } from "./hub-store.js";
import type { TaskStore } from "./store.js";

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

/** 返回写入了派生值的任务数(无规则任务清为 NULL 不计)。 */
export function refreshLocalRollingEffective(store: TaskStore, hubDir: string): number {
  const bySource = new Map<number, ReturnType<typeof listHubRules>[number]>();
  for (const rule of listHubRules(hubDir)) {
    const id = rule.recording?.sourceTaskId;
    if (id != null) bySource.set(id, rule);
  }
  let n = 0;
  for (const t of store.listTasks()) {
    if (t.managedBy === "hub") continue; // 受管任务的生效值由 master 下发,不在本机重算
    const rule = bySource.get(t.id);
    // 绑定必须同房间(与 cli desiredFor 同口径)。
    const bound = rule && platformForRoom(t.room).extractRoomSlug(t.room) === rule.roomSlug ? rule : undefined;
    if (!bound) {
      store.updateTask(t.id, { rollingEffective: null });
      continue;
    }
    store.updateTask(t.id, {
      rollingEffective: resolveRollingPolicy(
        { mode: bound.pipeline?.upload?.mode, workers: bound.workers },
        t.rollingUpload,
      ).effective,
    });
    n++;
  }
  return n;
}
