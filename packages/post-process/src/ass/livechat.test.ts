// ts/test/post/livechat.test.ts
import { describe, it, expect } from "vitest";
import { LiveChatAss, type ChatItem } from "./livechat.js";

describe("livechat 堆叠 ASS", () => {
  const items: ChatItem[] = [
    { timeSec: 1, kind: "danmaku", uname: "A", content: "你好", color: "ffffff" },
    { timeSec: 2, kind: "gift", uname: "B", giftName: "玫瑰", giftCount: 3, color: "add8e6" },
    { timeSec: 3, kind: "member", uname: "C", color: "aaaaaa" },
  ];
  it("生成 LiveChat 样式 header + 堆叠 Dialogue（\\an1 \\clip \\pos）", () => {
    const out = new LiveChatAss({ width: 1920, height: 1080 }).write(items);
    expect(out).toContain("Style: LiveChat,");
    expect(out).toContain("PlayResX: 1920");
    expect(out).toMatch(/Dialogue: 1,[^,]+,[^,]+,LiveChat,,0,0,0,,\{\\an1\\q2\\clip\(/);
    expect(out).toContain("\\pos(");
    expect(out).toContain("A: 你好");
    // emoji 经 tagEmoji 包裹后 "🎁 B: 3个玫瑰" 整串可能断裂，断言非 emoji 片段
    expect(out).toContain("B: 3个玫瑰");
    // 进场消息
    expect(out).toContain("C 进入直播间");
  });
  it("空列表只输出 header（无 Dialogue）", () => {
    const out = new LiveChatAss({ width: 1280, height: 720 }).write([]);
    expect(out).toContain("[Events]");
    expect(out).not.toContain("Dialogue:");
  });
});
