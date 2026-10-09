/**
 * web/api/hub-rules.ts — hub 规则 CRUD(文件版)+ 排序
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildHubRules(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import type { HubRulePayload, HubPipelineConfig, HubRecordingConfig } from "@drec/core";
import { platformForRoom } from "@drec/core";
import * as hubStore from "../../hub-store.js";
import { activeHubJobKeys, deleteHubJobHistory } from "../../hub-jobs.js";

export function buildHubRules(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, validateWorkers, validatePipeline, hubRuleView, recordingError } = ctx;
  return {
    hubStatus(): ApiResult {
      return { status: 200, body: { enabled: deps.hubEnabled ?? false } };
    },

    listHubRules(): ApiResult {
      return { status: 200, body: hubStore.listHubRules(hubDir).map(hubRuleView) };
    },

    createHubRule(input: HubRulePayload): ApiResult {
      const werr = validateWorkers(input);
      if (werr) return err(400, werr);
      const perr = validatePipeline(input);
      if (perr) return err(400, perr);
      const sourceTaskId = input.recording?.sourceTaskId;
      if (!sourceTaskId) return err(400, "新建 hub 规则必须绑定 source task（房间取自该任务）");
      const task = store.getTask(Number(sourceTaskId));
      if (!task) return err(400, "recording.sourceTaskId 指向的任务不存在");
      const platform = platformForRoom(task.room);
      const roomSlug = platform.extractRoomSlug(task.room);
      try {
        const rule = hubStore.upsertHubRule(hubDir, {
          platform: platform.id,
          roomSlug,
          room: task.room,
          enabled: input.enabled,
          pipeline: input.pipeline,
          recording: input.recording,
          workers: input.workers,
          requires: input.requires,
        });
        deps.requestSyncTasks?.();
        return { status: 201, body: hubRuleView(rule) };
      } catch (e) {
        return err(400, `无法解析房间地址: ${(e as Error).message}`);
      }
    },

    updateHubRule(key: string, input: HubRulePayload): ApiResult {
      const werr = validateWorkers(input);
      if (werr) return err(400, werr);
      const perr = validatePipeline(input);
      if (perr) return err(400, perr);
      const dot = key.indexOf(".");
      const ruleSlug = dot < 0 ? key : key.slice(dot + 1);
      const rerr = recordingError(input.recording?.sourceTaskId, ruleSlug);
      if (rerr) return err(400, rerr);
      const patch: { enabled?: boolean; pipeline?: HubPipelineConfig; recording?: HubRecordingConfig; workers?: string[]; requires?: string[] } = {};
      if ("enabled" in input) patch.enabled = input.enabled;
      if ("pipeline" in input) patch.pipeline = input.pipeline;
      if ("recording" in input) patch.recording = input.recording;
      if ("workers" in input) patch.workers = input.workers;
      if ("requires" in input) patch.requires = input.requires;
      const updated = hubStore.updateHubRule(hubDir, key, patch);
      if (!updated) return err(404, `未找到 hub 规则 key=${key}`);
      deps.requestSyncTasks?.();
      return { status: 200, body: hubRuleView(updated) };
    },

    deleteHubRule(key: string): ApiResult {
      const existing = hubStore.getHubRule(hubDir, key);
      if (!existing) return err(404, `未找到 hub 规则 key=${key}`);
      if (deps.syncDbPath) {
        const active = activeHubJobKeys(deps.syncDbPath, key);
        if (active.length > 0) {
          return err(409, `该直播间有进行中的 hub 任务(${active[0]}),请先等它结束或停止后再删除规则`);
        }
      }
      const history = deps.syncDbPath ? deleteHubJobHistory(deps.syncDbPath, key) : { deleted: 0, streamKeys: [] };
      const ok = hubStore.removeHubRule(hubDir, key);
      if (!ok) return err(404, `未找到 hub 规则 key=${key}`);
      deps.requestSyncTasks?.();
      return { status: 200, body: { ok: true, key, deletedHistory: history.deleted } };
    },

    reorderHubRules(input: { keys?: string[] }): ApiResult {
      if (!deps.hubEnabled) return err(400, "hub 未启用(仅 master 可管理规则)");
      if (!Array.isArray(input.keys)) return err(400, "keys 必填(数组)");
      try {
        const rules = hubStore.reorderHubRules(hubDir, input.keys);
        deps.requestSyncTasks?.();
        return { status: 200, body: rules.map(hubRuleView) };
      } catch (e) {
        return err(400, (e as Error).message);
      }
    },
  };
}
