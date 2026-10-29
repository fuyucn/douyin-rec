/**
 * core/task-redact.ts — the ONE redaction point for task secrets in API output.
 *
 * Per-task `cookies` and `webhook` are credentials. Every DTO that embeds a task (list, detail,
 * create/update responses, room views) must pass the stored task through {@link redactTaskSecrets}
 * so the values never leave the process; clients only learn whether a secret is set.
 */

/** Secret-bearing task fields that must never be serialized. */
export interface TaskSecrets {
  cookies: string | null;
  webhook: string | null;
}

/** What a client sees instead of {@link TaskSecrets}. */
export interface RedactedTaskSecrets {
  cookies: null;
  webhook: null;
  hasCookies: boolean;
  hasWebhook: boolean;
}

/**
 * Internal-only task fields that never reach API output: the master-delivered zero-disk metadata
 * (issue #331) carries node paths and the upload account key. Clients get the status DTO instead.
 */
type InternalTaskFields = "zeroDiskDelivery";

/** Strip secret values from a task-shaped object, leaving presence flags. Pure; does not mutate. */
export function redactTaskSecrets<T extends TaskSecrets>(t: T): Omit<T, keyof TaskSecrets | InternalTaskFields> & RedactedTaskSecrets {
  const out = { ...t } as Record<string, unknown>;
  delete out.zeroDiskDelivery;
  return {
    ...(out as Omit<T, keyof TaskSecrets | InternalTaskFields>),
    cookies: null,
    webhook: null,
    hasCookies: !!t.cookies?.trim(),
    hasWebhook: !!t.webhook?.trim(),
  };
}
