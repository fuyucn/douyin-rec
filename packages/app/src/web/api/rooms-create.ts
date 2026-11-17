/** Create-room endpoint and its rollback helpers. */
import { forbidsStreamUploadSpool, parseOutputFormat, platformForRoom, STREAM_UPLOAD_NO_SPOOL_ERROR, streamUploadConflicts, type HubRulePayload } from "@drec/core";
import { refreshLocalRollingEffective } from "../../rolling-effective.js";
import * as hubStore from "../../hub-store.js";
import type { Task, TaskStore } from "../../store.js";
import { parseSchedule, toDanmuFlag } from "../../task-input.js";
import type { ApiCtx } from "./context.js";
import type { ApiResult, CreateRoomInput } from "./types.js";
import type { RoomReadModel } from "./rooms-read.js";

type Result<T> = { value: T; error: null } | { value: null; error: ApiResult };
type RoomIdentity = { room: string; platform: ReturnType<typeof platformForRoom>; roomSlug: string; key: string };
type PreparedCreate = {
  identity: RoomIdentity;
  recording: CreateRoomInput["recording"];
  processing: CreateRoomInput["processing"];
  scheduleStart: string | null;
  scheduleEnd: string | null;
  outputFormat: ReturnType<typeof parseOutputFormat>;
  existingRule: ReturnType<typeof hubStore.getHubRule>;
};
type Schedule = Pick<PreparedCreate, "scheduleStart" | "scheduleEnd">;
type ZeroDiskRule = Parameters<ApiCtx["zeroDiskErrorFor"]>[2];

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rollbackNewTask(store: TaskStore, id: number): string | null {
  try {
    if (store.removeTask(id)) return null;
    return "回滚未删除任务";
  } catch (error) {
    return "回滚异常:" + reasonOf(error);
  }
}

function roomIdentity(ctx: ApiCtx, room: string): Result<RoomIdentity> {
  try {
    const platform = platformForRoom(room);
    const roomSlug = platform.extractRoomSlug(room);
    if (!roomSlug) return { value: null, error: ctx.err(400, "房间地址非法,取不到房间号: " + room) };
    return { value: { room, platform, roomSlug, key: hubStore.hubKey(platform.id, roomSlug) }, error: null };
  } catch (error) {
    return { value: null, error: ctx.err(400, "房间地址非法:" + reasonOf(error)) };
  }
}

function scheduleOf(ctx: ApiCtx, input: CreateRoomInput["recording"]): Result<Schedule> {
  const start = input.scheduleStart ?? null;
  const end = input.scheduleEnd ?? null;
  const empty = (value: string | null): boolean => value == null || value.trim() === "";
  if (empty(start) !== empty(end)) {
    return { value: null, error: ctx.err(400, "定时窗口的起止需同时填写或同时留空") };
  }
  if (start == null || end == null || empty(start) || empty(end)) {
    return { value: { scheduleStart: null, scheduleEnd: null }, error: null };
  }
  try {
    const [scheduleStart, scheduleEnd] = parseSchedule(start + "-" + end);
    return { value: { scheduleStart, scheduleEnd }, error: null };
  } catch (error) {
    return { value: null, error: ctx.err(400, reasonOf(error)) };
  }
}

function validateRecordingModes(ctx: ApiCtx, recording: CreateRoomInput["recording"]): Result<ReturnType<typeof parseOutputFormat>> {
  if (streamUploadConflicts(recording.streamUpload === true, recording.rollingUpload === true)) {
    return { value: null, error: ctx.err(400, "streamUpload 与 rollingUpload 互斥:直播直传不写盘,滚动上传靠文件") };
  }
  if (recording.streamUpload === true && forbidsStreamUploadSpool(recording.streamUploadSpool)) {
    return { value: null, error: ctx.err(400, STREAM_UPLOAD_NO_SPOOL_ERROR) };
  }
  try {
    return { value: parseOutputFormat(recording.outputFormat), error: null };
  } catch (error) {
    return { value: null, error: ctx.err(400, reasonOf(error)) };
  }
}

function validateProcessing(ctx: ApiCtx, processing: CreateRoomInput["processing"], existing: PreparedCreate["existingRule"]): ApiResult | null {
  if (!processing) return null;
  const checkInput: HubRulePayload = {
    enabled: processing.enabled,
    pipeline: processing.pipeline,
    workers: processing.workers === null ? undefined : processing.workers,
    requires: processing.requires,
  };
  const workersError = ctx.validateWorkers(checkInput);
  if (workersError) return ctx.err(400, workersError);
  const pipelineError = ctx.validatePipeline(checkInput, existing?.pipeline);
  return pipelineError ? ctx.err(400, pipelineError) : null;
}

