import { describe, expect, it } from "vitest";
import { roomDisplayId } from "../../packages/web/src/lib/labels";

describe("roomDisplayId - compact room identifier for list cells", () => {
  it("prefers the normalized slug over long platform URLs", () => {
    expect(
      roomDisplayId({
        room: "https://live.bilibili.com/1724219649",
        roomSlug: "1724219649",
      }),
    ).toBe("1724219649");
    expect(
      roomDisplayId({
        room: "https://live.kuaishou.com/u/myhx123456789",
        roomSlug: "myhx123456789",
      }),
    ).toBe("myhx123456789");
  });

  it("falls back to roomId when the slug is missing or blank", () => {
    expect(roomDisplayId({ room: "https://live.douyin.com/767116735823", roomSlug: "" })).toBe(
      "767116735823",
    );
    expect(roomDisplayId({ room: "123456" })).toBe("123456");
  });
});
