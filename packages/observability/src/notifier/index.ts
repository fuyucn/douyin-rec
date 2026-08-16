// observability/src/notifier/index.ts
import type { Notifier, NotifyEvent } from "@drec/core";
import { notifKeyOf, type NotifWebhookToggles } from "@drec/core";
export type { Notifier, NotifyEvent, NotifKey, NotifWebhookToggles } from "@drec/core";

/** 子进程 webhook 类型开关的注入环境变量(serve → record)。JSON 串,缺省全关。 */
export const WEBHOOK_TOGGLES_ENV = "DREC_WEBHOOK_TOGGLES";

/** 设置面板里每类提醒的 webhook 默认值:全关(需显式开启;无 webhook 时 UI 也禁用)。 */
export const DEFAULT_WEBHOOK_TOGGLES: NotifWebhookToggles = {
  live: false,
  recordEnd: false,
  merge: false,
  hub: false,
  error: false,
};

/**
 * 解析用户配置的 webhook 开关(设置表 JSON 串 / 子进程环境变量)。
 * 非法 JSON/未知键一律回落默认全关,避免未显式开启的类别推送 webhook。
 */
export function resolveWebhookToggles(raw: string | null | undefined): NotifWebhookToggles {
  if (!raw) return { ...DEFAULT_WEBHOOK_TOGGLES };
  try {
    const parsed = JSON.parse(raw) as Partial<NotifWebhookToggles>;
    return {
      ...DEFAULT_WEBHOOK_TOGGLES,
      ...Object.fromEntries(
        Object.entries(parsed).filter(([k, v]) => k in DEFAULT_WEBHOOK_TOGGLES && typeof v === "boolean"),
      ),
    } as NotifWebhookToggles;
  } catch {
    return { ...DEFAULT_WEBHOOK_TOGGLES };
  }
}

/** 子进程环境变量里的开关(serve 注入;手工跑 CLI 无此 env = 全关)。 */
export function webhookTogglesFromEnv(): NotifWebhookToggles {
  return resolveWebhookToggles(process.env[WEBHOOK_TOGGLES_ENV]);
}

/** 该事件是否应推 webhook:按类型开关过滤。 */
export function shouldSendWebhook(toggles: NotifWebhookToggles, e: NotifyEvent): boolean {
  return toggles[notifKeyOf(e)];
}

/** 未配置 webhook 时使用，全程 no-op。 */
export class NullNotifier implements Notifier {
  async notify(): Promise<void> { /* no-op */ }
}

/** 事件 → 一行中文消息（带 emoji）。 */
export function formatMessage(e: NotifyEvent): string {
  switch (e.kind) {
    case "recordStart": return `🔴 开播录制：${e.anchor || e.room}（房间 ${e.room}，画质 ${e.quality}）`;
    case "recordEnd":   return `⏹️ 录制结束${e.reason ? `（${e.reason}）` : ""}：${e.anchor || e.room}（房间 ${e.room}）→ ${e.outDir}`;
    case "recordReconnect": return `⚠️ 直播中断 ${e.downSec}s 后已重连，恢复录制：${e.anchor || e.room}（房间 ${e.room}）`;
    case "mergeDone":   return `🎬 合并完成：${e.file}`;
    case "burnDone":    return `🔥 烧录完成（${e.style}）：${e.file}`;
    case "uploadDone":  return `⬆️ 上传完成：${e.bv} ${e.url}`;
    case "hubTaskStart": return `📋 Hub 任务开始：${e.room}（${e.workers.length} 个节点：${e.workers.join(", ")}）· ${e.mode === "upload" ? "上传" : "仅合成"}`;
    case "error":       return `⚠️ 出错（${e.stage}）：${e.message}`;
  }
}

import { DiscordNotifier } from "./discord.js";
/** 有 webhook → DiscordNotifier；否则 NullNotifier。 */
export function makeNotifier(webhook?: string): Notifier {
  return webhook ? new DiscordNotifier(webhook) : new NullNotifier();
}
