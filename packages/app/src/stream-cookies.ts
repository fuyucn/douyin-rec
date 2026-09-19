/**
 * Resolve the effective cookie for a task's platform.
 *
 * Douyin uses the global Douyin account cookie (`defaultCookies`). Bilibili
 * streaming quality uses only its platform cookie/override. biliup
 * cookies.json is upload-only and must never be reused for recording.
 */
import type { Task, TaskStore } from "./store.js";

export function resolveTaskStreamCookies(
  task: Pick<Task, "platform" | "useCookie" | "cookies">,
  store: TaskStore,
): string | null {
  if (!task.useCookie) return null;
  const override = task.cookies?.trim();
  if (override) return override;

  const configured = store.getPlatformCookies(task.platform);
  if (configured) return configured;
  return null;
}
