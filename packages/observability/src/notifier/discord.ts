// observability/src/notifier/discord.ts
import { createLogger } from "@drec/core";
import { type Notifier, type NotifyEvent, formatMessage } from "./index.js";

const log = createLogger("notifier");
const MAX_CONTENT_LENGTH = 2000;

function boundedContent(content: string): string {
  const characters = Array.from(content);
  if (characters.length <= MAX_CONTENT_LENGTH) return content;
  return `${characters.slice(0, MAX_CONTENT_LENGTH - 1).join("")}…`;
}

/** Post to Discord without allowing webhook failures to affect the main workflow. */
export class DiscordNotifier implements Notifier {
  constructor(private readonly webhook: string) {}
  async notify(e: NotifyEvent): Promise<void> {
    try {
      const response = await fetch(this.webhook, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: boundedContent(formatMessage(e)) }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) {
        log.warn(`Discord push failed (ignored): HTTP ${response.status} ${response.statusText}`);
      }
    } catch (err) {
      log.warn(`Discord push failed (ignored): ${(err as Error).message}`);
    }
  }
}
