/** Update-room endpoint and rollback-key selection. */
import { forbidsStreamUploadSpool, parseOutputFormat, platformForRoom, STREAM_UPLOAD_NO_SPOOL_ERROR, streamUploadConflicts, type HubRulePayload, type RoomPayload } from "@drec/core";
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import * as hubStore from "../../hub-store.js";
import type { Task, TaskStore } from "../../store.js";
import { parseSchedule, toDanmuFlag } from "../../task-input.js";
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import type { RoomReadModel } from "./rooms-read.js";

export type RecordingPatch = Parameters<TaskStore["updateTask"]>[1];
export type RecordingKey = keyof RecordingPatch & keyof Task;
const _patchKeysAreTaskFields: [Exclude<keyof RecordingPatch, keyof Task>] extends [never] ? true : never = true;
void _patchKeysAreTaskFields;

type Result<T> = { value: T; error: null } | { value: null; error: ApiResult };
type ParsedRoomKey = NonNullable<ReturnType<RoomReadModel["parseKey"]>>;
type RoomView = NonNullable<ReturnType<RoomReadModel["view"]>>;
type UpdateTarget = { key: string; parsed: ParsedRoomKey; before: RoomView; recording?: RoomPayload["recording"]; processing?: RoomPayload["processing"] };
type RecordingEffect = { taskId: number | null; snapshot: Task | null; undoKeys: RecordingKey[] };

/** Selects only fields changed by the forward update and its derived columns. */
export function rollbackKeys(patch: RecordingPatch): RecordingKey[] {
  const keys = new Set(Object.keys(patch) as RecordingKey[]);
  if (keys.has("room")) { keys.add("quality"); keys.add("engine"); }
  if (keys.has("rollingUpload")) keys.add("rollingEffective");
  return [...keys];
}

function resolveTarget(ctx: ApiCtx, model: RoomReadModel, key: string, input: RoomPayload): Result<UpdateTarget> {
  const parsed = model.parseKey(key);
  if (!parsed) return { value: null, error: ctx.err(400, "房间 key 非法: " + key + "(应为 {platform}.{roomSlug})") };
  if (input.recording === undefined && input.processing === undefined) {
    return { value: null, error: ctx.err(400, "recording 与 processing 至少传一个") };
  }
  const before = model.view(key);
  if (!before) return { value: null, error: ctx.err(404, "未找到房间 " + key) };
  if (input.processing && ctx.deps.hubEnabled !== true) {
    return { value: null, error: model.ruleWriteRefusal() };
  }
  return { value: { key, parsed, before, recording: input.recording, processing: input.processing }, error: null };
}

function validateNextRule(ctx: ApiCtx, target: UpdateTarget): Result<boolean> {
  const { key, parsed, before, recording, processing } = target;
  const nextStreamUpload = recording && "streamUpload" in recording
    ? recording.streamUpload === true
    : before.recording?.streamUpload === true;
  if (nextStreamUpload && forbidsStreamUploadSpool(recording?.streamUploadSpool)) {
    return { value: null, error: ctx.err(400, STREAM_UPLOAD_NO_SPOOL_ERROR) };
  }
  const nextRoom = (recording?.room ?? before.room).trim() || before.room;
  const nextPlatform = platformForRoom(nextRoom);
  const nextSlug = nextPlatform.extractRoomSlug(nextRoom);
  const nextKey = hubStore.hubKey(nextPlatform.id, nextSlug);
  const sameKey = nextKey === key;
  const nextRule = hubStore.getHubRule(ctx.hubDir, nextKey);
  const merged = hubStore.mergePipeline(nextRule?.pipeline, sameKey ? processing?.pipeline : undefined);
  const ruleAfter = Boolean(nextRule || processing || before.processing);
  const rule = ruleAfter ? {
    enabled: (sameKey ? processing?.enabled : undefined) ?? nextRule?.enabled ?? before.processing?.enabled ?? true,
    mode: merged.upload?.mode ?? (nextRule || before.processing ? "upload" : undefined),
    workers: sameKey ? processing?.workers === null ? [] : processing?.workers ?? nextRule?.workers : nextRule?.workers,
    steps: merged.steps,
  } : null;
  const zeroDiskError = ctx.zeroDiskErrorFor(before.recording?.taskId ?? null, nextStreamUpload, rule);
  if (zeroDiskError) return { value: null, error: ctx.err(400, zeroDiskError) };
  if (processing && sameKey) {
    const roomError = ctx.zeroDiskRoomError(parsed.platform, parsed.roomSlug, {
      enabled: processing.enabled ?? before.processing?.enabled ?? true,
      mode: merged.upload?.mode,
      workers: processing.workers === null ? [] : processing.workers ?? before.processing?.workers,
      steps: merged.steps,
    }, { taskId: before.recording?.taskId ?? null, streamUpload: nextStreamUpload });
    if (roomError) return { value: null, error: ctx.err(400, roomError) };
  }
  return { value: nextStreamUpload, error: null };
}

