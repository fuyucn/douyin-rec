import { decorateRecordEvent, type Notifier, type NotifyEvent, type RecordNameFacts } from "@drec/core";
import type { Command } from "commander";
import {
  makeNotifier, shouldSendWebhook, webhookTogglesFromEnv, type NotifWebhookToggles,
} from "@drec/app";

export function commandWebhook(program: Command): string | undefined {
  return (program.opts() as { discordWebhook?: string }).discordWebhook ?? process.env.DISCORD_WEBHOOK;
}

/** Honor the parent's per-event webhook policy; manual CLI calls default to all disabled. */
export function toggledNotifier(
  webhook: string | undefined,
  toggles: NotifWebhookToggles = webhookTogglesFromEnv(),
): Notifier {
  const base = makeNotifier(webhook);
  return {
    notify: async (event: NotifyEvent): Promise<void> => {
      if (shouldSendWebhook(toggles, event)) await base.notify(event);
    },
  };
}

/** Recording errors also reach the parent's alert channel, independent of webhook filtering. */
export function recordNotifier(webhook: string | undefined, nameFacts?: () => RecordNameFacts): Notifier {
  const base = toggledNotifier(webhook);
  return {
    notify: async (event: NotifyEvent): Promise<void> => {
      const contextualEvent = nameFacts ? decorateRecordEvent(event, nameFacts()) : event;
      await base.notify(contextualEvent);
      if (contextualEvent.kind !== "error") return;
      try {
        const alert = {
          stage: contextualEvent.stage,
          message: contextualEvent.message,
          ...(contextualEvent.ctx ? { ctx: contextualEvent.ctx } : {}),
        };
        process.stdout.write("@@DREC_ALERT@@" + JSON.stringify(alert) + "\n");
      } catch { /* The parent channel is best-effort. */ }
    },
  };
}
