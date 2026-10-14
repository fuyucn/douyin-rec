import type { Task } from "../api/client";

/**
 * issue #73:节点(worker)任务列表默认隐藏「受管 ∧ master 判定未分配 ∧ 未在录」的任务。
 * - `assigned` 缺省(旧 master / 非受管 / 无快照)→ 不隐藏(旧行为)。
 * - 正在录(或进程仍在跑)的永远显示,不能把真实在跑的东西藏起来。
 */
export function isUnassignedHidden(task: Task): boolean {
  return task.managedBy === "hub" && task.assigned === false && !task.recording && !task.running;
}