function prepareCreate(ctx: ApiCtx, model: RoomReadModel, input: CreateRoomInput): Result<PreparedCreate> {
  const room = (input.recording?.room ?? "").trim();
  if (!room) return { value: null, error: ctx.err(400, "recording.room 必填(新建房间必须能判定平台与房间号)") };
  if (input.processing && ctx.deps.hubEnabled !== true) {
    return { value: null, error: model.ruleWriteRefusal() };
  }
  const identityResult = roomIdentity(ctx, room);
  if (identityResult.error) return identityResult;
  const identity = identityResult.value;
  const duplicate = model.findTask(identity.platform.id, identity.roomSlug, null);
  if (duplicate) {
    return { value: null, error: ctx.err(409, "该房间已有录制任务(id=" + duplicate.id + "),请直接编辑它而不是新建") };
  }
  const scheduleResult = scheduleOf(ctx, input.recording);
  if (scheduleResult.error) return scheduleResult;
  const modeResult = validateRecordingModes(ctx, input.recording);
  if (modeResult.error) return modeResult;
  const existingRule = hubStore.getHubRule(ctx.hubDir, identity.key);
  const processingError = validateProcessing(ctx, input.processing, existingRule);
  if (processingError) return { value: null, error: processingError };
  return {
    value: {
      identity, recording: input.recording, processing: input.processing,
      scheduleStart: scheduleResult.value.scheduleStart,
      scheduleEnd: scheduleResult.value.scheduleEnd,
      outputFormat: modeResult.value, existingRule,
    },
    error: null,
  };
}

function addRecordingTask(ctx: ApiCtx, prepared: PreparedCreate): Result<Task> {
  const recording = prepared.recording;
  try {
    return {
      value: ctx.store.addTask({
        room: prepared.identity.room,
        name: recording.name ?? null,
        quality: recording.quality,
        engine: recording.engine,
        danmu: toDanmuFlag(recording.danmu),
        segmentSec: recording.segmentSec,
        cookies: recording.cookies ?? null,
        useCookie: ctx.toUseCookie(recording.useCookie),
        outDir: recording.outDir ?? null,
        scheduleStart: prepared.scheduleStart,
        scheduleEnd: prepared.scheduleEnd,
        webhook: ctx.normWebhook(recording.webhook),
        rollingUpload: recording.rollingUpload === true,
        streamUpload: recording.streamUpload === true,
        streamUploadSpool: true,
        outputFormat: prepared.outputFormat,
      }),
      error: null,
    };
  } catch (error) {
    return { value: null, error: ctx.err(400, "创建录制任务失败:" + reasonOf(error)) };
  }
}

function ruleViewForCreate(prepared: PreparedCreate): ZeroDiskRule {
  const existing = prepared.existingRule;
  const processing = prepared.processing;
  if (!existing && !processing) return null;
  const merged = hubStore.mergePipeline(existing?.pipeline, processing?.pipeline);
  return {
    enabled: processing?.enabled ?? existing?.enabled ?? true,
    mode: merged.upload?.mode ?? "upload",
    workers: processing?.workers === null ? [] : processing?.workers ?? existing?.workers,
    steps: merged.steps,
  };
}

function validateCreatedTask(ctx: ApiCtx, prepared: PreparedCreate, task: Task): ApiResult | null {
  const error = ctx.zeroDiskErrorFor(task.id, prepared.recording.streamUpload === true, ruleViewForCreate(prepared));
  if (!error) return null;
  const rollbackError = rollbackNewTask(ctx.store, task.id);
  if (rollbackError) {
    return ctx.err(500, error + ";**且刚建的任务未能回滚(" + rollbackError + ")** —— 房间 " + prepared.identity.key + " 的任务可能已创建(id=" + task.id + "),请手工核对");
  }
  return ctx.err(400, error);
}

function upsertProcessingRule(ctx: ApiCtx, prepared: PreparedCreate, task: Task): ApiResult | null {
  const processing = prepared.processing;
  if (!processing) return null;
  const { platform, roomSlug } = prepared.identity;
  try {
    hubStore.upsertHubRule(ctx.hubDir, {
      platform: platform.id, roomSlug, room: task.room,
      enabled: processing.enabled, pipeline: processing.pipeline,
      workers: processing.workers, requires: processing.requires,
      recording: { sourceTaskId: task.id },
    });
  } catch (error) {
    const rollbackError = rollbackNewTask(ctx.store, task.id);
    if (rollbackError) {
      return ctx.err(500, "写入处理配置失败(" + reasonOf(error) + ");**且新建的录制任务未能回滚(" + rollbackError + ")** —— 房间 " + prepared.identity.key + " 的任务可能已创建(id=" + task.id + "),请手工核对");
    }
    return ctx.err(500, "写入处理配置失败(" + reasonOf(error) + "),已回滚新建的录制任务");
  }
  refreshLocalRollingEffective(ctx.store, ctx.hubDir);
  return null;
}

export function createRoomCreateHandlers(ctx: ApiCtx, model: RoomReadModel) {
  return {
    createRoom(input: CreateRoomInput): ApiResult {
      const preparedResult = prepareCreate(ctx, model, input);
      if (preparedResult.error) return preparedResult.error;
      const prepared = preparedResult.value;
      const taskResult = addRecordingTask(ctx, prepared);
      if (taskResult.error) return taskResult.error;
      const task = taskResult.value;
      const zeroDiskError = validateCreatedTask(ctx, prepared, task);
      if (zeroDiskError) return zeroDiskError;
      const ruleError = upsertProcessingRule(ctx, prepared, task);
      if (ruleError) return ruleError;
      ctx.resolveAnchorBg(task.id, task.room);
      ctx.deps.requestSyncTasks?.();
      const room = model.view(prepared.identity.key);
      if (!room) return ctx.err(500, "房间创建后读不回来(store/hub 目录不一致?)");
      return { status: 201, body: room };
    },
  };
}