function validateProcessing(ctx: ApiCtx, target: UpdateTarget): ApiResult | null {
  const processing = target.processing;
  if (!processing) return null;
  const payload: HubRulePayload = {
    enabled: processing.enabled,
    pipeline: processing.pipeline,
    workers: processing.workers === null ? undefined : processing.workers,
    requires: processing.requires,
  };
  const workersError = ctx.validateWorkers(payload);
  if (workersError) return ctx.err(400, workersError);
  const pipelineError = ctx.validatePipeline(payload, hubStore.getHubRule(ctx.hubDir, target.key)?.pipeline);
  return pipelineError ? ctx.err(400, pipelineError) : null;
}

function prepareUpdate(ctx: ApiCtx, model: RoomReadModel, key: string, input: RoomPayload): Result<UpdateTarget & { zeroDiskNext: boolean }> {
  const targetResult = resolveTarget(ctx, model, key, input);
  if (targetResult.error) return targetResult;
  const target = targetResult.value;
  const ruleResult = validateNextRule(ctx, target);
  if (ruleResult.error) return ruleResult;
  const processingError = validateProcessing(ctx, target);
  if (processingError) return { value: null, error: processingError };
  return { value: { ...target, zeroDiskNext: ruleResult.value }, error: null };
}

function empty(value: string | null | undefined): boolean {
  return value == null || value.trim() === "";
}

function schedulePatch(ctx: ApiCtx, recording: NonNullable<RoomPayload["recording"]>, patch: RecordingPatch): ApiResult | null {
  const hasStart = "scheduleStart" in recording;
  const hasEnd = "scheduleEnd" in recording;
  if (hasStart !== hasEnd) return ctx.err(400, "定时窗口需同时提供 scheduleStart 与 scheduleEnd(或都传 null 清空)");
  if (!hasStart) return null;
  const start = recording.scheduleStart;
  const end = recording.scheduleEnd;
  if (empty(start) && empty(end)) {
    patch.scheduleStart = null;
    patch.scheduleEnd = null;
    return null;
  }
  if (empty(start) !== empty(end)) return ctx.err(400, "定时窗口的起止需同时填写或同时留空");
  try {
    const [scheduleStart, scheduleEnd] = parseSchedule(start + "-" + end);
    patch.scheduleStart = scheduleStart;
    patch.scheduleEnd = scheduleEnd;
    return null;
  } catch (error) {
    return ctx.err(400, error instanceof Error ? error.message : String(error));
  }
}

function buildRecordingPatch(ctx: ApiCtx, target: UpdateTarget): Result<RecordingPatch> {
  const recording = target.recording;
  if (!recording) return { value: {}, error: null };
  const patch: RecordingPatch = {};
  if ("room" in recording) {
    const room = (recording.room ?? "").trim();
    if (!room) return { value: null, error: ctx.err(400, "recording.room 不能为空") };
    patch.room = room;
  }
  if ("name" in recording) patch.name = recording.name ?? null;
  if ("quality" in recording) patch.quality = recording.quality;
  if ("engine" in recording) patch.engine = recording.engine;
  if ("danmu" in recording) patch.danmu = toDanmuFlag(recording.danmu);
  if ("segmentSec" in recording) patch.segmentSec = recording.segmentSec;
  const scheduleError = schedulePatch(ctx, recording, patch);
  if (scheduleError) return { value: null, error: scheduleError };
  if ("useCookie" in recording) patch.useCookie = ctx.toUseCookie(recording.useCookie);
  if ("cookies" in recording) patch.cookies = recording.cookies ?? null;
  if ("outDir" in recording) patch.outDir = recording.outDir ?? null;
  if ("webhook" in recording) patch.webhook = ctx.normWebhook(recording.webhook);
  if ("rollingUpload" in recording) patch.rollingUpload = recording.rollingUpload === true;
  if ("streamUpload" in recording) patch.streamUpload = recording.streamUpload === true;
  if ("streamUploadSpool" in recording) patch.streamUploadSpool = true;
  const conflicts = streamUploadConflicts(patch.streamUpload ?? target.before.recording?.streamUpload, patch.rollingUpload ?? target.before.recording?.rollingUpload);
  if (conflicts) return { value: null, error: ctx.err(400, "streamUpload 与 rollingUpload 互斥:直播直传不写盘,滚动上传靠文件") };
  if ("outputFormat" in recording) {
    try { patch.outputFormat = parseOutputFormat(recording.outputFormat); }
    catch (error) { return { value: null, error: ctx.err(400, error instanceof Error ? error.message : String(error)) }; }
  }
  return { value: patch, error: null };
}

function hasRecordingChanges(patch: RecordingPatch): boolean {
  return Object.keys(patch).some((field) => field !== "webhook");
}

