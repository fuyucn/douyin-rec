// ts/test/notify/notifier.test.ts
import { describe, it, expect, vi } from "vitest";
import { formatMessage, formatRoomUrl, makeNotifier, NullNotifier, type NotifyEvent } from "../../packages/observability/src/notifier/index.js";
import { DiscordNotifier } from "../../packages/observability/src/notifier/discord.js";

describe("notifier", () => {
  it("formatMessage 各事件含关键信息", () => {
    expect(formatMessage({ kind: "recordStart", anchor: "A", room: "123", quality: "origin" })).toContain("A");
    expect(formatMessage({ kind: "uploadDone", bv: "BV1x", url: "https://b/BV1x" })).toContain("BV1x");
    expect(formatMessage({ kind: "error", stage: "burn", message: "boom" })).toContain("boom");
    expect(formatMessage({ kind: "burnDone", style: "danmu", file: "/o/x_danmu.mp4" })).toContain("danmu");
    // stage 正常终点:不再是「出错」文案
    const stageMsg = formatMessage({ kind: "stageReady", streamKey: "douyin:1:2026-09-28" });
    expect(stageMsg).toContain("待人工上传");
    expect(stageMsg).not.toContain("出错");
  });
  // issue #588：房间 URL 与后续中文/全角标点之间必须有显式链接边界，否则 Discord 客户端把
  // 「，画质 origin」等并进链接。纯房号路径必须保持原样。
  describe("房间链接边界（#588）", () => {
    const url = "https://live.douyin.com/ROOM";

    it("recordStart / recordEnd / recordReconnect：http(s) URL 用 <> 包裹，标点在边界外", () => {
      expect(formatMessage({ kind: "recordStart", anchor: "A", room: url, quality: "origin" }))
        .toBe(`🔴 开播录制：A（房间 <${url}>，画质 origin）`);
      expect(formatMessage({ kind: "recordEnd", anchor: "A", room: url, outDir: "/o" }))
        .toBe(`⏹️ 录制结束：A（房间 <${url}>）→ /o`);
      expect(formatMessage({ kind: "recordReconnect", anchor: "A", room: url, downSec: 5 }))
        .toBe(`⚠️ 直播中断 5s 后已重连，恢复录制：A（房间 <${url}>）`);
    });

    it("大写 scheme、query 与 fragment 整体留在边界内", () => {
      expect(formatRoomUrl("HTTP://live.douyin.com/ROOM?x=1#f")).toBe("<HTTP://live.douyin.com/ROOM?x=1#f>");
    });

    it("非 URL 原样返回：纯房号 / 空串 / 无 scheme 短链 / 其它协议 / 控制字符与尖括号", () => {
      expect(formatRoomUrl("123456")).toBe("123456");
      expect(formatRoomUrl("")).toBe("");
      expect(formatRoomUrl("v.douyin.com/ROOM")).toBe("v.douyin.com/ROOM");
      expect(formatRoomUrl("javascript:alert(1)")).toBe("javascript:alert(1)");
      expect(formatRoomUrl("https://x\n画质")).toBe("https://x\n画质");
      expect(formatRoomUrl("https://x/<bad>")).toBe("https://x/<bad>");
    });

    it("anchor 为空时 URL 兜底也带边界（不留下第二个裸链接）", () => {
      expect(formatMessage({ kind: "recordStart", anchor: "", room: url, quality: "origin" }))
        .toBe(`🔴 开播录制：<${url}>（房间 <${url}>，画质 origin）`);
    });

    it("空 room 走 anchor 兜底，不产生空链接", () => {
      const msg = formatMessage({ kind: "recordReconnect", anchor: "A", room: "", downSec: 5 });
      expect(msg).toContain("A");
      expect(msg).not.toContain("<");
    });

    it("hubTaskStart 的纯房间号不出现 <>（对照组）", () => {
      const msg = formatMessage({ kind: "hubTaskStart", room: "123456", workers: ["w"], mode: "upload" });
      expect(msg).toBe("📋 Hub 任务开始：123456（1 个节点：w）· 上传");
      expect(msg).not.toContain("<");
    });
  });

  it("makeNotifier：无 webhook → NullNotifier（no-op 不抛）", async () => {
    const n = makeNotifier(undefined);
    expect(n).toBeInstanceOf(NullNotifier);
    await n.notify({ kind: "error", stage: "x", message: "y" });   // 不抛
  });
  it("DiscordNotifier：webhook 失败只吞错不抛", async () => {
    const spy = vi.spyOn(globalThis, "fetch" as never).mockRejectedValue(new Error("net") as never);
    const n = new DiscordNotifier("https://discord/webhook");
    await expect(n.notify({ kind: "mergeDone", file: "/o/x.mp4" })).resolves.toBeUndefined();  // 不抛
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
  it("DiscordNotifier：POST body 含 content", async () => {
    let body = "";
    const spy = vi.spyOn(globalThis, "fetch" as never).mockImplementation((async (_u: string, init: { body: string }) => {
      body = init.body; return { ok: true } as Response;
    }) as never);
    await new DiscordNotifier("https://d/w").notify({ kind: "recordStart", anchor: "主播X", room: "1", quality: "origin" });
    expect(JSON.parse(body).content).toContain("主播X");
    spy.mockRestore();
  });
});
