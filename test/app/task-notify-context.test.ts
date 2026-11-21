import { describe, expect, it } from "vitest";
import type { NotifyEvent } from "../../packages/core/src/index.js";
import { decorateTaskNotifyEvent } from "../../packages/app/src/task-notify-context.js";

describe("decorateTaskNotifyEvent (#734)", () => {
  const task = { room: "https://live.douyin.com/room-a", name: null, anchorName: "房间甲" };

  it("fills the authoritative task identity for legacy child errors without context", () => {
    const result = decorateTaskNotifyEvent({ kind: "error", stage: "直播直传", message: "failed" }, task);
    expect(result).toMatchObject({
      ctx: { name: "房间甲", nameSource: "cached", platform: "douyin", roomSlug: "room-a" },
    });
  });

  it("rejects mismatched room labels but preserves actionable context fields", () => {
    const event = {
      kind: "error", stage: "直播直传", message: "failed",
      ctx: { name: "房间乙", nameSource: "cached", platform: "douyin", roomSlug: "room-b", next: "retry" },
    } as NotifyEvent;
    const result = decorateTaskNotifyEvent(event, task);
    expect(result.ctx).toMatchObject({
      name: "房间甲", nameSource: "cached", platform: "douyin", roomSlug: "room-a", next: "retry",
    });
  });

  it("keeps live context when it matches the task's room", () => {
    const event = {
      kind: "error", stage: "直播直传", message: "failed",
      ctx: { name: "房间甲最新名", nameSource: "live", platform: "douyin", roomSlug: "room-a" },
    } as NotifyEvent;
    expect(decorateTaskNotifyEvent(event, task).ctx?.name).toBe("房间甲最新名");
  });
});
