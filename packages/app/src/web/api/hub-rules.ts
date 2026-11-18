/** Hub-rule CRUD and reorder endpoints. */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import type { HubRulePayload, HubPipelineConfig, HubRecordingConfig } from "@drec/core";
import { platformForRoom } from "@drec/core";
import * as hubStore from "../../hub-store.js";
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import { activeHubJobKeys } from "../../hub-jobs.js";

function createHubRule(ctx: ApiCtx, input: HubRulePayload): ApiResult {
  const workersError = ctx.validateWorkers(input);
  if (workersError) return ctx.err(400, workersError);
  const sourceTaskId = input.recording?.sourceTaskId;
  if (!sourceTaskId) return ctx.err(400, "新建 hub 规则必须绑定 source task（房间取自该任务）");
  const task = ctx.store.getTask(Number(sourceTaskId));
  if (!task) return ctx.err(400, "recording.sourceTaskId 指向的任务不存在");
  const platform = platformForRoom(task.room);
  const roomSlug = platform.extractRoomSlug(task.room);
  const recordingError = task.streamUpload ? null : ctx.recordingError(sourceTaskId, roomSlug);
  if (recordingError) return ctx.err(400, recordingError);
  const key = hubStore.hubKey(platform.id, roomSlug);
  const existing = hubStore.getHubRule(ctx.hubDir, key);
  const validationError = ctx.validatePipeline(input, existing?.pipeline);
  if (validationError) return ctx.err(400, validationError);
  const ruleView = mergedRuleView(input, existing);
  const zeroDiskError = ctx.zeroDiskErrorFor(sourceTaskId, task.streamUpload, ruleView);
  if (zeroDiskError) return ctx.err(400, zeroDiskError);
  const roomError = ctx.zeroDiskRoomError(platform.id, roomSlug, ruleView);
  if (roomError) return ctx.err(400, roomError);
  try {
    const rule = hubStore.upsertHubRule(ctx.hubDir, {
      platform: platform.id, roomSlug, room: task.room,
      enabled: input.enabled, pipeline: input.pipeline, recording: input.recording,
      workers: input.workers, requires: input.requires,
    });
    refreshLocalRollingEffective(ctx.store, ctx.hubDir);
    ctx.deps.requestSyncTasks?.();
    return { status: 201, body: ctx.hubRuleView(rule) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return ctx.err(400, "无法解析房间地址: " + reason);
  }
}

function mergedRuleView(input: HubRulePayload, existing: ReturnType<typeof hubStore.getHubRule>) {
  const merged = hubStore.mergePipeline(existing?.pipeline, input.pipeline);
  return {
    enabled: input.enabled ?? existing?.enabled,
    mode: merged.upload?.mode,
    workers: input.workers ?? existing?.workers,
    steps: merged.steps,
  };
}

function patchHubRule(input: HubRulePayload): {
  enabled?: boolean; pipeline?: HubPipelineConfig; recording?: HubRecordingConfig; workers?: string[]; requires?: string[];
} {
  const patch: ReturnType<typeof patchHubRule> = {};
  if ("enabled" in input) patch.enabled = input.enabled;
  if ("pipeline" in input) patch.pipeline = input.pipeline;
  if ("recording" in input) patch.recording = input.recording;
  if ("workers" in input) patch.workers = input.workers;
  if ("requires" in input) patch.requires = input.requires;
  return patch;
}

function updateHubRule(ctx: ApiCtx, key: string, input: HubRulePayload): ApiResult {
  const workersError = ctx.validateWorkers(input);
  if (workersError) return ctx.err(400, workersError);
  const existing = hubStore.getHubRule(ctx.hubDir, key);
  const pipelineError = ctx.validatePipeline(input, existing?.pipeline);
  if (pipelineError) return ctx.err(400, pipelineError);
  const dot = key.indexOf(".");
  const ruleSlug = dot < 0 ? key : key.slice(dot + 1);
  const recordingError = ctx.recordingError(input.recording?.sourceTaskId, ruleSlug, existing);
  if (recordingError) return ctx.err(400, recordingError);
  const sourceTaskId = input.recording?.sourceTaskId ?? existing?.recording?.sourceTaskId ?? null;
  const sourceTask = sourceTaskId ? ctx.store.getTask(Number(sourceTaskId)) : null;
  const ruleView = mergedRuleView(input, existing);
  const zeroDiskError = ctx.zeroDiskErrorFor(sourceTaskId, sourceTask?.streamUpload, ruleView);
  if (zeroDiskError) return ctx.err(400, zeroDiskError);
  const roomError = ctx.zeroDiskRoomError(key.slice(0, dot), ruleSlug, ruleView);
  if (roomError) return ctx.err(400, roomError);
  const updated = hubStore.updateHubRule(ctx.hubDir, key, patchHubRule(input));
  if (!updated) return ctx.err(404, "未找到 hub 规则 key=" + key);
  ctx.settleLegacyRolling(updated.recording?.sourceTaskId, input.pipeline?.upload?.mode);
  refreshLocalRollingEffective(ctx.store, ctx.hubDir);
  ctx.deps.requestSyncTasks?.();
  return { status: 200, body: ctx.hubRuleView(updated) };
}

function deleteHubRule(ctx: ApiCtx, key: string): ApiResult {
  const existing = hubStore.getHubRule(ctx.hubDir, key);
  if (!existing) return ctx.err(404, "未找到 hub 规则 key=" + key);
  if (!ctx.deps.syncDbPath || !ctx.deps.deleteHubHistory) {
    return ctx.err(503, "hub 台账未就绪，无法安全删除规则；请检查服务配置后重试");
  }
  const activeError = activeJobError(ctx, key);
  if (activeError) return activeError;
  const history = deleteRuleHistory(ctx, key);
  if (history.error) return history.error;
  const ruleError = removeRuleAfterHistory(ctx, key, "rule");
  if (ruleError) return ruleError;
  refreshLocalRollingEffective(ctx.store, ctx.hubDir);
  ctx.deps.requestSyncTasks?.();
  return { status: 200, body: { ok: true, key, deletedHistory: history.deleted } };
}

export function removeRuleAfterHistory(
  ctx: ApiCtx, key: string, retryTarget: "room" | "rule", taskRemoved = false,
): ApiResult | null {
  try {
    if (hubStore.removeHubRule(ctx.hubDir, key)) return null;
  } catch {
    // History is already committed; report the partial result for either failure mode.
  }
  const taskState = taskRemoved ? " Recording task has also been removed." : "";
  return ctx.err(500, `Failed to delete processing rule (${key}). Processing history has already been cleared.${taskState} Retry ${retryTarget} deletion.`);
}

function activeJobError(ctx: ApiCtx, key: string): ApiResult | null {
  try {
    const active = activeHubJobKeys(ctx.deps.syncDbPath!, key);
    return active.length === 0 ? null : ctx.err(409, "该直播间有进行中的 hub 任务(" + active[0] + "),请先等它结束或停止后再删除规则");
  } catch {
    return ctx.err(503, "无法确认 hub 台账状态，规则未删除；请检查台账后重试");
  }
}

function deleteRuleHistory(ctx: ApiCtx, key: string): { deleted: number; error: ApiResult | null } {
  try {
    const result = ctx.deps.deleteHubHistory!(ctx.deps.syncDbPath!, key);
    return { deleted: result.deleted, error: null };
  } catch {
    return { deleted: 0, error: ctx.err(503, "无法安全清理处理历史，规则未删除；请检查台账后重试") };
  }
}

function reorderHubRules(ctx: ApiCtx, input: { keys?: string[] }): ApiResult {
  if (!ctx.deps.hubEnabled) return ctx.err(400, "hub 未启用(仅 master 可管理规则)");
  if (!Array.isArray(input.keys)) return ctx.err(400, "keys 必填(数组)");
  try {
    const rules = hubStore.reorderHubRules(ctx.hubDir, input.keys);
    ctx.deps.requestSyncTasks?.();
    return { status: 200, body: rules.map(ctx.hubRuleView) };
  } catch (error) {
    return ctx.err(400, error instanceof Error ? error.message : String(error));
  }
}

function applyHubTasks(ctx: ApiCtx, opts?: { force?: boolean }): ApiResult {
  if (!(ctx.deps.hubEnabled ?? false)) return ctx.err(400, "本节点未启用 hub(master)");
  if (!ctx.deps.requestSyncTasks) return ctx.err(400, "hub 任务同步未就绪");
  ctx.deps.requestSyncTasks({ force: opts?.force === true });
  return { status: 202, body: { triggered: true, force: opts?.force === true } };
}

export function buildHubRules(ctx: ApiCtx) {
  return {
    hubStatus: (): ApiResult => ({ status: 200, body: { enabled: ctx.deps.hubEnabled ?? false } }),
    applyHubTasks: (opts?: { force?: boolean }): ApiResult => applyHubTasks(ctx, opts),
    listHubRules: (): ApiResult => ({ status: 200, body: hubStore.listHubRules(ctx.hubDir).map(ctx.hubRuleView) }),
    createHubRule: (input: HubRulePayload): ApiResult => createHubRule(ctx, input),
    updateHubRule: (key: string, input: HubRulePayload): ApiResult => updateHubRule(ctx, key, input),
    deleteHubRule: (key: string): ApiResult => deleteHubRule(ctx, key),
    reorderHubRules: (input: { keys?: string[] }): ApiResult => reorderHubRules(ctx, input),
  };
}
