import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotifyEvent } from "@drec/core";

const fake = vi.hoisted(() => ({ events: [] as NotifyEvent[] }));

vi.mock("@drec/app", () => ({
  makeNotifier: () => ({ notify: async (event: NotifyEvent) => { fake.events.push(event); } }),
  shouldSendWebhook: () => true,
  webhookTogglesFromEnv: () => ({ live: true, recordEnd: true, merge: true, hub: true, error: true }),
}));

import { recordNotifier } from "./cli-notifier.js";

describe("recordNotifier notification context (#734)", () => {
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    fake.events.length = 0;
  });

  it("adds a platform and room fallback to the external event and parent alert", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true as never);
    await recordNotifier(undefined, () => ({ platform: "douyin", roomSlug: "room-a" })).notify({
      kind: "error", stage: "直播直传", message: "段2 流式上传降级: 分块 49 上传失败",
    });

    expect(fake.events[0]).toMatchObject({
      kind: "error",
      ctx: { name: "douyin room-a", nameSource: "fallback", platform: "douyin", roomSlug: "room-a" },
    });
    const alertLine = write.mock.calls.map(([line]) => String(line)).find((line) => line.startsWith("@@DREC_ALERT@@"));
    expect(alertLine).toBeDefined();
    expect(JSON.parse(alertLine!.slice("@@DREC_ALERT@@".length)).ctx).toMatchObject({
      name: "douyin room-a", platform: "douyin", roomSlug: "room-a",
    });
  });

  it("preserves a task display name while retaining the platform and room", async () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true as never);
    await recordNotifier(undefined, () => ({ taskName: "主播甲", platform: "douyin", roomSlug: "room-a" })).notify({
      kind: "error", stage: "直播直传", message: "transport failed",
    });

    expect(fake.events[0]).toMatchObject({
      ctx: { name: "主播甲", nameSource: "task", platform: "douyin", roomSlug: "room-a" },
    });
  });
});
