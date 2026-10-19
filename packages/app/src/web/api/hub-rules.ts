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
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import { activeHubJobKeys, deleteHubJobHistory } from "../../hub-jobs.js";

export function buildHubRules(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, validateWorkers, validatePipeline, hubRuleView, recordingError } = ctx;
  return {
    hubStatus(): ApiResult {
      return { status: 200, body: { enabled: deps.hubEnabled ?? false } };
    },

    /**
     * POST /api/hub/apply?force=1 — 立刻触发一次全节点任务同步。
     *
     * `force=1` 让节点跳过 T-2 期望骤减安全阀:这是「用户确认要把房间从某节点撤下 /
     * 清空某节点受管任务」的唯一合法出口(没有它,合法缩容与「master 读不到规则」这两种
     * 情况在节点侧无法区分,守卫会一直拦 → 旧节点继续双录)。
     *
     * 语义要点:
     * - **异步**:只触发不等待节点往返(节点可能离线);结果看 serve 日志的
     *   `[hub] 任务同步 …` / `被节点安全阀拒绝` 行。
     * - **非 master 返回 400**:单机/worker 节点没有 hub 编排,假装成功会让 UI 显示「已同步」。
     * - force 由 cli 侧**累积**到合并补跑那一轮,同步在途时点也不会丢(见 cli requestHubSync)。
     */
    applyHubTasks(opts?: { force?: boolean }): ApiResult {
      if (!(deps.hubEnabled ?? false)) return err(400, "本节点未启用 hub(master)");
      if (!deps.requestSyncTasks) return err(400, "hub 任务同步未就绪");
      deps.requestSyncTasks({ force: opts?.force === true });
      return { status: 202, body: { triggered: true, force: opts?.force === true } };
    },

    listHubRules(): ApiResult {
      return { status: 200, body: hubStore.listHubRules(hubDir).map(hubRuleView) };
    },

    createHubRule(input: HubRulePayload): ApiResult {
      const werr = validateWorkers(input);
      if (werr) return err(400, werr);
      const sourceTaskId = input.recording?.sourceTaskId;
      if (!sourceTaskId) return err(400, "新建 hub 规则必须绑定 source task（房间取自该任务）");
      const task = store.getTask(Number(sourceTaskId));
      if (!task) return err(400, "recording.sourceTaskId 指向的任务不存在");
      const platform = platformForRoom(task.room);
      const roomSlug = platform.extractRoomSlug(task.room);
      // 复用唯一判定(存在性 / 房间一致性 / 0 落盘不可绑规则),不要在这里另写一份 ——
      // 此前 createHubRule 只内联查了存在性,漏掉 streamUpload 守卫,能绕过它建出
      // 永远选不到 winner 的规则。
      const rerr = recordingError(sourceTaskId, roomSlug);
      if (rerr) return err(400, rerr);
      // 同房间规则已存在时 upsert 会深合并 pipeline → 按合并后校验。
      const perr = validatePipeline(input, hubStore.getHubRule(hubDir, hubStore.hubKey(platform.id, roomSlug))?.pipeline);
      if (perr) return err(400, perr);
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
        // 新建规则不收口旧开关:此前没有规则可展示「迁移后的 rolling」,旧开关 true 的任务保持 rolling(同改前)。
        refreshLocalRollingEffective(store, hubDir);
        deps.requestSyncTasks?.();
        return { status: 201, body: hubRuleView(rule) };
      } catch (e) {
        return err(400, `无法解析房间地址: ${(e as Error).message}`);
      }
    },

    updateHubRule(key: string, input: HubRulePayload): ApiResult {
      const werr = validateWorkers(input);
      if (werr) return err(400, werr);
      const perr = validatePipeline(input, hubStore.getHubRule(hubDir, key)?.pipeline);
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
      ctx.settleLegacyRolling(updated.recording?.sourceTaskId, input.pipeline?.upload?.mode);
      // 解绑(sourceTaskId 清空)/停用/换 mode 后立刻重算本机派生值,不等下一个同步 tick。
      refreshLocalRollingEffective(store, hubDir);
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
      refreshLocalRollingEffective(store, hubDir); // 规则已删:本机源任务派生值回落,不再边传
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
