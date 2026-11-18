/** Shared room identity parsing and view construction. */
import { platformForRoom, redactTaskSecrets, type RoomDTO, type RoomRecordingDTO } from "@drec/core";
import { nodeOutputFormatLock } from "../../node-remux.js";
import * as hubStore from "../../hub-store.js";
import type { Task } from "../../store.js";
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";

type RoomKey = { platform: string; roomSlug: string };

function parseRoomKey(key: string): RoomKey | null {
  const separator = key.indexOf(".");
  if (separator <= 0 || separator === key.length - 1) return null;
  const platform = key.slice(0, separator);
  const roomSlug = key.slice(separator + 1);
  return platform && roomSlug ? { platform, roomSlug } : null;
}

function stripIdentity(dto: RoomDTO["processing"] & { key?: string }): NonNullable<RoomDTO["processing"]> {
  const { key: _key, platform: _platform, roomSlug: _roomSlug, room: _room, ...rest } = dto as Record<string, unknown>;
  void _key; void _platform; void _roomSlug; void _room;
  return rest as NonNullable<RoomDTO["processing"]>;
}

function secretsOf(task: Task): Pick<RoomRecordingDTO, "cookies" | "webhook" | "hasCookies" | "hasWebhook"> {
  const { cookies, webhook, hasCookies, hasWebhook } = redactTaskSecrets(task);
  return { cookies, webhook, hasCookies, hasWebhook };
}

function recordingOf(task: Task | null, hubDir: string): RoomRecordingDTO | null {
  if (!task) return null;
  const lock = nodeOutputFormatLock(task, hubDir);
  return {
    ...(lock ? { outputFormatLock: lock } : {}),
    taskId: task.id,
    room: task.room,
    name: task.name,
    anchorName: task.anchorName,
    quality: task.quality,
    engine: task.engine,
    danmu: task.danmu,
    segmentSec: task.segmentSec,
    scheduleStart: task.scheduleStart,
    scheduleEnd: task.scheduleEnd,
    enabled: task.enabled,
    useCookie: task.useCookie,
    ...secretsOf(task),
    outDir: task.outDir,
    rollingUpload: task.rollingUpload,
    rollingEffective: task.rollingEffective,
    streamUpload: task.streamUpload,
    streamUploadSpool: task.streamUploadSpool,
    outputFormat: task.outputFormat,
  };
}

function findRoomTask(ctx: ApiCtx, platform: string, roomSlug: string, sourceTaskId: number | null): Task | null {
  const bound = sourceTaskId ? ctx.store.getTask(sourceTaskId) : null;
  if (bound) {
    const parsed = platformForRoom(bound.room);
    if (parsed.id === platform && parsed.extractRoomSlug(bound.room) === roomSlug) return bound;
  }
  return ctx.store.listTasks().find((task) => taskMatchesRoom(task, platform, roomSlug)) ?? null;
}

function taskMatchesRoom(task: Task, platform: string, roomSlug: string): boolean {
  try {
    const parsed = platformForRoom(task.room);
    return parsed.id === platform && parsed.extractRoomSlug(task.room) === roomSlug;
  } catch {
    return false;
  }
}

function roomView(ctx: ApiCtx, key: string): RoomDTO | null {
  const parsed = parseRoomKey(key);
  if (!parsed) return null;
  const rule = hubStore.listHubRules(ctx.hubDir).find((candidate) => candidate.key === key) ?? null;
  const task = findRoomTask(ctx, parsed.platform, parsed.roomSlug, rule?.recording?.sourceTaskId ?? null);
  return {
    key,
    platform: parsed.platform,
    roomSlug: parsed.roomSlug,
    room: rule?.room || task?.room || "",
    recording: recordingOf(task, ctx.hubDir),
    processing: rule ? stripIdentity(ctx.hubRuleView(rule)) : null,
  };
}

export function createRoomReadModel(ctx: ApiCtx) {
  return {
    parseKey: parseRoomKey,
    findTask: (platform: string, roomSlug: string, sourceTaskId: number | null) =>
      findRoomTask(ctx, platform, roomSlug, sourceTaskId),
    view: (key: string) => roomView(ctx, key),
    ruleWriteRefusal: () => ctx.err(400, "本节点未启用 hub(master),房间的处理半边只能在主控配置"),
  };
}
export type RoomReadModel = ReturnType<typeof createRoomReadModel>;

function roomKeys(ctx: ApiCtx): Set<string> {
  const keys = new Set(hubStore.listHubRules(ctx.hubDir).map((rule) => rule.key));
  for (const task of ctx.store.listTasks()) {
    try {
      const platform = platformForRoom(task.room);
      keys.add(platform.id + "." + platform.extractRoomSlug(task.room));
    } catch {
      // Invalid room URLs remain visible through /api/tasks, but not in the normalized room list.
    }
  }
  return keys;
}

export function createRoomReadHandlers(ctx: ApiCtx, model: RoomReadModel) {
  return {
    listRooms(): ApiResult {
      const rooms = [...roomKeys(ctx)].map(model.view).filter((room): room is RoomDTO => room !== null);
      return { status: 200, body: rooms };
    },
    getRoom(key: string): ApiResult {
      const parsed = model.parseKey(key);
      if (!parsed) return ctx.err(400, "房间 key 非法: " + key + "(应为 {platform}.{roomSlug})");
      const room = model.view(key);
      if (!room || (!room.recording && !room.processing)) return ctx.err(404, "未找到房间 " + key);
      return { status: 200, body: room };
    },
  };
}