function writeRecording(ctx: ApiCtx, target: UpdateTarget, patch: RecordingPatch): Result<RecordingEffect> {
  const taskId = target.before.recording?.taskId ?? null;
  if (!target.recording || taskId === null) {
    if (hasRecordingChanges(patch)) return { value: null, error: ctx.err(400, "该房间还没有绑定录制任务,请先创建任务再改录制配置") };
    return { value: { taskId, snapshot: null, undoKeys: [] }, error: null };
  }
  const task = ctx.store.getTask(taskId);
  if (!task) return { value: null, error: ctx.err(404, "房间 " + target.key + " 绑定的录制任务已不存在(id=" + taskId + ")") };
  if (task.managedBy === "hub") return { value: null, error: ctx.err(403, "任务 id=" + taskId + " 由 hub 管理,请在 master 上修改") };
  if (!ctx.store.updateTask(taskId, patch)) return { value: null, error: ctx.err(500, "写入录制配置失败(id=" + taskId + ")") };
  return { value: { taskId, snapshot: task, undoKeys: rollbackKeys(patch) }, error: null };
}

function rollbackRecording(ctx: ApiCtx, effect: RecordingEffect): boolean {
  if (!effect.snapshot || effect.taskId === null) return true;
  const previous: Record<string, unknown> = {};
  for (const field of effect.undoKeys) previous[field] = effect.snapshot[field];
  try { return ctx.store.updateTask(effect.taskId, previous as RecordingPatch) !== null; }
  catch { return false; }
}

function failAfterRecording(ctx: ApiCtx, target: UpdateTarget, effect: RecordingEffect, status: number, reason: string): ApiResult {
  if (!effect.snapshot) return ctx.err(status, reason);
  if (!rollbackRecording(ctx, effect)) {
    return ctx.err(500, reason + ";**且录制配置的回滚也失败了** —— 该房间 " + target.key + " 的录制半边可能已被改动,请手工核对");
  }
  return ctx.err(status, reason + ",已回滚录制配置");
}

function applyProcessing(ctx: ApiCtx, target: UpdateTarget, effect: RecordingEffect, zeroDiskNext: boolean): ApiResult | null {
  const processing = target.processing;
  if (!processing) return null;
  const before = target.before;
  const sourceTaskId = before.processing
    ? ((before.processing as { recording?: { sourceTaskId?: number | null } }).recording?.sourceTaskId ?? effect.taskId)
    : effect.taskId;
  const boundRule = zeroDiskNext && sourceTaskId ? { recording: { sourceTaskId } } : hubStore.getHubRule(ctx.hubDir, target.key);
  const recordingError = ctx.recordingError(sourceTaskId, target.parsed.roomSlug, boundRule);
  if (recordingError) return failAfterRecording(ctx, target, effect, 400, recordingError);
  try {
    hubStore.upsertHubRule(ctx.hubDir, {
      platform: target.parsed.platform, roomSlug: target.parsed.roomSlug, room: before.room,
      enabled: processing.enabled, pipeline: processing.pipeline, workers: processing.workers,
      requires: processing.requires, recording: sourceTaskId ? { sourceTaskId } : undefined,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return failAfterRecording(ctx, target, effect, 500, "写入处理配置失败(" + reason + ")");
  }
  if (before.processing) ctx.settleLegacyRolling(sourceTaskId, processing.pipeline?.upload?.mode);
  refreshLocalRollingEffective(ctx.store, ctx.hubDir);
  ctx.deps.requestSyncTasks?.();
  return null;
}

function syncRecordingOnly(ctx: ApiCtx, target: UpdateTarget, effect: RecordingEffect): void {
  if (target.recording && effect.taskId !== null && ctx.isHubSourceTask(effect.taskId)) ctx.deps.requestSyncTasks?.();
}

function updateRoom(ctx: ApiCtx, model: RoomReadModel, key: string, input: RoomPayload): ApiResult {
  const prepared = prepareUpdate(ctx, model, key, input);
  if (prepared.error) return prepared.error;
  const target = prepared.value;
  const patch = buildRecordingPatch(ctx, target);
  if (patch.error) return patch.error;
  const written = writeRecording(ctx, target, patch.value);
  if (written.error) return written.error;
  const effect = written.value;
  const processingError = applyProcessing(ctx, target, effect, target.zeroDiskNext);
  if (processingError) return processingError;
  if (!target.processing) syncRecordingOnly(ctx, target, effect);
  const after = model.view(key);
  if (!after) return ctx.err(500, "写入后房间读不回来(store/hub 目录不一致?)");
  return { status: 200, body: after };
}

export function createRoomUpdateHandlers(ctx: ApiCtx, model: RoomReadModel) {
  return { updateRoom: (key: string, input: RoomPayload): ApiResult => updateRoom(ctx, model, key, input) };
}
