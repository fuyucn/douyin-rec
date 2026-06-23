/** Shared hooks: toast helper (sonner), cookie-status loader, an interval poller. */
import { useSetAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { toast as sonnerToast } from "sonner";
import { api, ApiError } from "../api/client";
import { cookieStatusAtom } from "../atoms";

export type ToastType = "success" | "error" | "warning" | "info";

/** 直接弹一个 sonner toast(无需 hook,供 React 外/事件流复用)。 */
export function showToast(message: string, type: ToastType = "info"): void {
  switch (type) {
    case "success":
      sonnerToast.success(message);
      break;
    case "error":
      sonnerToast.error(message);
      break;
    case "warning":
      sonnerToast.warning(message);
      break;
    default:
      sonnerToast(message);
  }
}

/** Returns a stable `toast(message, type?)` backed by sonner. */
export function useToast(): (message: string, type?: ToastType) => void {
  return useCallback((message: string, type: ToastType = "info") => showToast(message, type), []);
}

/** Returns a stable callback that refreshes the global cookie-status atom. */
export function useRefreshCookie(): () => Promise<void> {
  const setCookie = useSetAtom(cookieStatusAtom);
  return useCallback(async () => {
    try {
      const s = await api.getCookie();
      setCookie(s);
    } catch {
      setCookie(null);
    }
  }, [setCookie]);
}

/** Run `fn` immediately then every `ms` while `enabled`. */
export function usePolling(fn: () => void, ms: number, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    if (!enabled) return;
    ref.current();
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}

/** Best-effort human message from an unknown thrown value. */
export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
