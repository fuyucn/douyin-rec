/**
 * managed-state.ts — 节点侧「上次成功应用 master 期望」的**审计快照**。
 *
 * 用途：可观测 + 版本回执（见 plans/030_tasks.json 的 T16）。
 * **不是删除判定依据** —— 快照内容恒等于本轮 desired，用它做 diff 必然为空集；
 * 删除语义见 task-sync.ts（store 受管任务 − 期望 keys，由骤减守卫保护）。
 *
 * 落盘位置由调用方显式传入（`opts.managedStateDir`），**不从 DOUYIN_REC_ROOT 推导**：
 * 远端 `_apply-tasks <dataRoot>` 只带 dataRoot、不带环境变量，推导会写到错误的根。
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { RemoteTaskSpec } from "@drec/core";

/** 快照文件名（固定；同一节点只有一个 master 会下发）。 */
export const MANAGED_STATE_FILE = "rooms.json";

export interface ManagedState {
  /** 期望版本号（master 单调递增；未启用版本时为 0）。 */
  version: number;
  /** 本次成功应用时间（epoch ms）。 */
  savedAt: number;
  /** 本轮成功应用后的完整期望任务集。 */
  desired: RemoteTaskSpec[];
  /**
   * 应用这份期望的**节点 bundle 版本**（T16）。
   *
   * 为什么记它:master 只能看到「我发了什么」,看不到「节点用什么版本的应用了我发的」。
   * 节点跑着旧 bundle(部署漏了一台)时,新字段/新语义在它上面不生效,但 master 侧毫无痕迹。
   * 记下 appVersion 后,`_node-status` 能回吐,UI 可对「节点版本 ≠ master 版本」告警。
   * 缺省 undefined = 老快照(向后兼容,读回时视为 unknown)。
   */
  appVersion?: string;
}

/**
 * 读回快照。目录/文件不存在或内容损坏 → `null`（首次运行、agent 中断等场景必须安全降级，
 * 不能让 applyRemoteTasks 失败）。
 */
export function readManagedState(dir: string): ManagedState | null {
  if (!dir) return null;
  try {
    const raw = JSON.parse(readFileSync(join(dir, MANAGED_STATE_FILE), "utf-8")) as Partial<ManagedState>;
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.desired)) return null;
    return {
      version: typeof raw.version === "number" ? raw.version : 0,
      savedAt: typeof raw.savedAt === "number" ? raw.savedAt : 0,
      desired: raw.desired,
    };
  } catch {
    return null;
  }
}

/**
 * 原子写快照：临时文件 + rename（master/reconciler 可能同时读，避免读到半截 JSON）。
 * 写失败只冒泡给调用方，由调用方降级为 log —— **绝不因快照写失败影响任务下发**。
 */
export function writeManagedState(dir: string, state: Omit<ManagedState, "savedAt"> & { savedAt?: number }): void {
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, MANAGED_STATE_FILE);
  const tmp = join(dir, `.${MANAGED_STATE_FILE}.tmp`);
  const body: ManagedState = { version: state.version ?? 0, savedAt: state.savedAt ?? Date.now(), desired: state.desired };
  writeFileSync(tmp, JSON.stringify(body, null, 2) + "\n", "utf-8");
  renameSync(tmp, path);
}

/** 删除快照（维护/回滚用；不存在不报错）。 */
export function clearManagedState(dir: string): void {
  if (!dir) return;
  try {
    rmSync(join(dir, MANAGED_STATE_FILE), { force: true });
  } catch {
    /* 快照是尽力而为的产物，删除失败无需反噬 */
  }
}
