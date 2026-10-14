/**
 * task-status.ts — 任务运行态 → 展示口径的**唯一**派生(Pure,可直测)。
 *
 * 为什么单独抽:详情页与状态徽标都要回答「这个任务现在算什么状态」,而输入有五个字段
 * (enabled / status / stopping / recording / recordingWorkers),判定顺序有语义
 * (停用优先、收尾优先于在录、远端在录优先于本地等待)。写两份必然漂移。
 */
import type { Task } from "../api/client";

export type TaskPhaseKind = "disabled" | "stopping" | "draining" | "recording" | "waiting" | "error" | "idle";

export interface TaskPhase {
  kind: TaskPhaseKind;
  /** i18n key(badge.*)。 */
  textKey: string;
  /** 正在录制的远端节点名(本地在录时为 null)。 */
  recordingNodes: string[];
  /** 远端状态为 unavailable 的节点名(探测不到)。 */
  unavailableNodes: string[];
}

type PhaseInput = Pick<Task, "enabled" | "status" | "recording"> & {
  stopping?: boolean;
  recordingWorkers?: Task["recordingWorkers"];
};

export function taskPhase(t: PhaseInput): TaskPhase {
  const nodes = (t.recordingWorkers ?? []).filter((w) => w.state === "recording").map((w) => w.workerName);
  const down = (t.recordingWorkers ?? []).filter((w) => w.state === "unavailable").map((w) => w.workerName);
  const base = { recordingNodes: nodes, unavailableNodes: down };
  // 顺序即语义:停用 > 收尾(硬停/排空)> 在录 > 等待 > 错误 > 待命。
  if (!t.enabled) return { ...base, kind: "disabled", textKey: "badge.disabled" };
  if (t.stopping) return { ...base, kind: "stopping", textKey: "badge.stopping" };
  if (t.status === "draining") return { ...base, kind: "draining", textKey: "badge.draining" };
  if (nodes.length > 0) return { ...base, kind: "recording", textKey: "badge.recordingOn" };
  if (t.recording) return { ...base, kind: "recording", textKey: "badge.recording" };
  if (t.status === "error") return { ...base, kind: "error", textKey: "badge.error" };
  if (t.recordingWorkers !== undefined && down.length > 0) return { ...base, kind: "waiting", textKey: "badge.workersUnavailable" };
  if (t.recordingWorkers !== undefined) return { ...base, kind: "waiting", textKey: "badge.workersIdle" };
  if (t.status === "running") return { ...base, kind: "waiting", textKey: "badge.waiting" };
  return { ...base, kind: "idle", textKey: "badge.idle" };
}

/** 徽标/文字配色(与既有 stateColor 的克制风格一致)。 */
export const PHASE_COLOR: Record<TaskPhaseKind, string> = {
  disabled: "var(--muted-soft)",
  stopping: "var(--warning)",
  draining: "var(--warning)",
  recording: "var(--success-fg)",
  waiting: "var(--muted)",
  error: "var(--error-fg)",
  idle: "var(--muted-soft)",
};
