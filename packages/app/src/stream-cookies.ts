/**
 * Resolve the effective cookie for a task's platform.
 *
 * Douyin uses the global Douyin account cookie (`defaultCookies`). Bilibili
 * streaming quality uses Bilibili login cookies; reuse biliup's cookies.json
 * unless the task has an explicit override.
 */
import type { Task, TaskStore } from "./store.js";
import { readBiliupCookieHeader } from "./upload/biliup.js";

export function resolveTaskStreamCookies(
  task: Pick<Task, "platform" | "useCookie" | "cookies">,
  store: TaskStore,
): string | null {
  if (!task.useCookie) return null;
  const override = task.cookies?.trim();
  if (override) return override;

  const configured = store.getPlatformCookies(task.platform);
  if (configured) return configured;
  if (task.platform === "bilibili") return readBiliupCookieHeader();
  return null;
}
