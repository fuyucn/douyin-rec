/** Delete-room endpoint; clear history before removing room configuration. */
import { activeHubJobKeys } from "../../hub-jobs.js";
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import * as hubStore from "../../hub-store.js";
import type { TaskStore } from "../../store.js";
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import type { RoomReadModel } from "./rooms-read.js";
import { removeRuleAfterHistory } from "./hub-rules.js";

function tryRemoveTask(store: TaskStore, taskId: number): boolean {
  try { return store.removeTask(taskId); }
  catch { return false; }
}

export function createRoomDeleteHandlers(ctx: ApiCtx, model: RoomReadModel) {
  const { deps, store, manager, hubDir, err } = ctx;
  const { parseKey, view } = model;
  return {
    deleteRoom(key: string): ApiResult {
      const k = parseKey(key);
      if (!k) return err(400, `房间 key 非法: ${key}(应为 {platform}.{roomSlug})`);
      const dto = view(key);
      if (!dto || (!dto.recording && !dto.processing)) return err(404, `未找到房间 ${key}`);

      // Validate both sides before changing any data.
      const taskId = dto.recording?.taskId ?? null;
      const task = taskId !== null ? store.getTask(taskId) : null;
      if (task) {
        if (task.managedBy === "hub") return err(403, `任务 id=${task.id} 由 hub 管理，请在 master 上删除`);
        if (task.enabled || manager.isRunning(task.id)) {
          return err(409, `任务 id=${task.id} 仍启用或运行中，请先停止再删除房间`);
        }
      }
      const rule = hubStore.getHubRule(hubDir, key);
      if (rule) {
        if (!deps.syncDbPath || !deps.deleteHubHistory) {
          return err(503, "hub 台账未就绪，无法安全删除房间；请检查服务配置后重试");
        }
        let active: string[];
        try {
          active = activeHubJobKeys(deps.syncDbPath, key);
        } catch {
          return err(503, "无法确认 hub 台账状态，房间未删除；请检查台账后重试");
        }
        if (active.length > 0) {
          return err(409, `该直播间有进行中的 hub 任务(${active[0]}),请先等它结束或停止后再删除房间`);
        }
      }

      let history = { deleted: 0 };
      if (rule && deps.syncDbPath && deps.deleteHubHistory) {
        try {
          history = deps.deleteHubHistory(deps.syncDbPath, key);
        } catch {
          return err(503, "无法安全清理处理历史，房间未删除；请检查台账后重试");
        }
      }

      // Remove the task and rule only after both guards and the transactional recheck pass.
      if (task && !tryRemoveTask(store, task.id)) {
        return err(500, "Failed to delete recording task (id=" + task.id + "). " + (rule ? "Processing history has already been cleared; " : "") + "room configuration was retained. Retry room deletion.");
      }
      const ruleError = rule ? removeRuleAfterHistory(ctx, key, "room", Boolean(task)) : null;
      if (ruleError) return ruleError;
      if (rule) {
        refreshLocalRollingEffective(store, hubDir); // Recompute source-task derived values after rule removal.
        deps.requestSyncTasks?.();
      }
      return { status: 200, body: { ok: true, key, deletedHistory: history.deleted } };
    }
  };
}
