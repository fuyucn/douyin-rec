import { describe, expect, it } from "vitest";
import { roomDisplayId } from "../../packages/web/src/lib/labels";

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
