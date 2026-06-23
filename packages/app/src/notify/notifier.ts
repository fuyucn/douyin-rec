// ts/src/core/notify/notifier.ts
import type { Notifier, NotifyEvent } from "@drec/core";
export type { Notifier, NotifyEvent } from "@drec/core";

/** 未配置 webhook 时使用，全程 no-op。 */
export class NullNotifier implements Notifier {
  async notify(): Promise<void> { /* no-op */ }
}

/** 事件 → 一行中文消息（带 emoji）。 */
export function formatMessage(e: NotifyEvent): string {
  switch (e.kind) {
    case "recordStart": return `🔴 开播录制：${e.anchor || e.room}（房间 ${e.room}，画质 ${e.quality}）`;
    case "recordEnd":   return `⏹️ 录制结束：${e.anchor || e.room}（房间 ${e.room}）→ ${e.outDir}`;
    case "mergeDone":   return `🎬 合并完成：${e.file}`;
    case "burnDone":    return `🔥 烧录完成（${e.style}）：${e.file}`;
    case "uploadDone":  return `⬆️ 上传完成：${e.bv} ${e.url}`;
    case "error":       return `⚠️ 出错（${e.stage}）：${e.message}`;
  }
}

import { DiscordNotifier } from "./discord.js";
/** 有 webhook → DiscordNotifier；否则 NullNotifier。 */
export function makeNotifier(webhook?: string): Notifier {
  return webhook ? new DiscordNotifier(webhook) : new NullNotifier();
}
