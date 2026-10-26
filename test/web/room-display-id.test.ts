import { describe, expect, it } from "vitest";
import { roomDisplayId } from "../../packages/web/src/lib/labels";
import { roomName } from "../../packages/web/src/pages/rooms/shared";
import type { RoomDTO } from "../../packages/web/src/api/client";

describe("roomDisplayId - compact room identifier for list cells", () => {
  it("prefers the normalized slug over long platform URLs", () => {
    expect(
      roomDisplayId({
        room: "https://live.bilibili.com/1724219649", // issue-guard: allow
        roomSlug: "1724219649", // issue-guard: allow
      }),
    ).toBe("1724219649"); // issue-guard: allow
    expect(
      roomDisplayId({
        room: "https://live.kuaishou.com/u/myhx123456789", // issue-guard: allow
        roomSlug: "myhx123456789", // issue-guard: allow
      }),
    ).toBe("myhx123456789"); // issue-guard: allow
  });

  it("falls back to roomId when the slug is missing or blank", () => {
    expect(roomDisplayId({ room: "https://live.douyin.com/767116735823", roomSlug: "" })).toBe( // issue-guard: allow
      "767116735823", // issue-guard: allow
    );
    expect(roomDisplayId({ room: "123456" })).toBe("123456");
  });
});

describe("roomName - shared room display fallback", () => {
  it("uses the compact room identifier when task and anchor names are absent", () => {
    const room = {
      key: "douyin.slug",
      platform: "douyin",
      roomSlug: "slug",
      room: "https://live.douyin.com/123456",
      recording: null,
      processing: null,
    } satisfies RoomDTO;

    expect(roomName(room)).toBe("slug");
  });
});
