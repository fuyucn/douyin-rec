// ts/test/post/emoji.test.ts
import { describe, it, expect } from "vitest";
import { isEmoji, tagEmoji, EMOJI_FONT } from "./emoji.js";

describe("emoji", () => {
  it("isEmoji 识别区间", () => {
    expect(isEmoji(0x1f600)).toBe(true);   // 😀
    expect(isEmoji(0x2764)).toBe(true);     // ❤ (0x2600-0x27BF)
    expect(isEmoji("中".codePointAt(0)!)).toBe(false);
  });
  it("tagEmoji 用 \\fn 包裹 emoji 段，结尾切回主字体", () => {
    expect(tagEmoji("hi😀x", "MainFont"))
      .toBe(`hi{\\fn${EMOJI_FONT}}😀{\\fnMainFont}x`);
    expect(tagEmoji("纯文本", "MainFont")).toBe("纯文本");
    expect(tagEmoji("末尾😀", "MainFont"))
      .toBe(`末尾{\\fn${EMOJI_FONT}}😀{\\fnMainFont}`);
  });
});
