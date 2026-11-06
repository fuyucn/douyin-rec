import { describe, expect, it } from "vitest";
import { findCreatedRoom, findExistingRoom } from "../../packages/web/src/lib/room-create.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

describe("room lookup around create", () => {
  const room = (key: string, room: string, taskId: number | null): RoomDTO => ({
    key, platform: key.split(".")[0]!, roomSlug: key.split(".")[1]!, room,
    recording: taskId === null ? null : ({ taskId } as RoomDTO["recording"]),
    processing: null,
  });
  const rooms = [
    room("douyin.100001", "https://live.douyin.com/100001", 3),
    room("douyin.100002", "https://live.douyin.com/100002", null),
  ];

  it("existing room with a task is a duplicate (bare id or full URL); rule-only room is not", () => {
    expect(findExistingRoom(rooms, "douyin", "100001")?.key).toBe("douyin.100001");
    expect(findExistingRoom(rooms, "douyin", "https://live.douyin.com/100001")?.key).toBe("douyin.100001");
    expect(findExistingRoom(rooms, "bilibili", "100001")).toBeUndefined();
    expect(findExistingRoom(rooms, "douyin", "100002")).toBeUndefined();
  });

  it("created room is matched by task id, never by URL text", () => {
    expect(findCreatedRoom(rooms, 3)?.key).toBe("douyin.100001");
    // Same URL but another task owns the view → no match, so the caller won't rebind that rule.
    expect(findCreatedRoom(rooms, 9)).toBeUndefined();
  });
});
