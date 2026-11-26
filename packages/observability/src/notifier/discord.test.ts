import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotifyEvent } from "@drec/core";
import { DiscordNotifier } from "./discord.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("DiscordNotifier", () => {
  it("bounds webhook content to Discord's 2,000-character limit", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const event: NotifyEvent = { kind: "error", stage: "upload", message: "x".repeat(3000) };

    await new DiscordNotifier("https://example.invalid/webhook").notify(event);

    const init = fetchMock.mock.calls[0]?.[1];
    const payload = JSON.parse(String(init?.body)) as { content: string };
    expect(Array.from(payload.content)).toHaveLength(2000);
    expect(payload.content.endsWith("…")).toBe(true);
  });

  it("logs non-success webhook responses without throwing", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 400, statusText: "Bad Request" }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const event: NotifyEvent = { kind: "error", stage: "upload", message: "failed" };

    await expect(new DiscordNotifier("https://example.invalid/webhook").notify(event)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith("[notifier]", expect.stringContaining("HTTP 400 Bad Request"));
  });
});
