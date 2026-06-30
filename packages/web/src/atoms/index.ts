/**
 * atoms/index.ts — jotai global state: tasks, cookie status.
 *
 * Toasts are handled by sonner (see lib/hooks.ts showToast/useToast + <Toaster/>
 * in App.tsx), not jotai — so no toast atoms live here anymore.
 */
import { atom } from "jotai";
import type { CookieStatus, Task } from "../api/client";

/** The task list (refreshed by a 2s poll on the list page). */
export const tasksAtom = atom<Task[]>([]);

/** Connection indicator for the list header. */
export type ConnState = { ok: boolean; at: number } | null;
export const connAtom = atom<ConnState>(null);

/** Global cookie status pill state (null = not yet loaded / errored). */
export const cookieStatusAtom = atom<CookieStatus | null>(null);

/** 本节点是否启用 hub(master)。null=未知/加载中,true=master,false=slave/未开。
 *  前端据此显示/隐藏「Hub」导航与页面(slave 上 hub 页无意义)。 */
export const hubEnabledAtom = atom<boolean | null>(null);
