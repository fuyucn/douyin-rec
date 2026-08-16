import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_WEBHOOK_TOGGLES,
  resolveWebhookToggles,
  shouldSendWebhook,
  webhookTogglesFromEnv,
  WEBHOOK_TOGGLES_ENV,
  type NotifWebhookToggles,
} from "../../packages/observability/src/notifier/index.js";
import { EventCenter } from "../../packages/observability/src/bus.js";

describe("webhook 类型开关", () => {
  it("默认全关;显式保存的 JSON 逐项覆盖,未知键/非法 JSON 回落默认", () => {
    expect(DEFAULT_WEBHOOK_TOGGLES).toEqual({ live: false, recordEnd: false, merge: false, hub: false, error: false });
    expect(resolveWebhookToggles(undefined)).toEqual(DEFAULT_WEBHOOK_TOGGLES);
    expect(resolveWebhookToggles("{bad json")).toEqual(DEFAULT_WEBHOOK_TOGGLES);

    const partial: NotifWebhookToggles = { ...DEFAULT_WEBHOOK_TOGGLES, live: true, error: true };
    expect(resolveWebhookToggles(JSON.stringify(partial))).toEqual({ ...DEFAULT_WEBHOOK_TOGGLES, live: true, error: true });

    // 未知键("future")与字符串值("true")被丢弃,不污染已知键。
    const dirty = JSON.stringify({ ...partial, future: true, merge: "true" as never });
    expect(resolveWebhookToggles(dirty)).toEqual({ ...DEFAULT_WEBHOOK_TOGGLES, live: true, error: true });
  });

  it("事件 kind 映射:recordStart/reconnect→live,recordEnd→recordEnd,merge/burn/upload→merge,hubTaskStart→hub,error→error", () => {
    const allOn: NotifWebhookToggles = { live: true, recordEnd: true, merge: true, hub: true, error: true };
    expect(shouldSendWebhook(allOn, { kind: "recordStart", anchor: "A", room: "r", quality: "o" })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "recordReconnect", anchor: "A", room: "r", downSec: 5 })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "recordEnd", anchor: "A", room: "r", outDir: "/o" })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "mergeDone", file: "/o/a.mp4" })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "burnDone", style: "danmu", file: "/o/a_danmu.mp4" })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "uploadDone", bv: "BV1x", url: "https://b/BV1x" })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "hubTaskStart", streamKey: "k", room: "r", workers: ["w"], mode: "stage" })).toBe(true);
    expect(shouldSendWebhook(allOn, { kind: "error", stage: "merge", message: "boom" })).toBe(true);

    const onlyLive: NotifWebhookToggles = { ...DEFAULT_WEBHOOK_TOGGLES, live: true };
    expect(shouldSendWebhook(onlyLive, { kind: "recordStart", anchor: "A", room: "r", quality: "o" })).toBe(true);
    expect(shouldSendWebhook(onlyLive, { kind: "mergeDone", file: "/o/a.mp4" })).toBe(false);
    expect(shouldSendWebhook(onlyLive, { kind: "error", stage: "merge", message: "boom" })).toBe(false);
  });

  it("EventCenter:webhookToggles 关闭的类别不发 webhook;webhook=false 仍只进本地流", () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const toggles: NotifWebhookToggles = { ...DEFAULT_WEBHOOK_TOGGLES, merge: true };
    const ec = new EventCenter({
      makeNotifier: () => ({ notify }),
      resolveWebhook: () => "https://hook",
      webhookToggles: () => toggles,
    });
    ec.emit(1, { kind: "mergeDone", file: "/a.mp4" }); // merge 开 → 发
    ec.emit(1, { kind: "recordStart", anchor: "A", room: "r", quality: "o" }); // live 关 → 不发
    ec.emit(1, { kind: "uploadDone", bv: "BV1x", url: "https://b/BV1x" }, { webhook: false }); // 显式关
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith({ kind: "mergeDone", file: "/a.mp4" });
  });

  it("webhookTogglesFromEnv:env 缺省全关;注入 JSON 后按值解析", () => {
    const prev = process.env[WEBHOOK_TOGGLES_ENV];
    try {
      delete process.env[WEBHOOK_TOGGLES_ENV];
      expect(webhookTogglesFromEnv()).toEqual(DEFAULT_WEBHOOK_TOGGLES);
      process.env[WEBHOOK_TOGGLES_ENV] = JSON.stringify({ live: true });
      expect(webhookTogglesFromEnv()).toEqual({ ...DEFAULT_WEBHOOK_TOGGLES, live: true });
    } finally {
      if (prev === undefined) delete process.env[WEBHOOK_TOGGLES_ENV];
      else process.env[WEBHOOK_TOGGLES_ENV] = prev;
    }
  });
});
