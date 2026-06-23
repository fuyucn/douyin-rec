// ts/src/core/notify/discord.ts
import { createLogger } from "@drec/core";
import { type Notifier, type NotifyEvent, formatMessage } from "./notifier.js";

const log = createLogger("notifier");

/** POST 消息到 Discord incoming webhook。失败只 log，绝不抛（不得影响主流程）。 */
export class DiscordNotifier implements Notifier {
  constructor(private readonly webhook: string) {}
  async notify(e: NotifyEvent): Promise<void> {
    try {
      await fetch(this.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: formatMessage(e) }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (err) {
      log.warn(`Discord 推送失败（忽略）: ${(err as Error).message}`);
    }
  }
}
