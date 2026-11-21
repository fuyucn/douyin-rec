import { decorateRecordEvent, platformForRoom, type NotifyEvent } from "@drec/core";
import type { Task } from "./store.js";

type TaskIdentity = Pick<Task, "room" | "name" | "anchorName">;

export function decorateTaskNotifyEvent(event: NotifyEvent, task: TaskIdentity, liveAnchor?: string | null): NotifyEvent {
  try {
    const platform = platformForRoom(task.room);
    const roomSlug = platform.extractRoomSlug(task.room);
    const hasMatchingIdentity = event.ctx?.platform === platform.id && event.ctx.roomSlug === roomSlug;
    const sourceEvent = hasMatchingIdentity
      ? event
      : {
          ...event,
          ctx: event.ctx ? { ...event.ctx, name: undefined, nameSource: undefined, platform: undefined, roomSlug: undefined } : undefined,
        };
    return decorateRecordEvent(sourceEvent, {
      taskName: task.name,
      liveAnchor,
      cachedAnchor: task.anchorName,
      platform: platform.id,
      roomSlug,
    });
  } catch {
    return event;
  }
}
