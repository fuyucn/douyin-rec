/**
 * task-status.ts — 任务运行态 → 展示口径的**唯一**派生(Pure,可直测)。
 *
 * 为什么单独抽:详情页与状态徽标都要回答「这个任务现在算什么状态」,而输入有五个字段
 * (enabled / status / stopping / recording / recordingWorkers),判定顺序有语义
 * (停用优先、收尾优先于在录、远端在录优先于本地等待)。写两份必然漂移。
 */
import type { Task } from "../api/client";

export type TaskPhaseKind = "disabled" | "stopping" | "draining" | "recording" | "waiting" | "offline" | "error" | "idle";

export interface TaskPhase {
  kind: TaskPhaseKind;
  /** i18n key(badge.*)。 */
  textKey: string;
  /** 正在录制的远端节点名(本地在录时为 null)。 */
  recordingNodes: string[];
  /** 远端状态为 unavailable 的节点名(探测不到)。 */
  unavailableNodes: string[];
}

type PhaseInput = Pick<Task, "enabled" | "status" | "running"> & {
  stopping?: boolean;
  recording?: boolean;
  recordingWorkers?: Task["recordingWorkers"];
};

/**
 * 判定顺序 = 原 StatusBadge 的分支顺序(停用 > 收尾 > 排空 > 远端在录 > 远端等待/离线 > 本地在录/等待 > 错误 > 待命)。
 *
 * 为什么强调「顺序不能动」:这些输入会重叠(远端在录时 status 也可能是 error;排空时 recording 仍为 true),
 * 换一下顺序就会把「节点离线」显示成「等待开播」、或把「双录中某节点报错」显示成「错误」。
 * 重构时**逐情形对照过原实现**,颜色/脉冲也一并搬过来(不是顺手美化)。
 */
export function taskPhase(t: PhaseInput): TaskPhase {
  const workers = t.recordingWorkers ?? [];
  const nodes = workers.filter((w) => w.state === "recording").map((w) => w.workerName);
  const down = workers.filter((w) => w.state === "unavailable").map((w) => w.workerName);
  const base = { recordingNodes: nodes, unavailableNodes: down };
  if (!t.enabled) return { ...base, kind: "disabled", textKey: "badge.disabled" };
  if (t.stopping) return { ...base, kind: "stopping", textKey: "badge.stopping" };
  if (t.status === "draining") return { ...base, kind: "draining", textKey: "badge.draining" };
  if (nodes.length > 0) return { ...base, kind: "recording", textKey: "badge.recordingOn" };
  // 远端有绑定但都没在录:离线(红)优先于「等待开播」(灰) —— 离线是故障,不能被等待文案盖掉。
  if (workers.length > 0) {
    if (down.length > 0) return { ...base, kind: "offline", textKey: "badge.workersUnavailable" };
    return { ...base, kind: "waiting", textKey: "badge.workersIdle" };
  }
  // 本地:进程在跑但没拿到流 → 等待开播;真在录 → 录制中。
  if (t.running) {
    if (t.recording === false) return { ...base, kind: "waiting", textKey: "badge.waiting" };
    return { ...base, kind: "recording", textKey: "badge.recording" };
  }
  if (t.status === "error") return { ...base, kind: "error", textKey: "badge.error" };
  return { ...base, kind: "idle", textKey: "badge.idle" };
}

/** 徽标配色 / 是否脉冲。与判定同文件:改档位时不可能只改一处。 */
export interface PhaseStyle {
  tone: string;
  dot: string;
  pulse: boolean;
  color: string;
}

export const PHASE_STYLE: Record<TaskPhaseKind, PhaseStyle> = {
  disabled: { tone: "badge-neutral", dot: "var(--muted-soft)", pulse: false, color: "var(--muted-soft)" },
  stopping: { tone: "badge-orange", dot: "var(--warning)", pulse: true, color: "var(--warning-fg)" },
  draining: { tone: "badge-orange", dot: "var(--warning)", pulse: true, color: "var(--warning-fg)" },
  recording: { tone: "badge-success", dot: "var(--success)", pulse: true, color: "var(--success-fg)" },
  waiting: { tone: "badge-neutral", dot: "var(--muted-soft)", pulse: false, color: "var(--muted)" },
  offline: { tone: "badge-error", dot: "var(--error)", pulse: false, color: "var(--error-fg)" },
  error: { tone: "badge-error", dot: "var(--error)", pulse: false, color: "var(--error-fg)" },
  idle: { tone: "badge-neutral", dot: "var(--muted-soft)", pulse: false, color: "var(--muted-soft)" },
};
