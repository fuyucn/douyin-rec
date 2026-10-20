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

/** Strip secret values from a task-shaped object, leaving presence flags. Pure; does not mutate. */
export function redactTaskSecrets<T extends TaskSecrets>(t: T): Omit<T, keyof TaskSecrets> & RedactedTaskSecrets {
  return {
    ...t,
    cookies: null,
    webhook: null,
    hasCookies: !!t.cookies?.trim(),
    hasWebhook: !!t.webhook?.trim(),
  };
}
