// ts/test/notify/notifier.test.ts
import { describe, it, expect, vi } from "vitest";
import { formatMessage, makeNotifier, NullNotifier, type NotifyEvent } from "../../packages/app/src/notify/notifier.js";
import { DiscordNotifier } from "../../packages/app/src/notify/discord.js";

describe("notifier", () => {
  it("formatMessage 各事件含关键信息", () => {
    expect(formatMessage({ kind: "recordStart", anchor: "A", room: "123", quality: "origin" })).toContain("A");
    expect(formatMessage({ kind: "uploadDone", bv: "BV1x", url: "https://b/BV1x" })).toContain("BV1x");
    expect(formatMessage({ kind: "error", stage: "burn", message: "boom" })).toContain("boom");
    expect(formatMessage({ kind: "burnDone", style: "danmu", file: "/o/x_danmu.mp4" })).toContain("danmu");
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
