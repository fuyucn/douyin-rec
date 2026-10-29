/** Shared hooks: toast helper (sonner), cookie-status loader, an interval poller, SSE 状态流。 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast as sonnerToast } from "sonner";
import { api, ApiError, type CookieStatus } from "../api/client";
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

/**
 * Per-platform account status (GET /api/cookies), loaded while `enabled` (a form is open) and reloaded
 * when the global douyin status changes (e.g. after QR login). `null` until loaded or when the request
 * fails; callers fall back via `cookieReadyFor`.
 */
export function usePlatformCookieStatuses(enabled: boolean): CookieStatus[] | null {
  const douyin = useAtomValue(cookieStatusAtom);
  const [statuses, setStatuses] = useState<CookieStatus[] | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void api.getCookies().then((r) => alive && setStatuses(r.platforms)).catch(() => alive && setStatuses(null));
    return () => {
      alive = false;
    };
  }, [enabled, douyin]);
  return statuses;
}

/**
 * Run `fn` immediately then every `ms` while `enabled`.
 * 重入守卫:上一次 tick 还没结束就跳过本次(慢请求下不会堆积成一串并发请求)。
 * 注意:守卫只防「并发」,不排队 —— 需要「期间有新触发必须补一次」的语义请用 `useHubStream`。
 */
export function usePolling(fn: () => void | Promise<void>, ms: number, enabled = true): void {
  const ref = useRef(fn);
  ref.current = fn;
  const running = useRef(false);
  useEffect(() => {
    if (!enabled) return;
    const tick = (): void => {
      if (running.current) return;
      running.current = true;
      // fn 返回 promise 时守卫覆盖整个 await 周期(慢请求下不堆积);同步返回则等价于调用后立刻释放。
      void Promise.resolve(ref.current()).finally(() => { running.current = false; });
    };
    tick();
    const id = setInterval(tick, ms);
    return () => clearInterval(id);
  }, [ms, enabled]);
}

/** 每 `ms` 毫秒返回一次当前时间戳。用于「本地计时」(ETA / 已运行 X 分钟 / 冷却倒数)。 */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

// ---------------------------------------------------------------------------
// SSE 状态流(/api/hub/stream):模块级单例,全页只建一条 EventSource。
//
// 为什么要单例:队列页 / Hub 页 / 房间详情可能同时挂载,各自建连接会让服务端连接数
// 与浏览器并发连接上限都无谓放大;而且 EventSource 在后台标签页里会被节流,
// 多条连接只会互相拖累。
// ---------------------------------------------------------------------------

export interface HubStreamState {
  /** SSE 连接是否已建立(收到 open)。false = 前端只能靠兜底轮询。 */
  live: boolean;
  /** 最近一次收到 `changed` 的本地时刻(0 = 从未收到过)。 */
  lastPushAt: number;
}

/** (state, changed) —— changed=true 表示服务端台账指纹变了,订阅方应立即重拉。 */
type StreamListener = (s: HubStreamState, changed: boolean) => void;

const streamListeners = new Set<StreamListener>();
let streamSource: EventSource | null = null;
let streamReconnectTimer: ReturnType<typeof setTimeout> | null = null;
let streamAttempt = 0;
let streamState: HubStreamState = { live: false, lastPushAt: 0 };

function setStreamState(patch: Partial<HubStreamState>, changed = false): void {
  streamState = { ...streamState, ...patch };
  // 复制一份再遍历:回调里可能 subscribe/unsubscribe(组件卸载)。
  for (const l of [...streamListeners]) l(streamState, changed);
}

function closeSource(): void {
  const es = streamSource;
  if (!es) return;
  streamSource = null;
  es.onopen = null;
  es.onerror = null;
  try {
    es.close();
  } catch {
    /* 已经关了 */
  }
}

function openSource(): void {
  if (streamSource || streamListeners.size === 0) return;
  if (typeof EventSource === "undefined") return; // 环境不支持 → 永远走兜底轮询
  let es: EventSource;
  try {
    es = new EventSource("/api/hub/stream");
  } catch {
    // 构造就失败(极少见):保持 streamSource=null,兜底轮询接管,退避重试。
    streamSource = null;
    scheduleReconnect();
    return;
  }
  streamSource = es;
  // 每次重连都是新的 EventSource,用闭包内的 es 做身份校验,避免旧连接的迟到事件污染状态。
  es.onopen = (): void => {
    if (streamSource !== es) return;
    streamAttempt = 0; // 连上即重置退避
    setStreamState({ live: true, lastPushAt: Date.now() });
  };
  es.addEventListener("changed", (): void => {
    if (streamSource !== es) return;
    setStreamState({ live: true, lastPushAt: Date.now() }, true);
  });
  // EventSource 出错时浏览器会**自己**无限重连(没有上限)——这里主动 close(),
  // 改由下面的指数退避统一管理,避免「1s 疯狂重连」把服务端打满。
  es.onerror = (): void => {
    if (streamSource !== es) return;
    closeSource();
    setStreamState({ live: false });
    scheduleReconnect();
  };
}

function scheduleReconnect(): void {
  if (streamReconnectTimer || streamListeners.size === 0) return;
  streamAttempt += 1;
  const base = Math.min(30_000, 3_000 * 2 ** Math.min(streamAttempt - 1, 4)); // 3s → 6 → 12 → 24 → 30s
  const delay = base + Math.random() * 500; // 抖动:多 tab 不要同一毫秒一起重连
  streamReconnectTimer = setTimeout(() => {
    streamReconnectTimer = null;
    openSource();
  }, delay);
}

export interface HubStreamOpts {
  /** false = 完全不订阅(非 master / 页面不用)。 */
  enabled?: boolean;
  /** 推送不可用时的兜底轮询起始间隔。 */
  fallbackMs?: number;
  /** 兜底轮询退避上限。 */
  maxFallbackMs?: number;
  /** 推送在线时的低频对账间隔(兜住「TCP 半开、onerror 不触发」的静默失联)。 */
  keepAliveMs?: number;
}

export interface HubStreamHandle {
  /** 推送是否在线。false 表示正在用兜底轮询。 */
  live: boolean;
  /** 数据可能已过期:推送断开、或最近一次重拉失败。 */
  stale: boolean;
  /** 最近一次**成功**重拉的本地时刻(未成功过 = null)。 */
  lastOkAt: number | null;
  /** 手动重拉(「刷新」按钮用)。 */
  refresh: () => void;
}

/**
 * 订阅 `/api/hub/stream`,收到 `changed` 立即重拉 `refetch`。
 *
 * 关键保证(评审点名的那几条):
 * 1. **重入守卫 + 补拉**:重拉进行中又来 `changed`,不并发发请求,但会在结束后**再补一次**,
 *    所以「最后一次变更」不会被丢(这是推送驱动最容易写错的地方)。
 * 2. **推送挂了必须回落**:连不上 / 非 master(503)/ 浏览器不支持 → 指数退避(3s→30s)的兜底轮询,
 *    绝不出现「推送挂了页面就再也不更新」。
 * 3. **document.hidden 时不发兜底请求**,回到前台立即补拉一次。
 * 4. `refetch` **失败必须 reject** —— hook 据此置 `stale`;在页面里静默 catch 会让过期提示永远不亮。
 */
export function useHubStream(refetch: () => void | Promise<void>, opts: HubStreamOpts = {}): HubStreamHandle {
  const { enabled = true, fallbackMs = 3000, maxFallbackMs = 30_000, keepAliveMs = 60_000 } = opts;
  const [state, setState] = useState<HubStreamState>(streamState);
  const [fetchFailed, setFetchFailed] = useState(false);
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);

  const fnRef = useRef(refetch);
  fnRef.current = refetch;
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const inFlight = useRef(false);
  const pending = useRef(false);
  // run 的自引用(补拉时递归调用自身):用 ref 持有最新实现,避免 useCallback 依赖自己。
  const runRef = useRef<() => void>(() => {});

  const run = useCallback((): void => {
    if (!enabledRef.current) return;
    if (inFlight.current) {
      pending.current = true; // 记下「期间又变了」,结束后补一次
      return;
    }
    inFlight.current = true;
    void (async () => {
      try {
        await fnRef.current();
        setLastOkAt(Date.now());
        setFetchFailed(false);
      } catch (e) {
        // 不静默:页面据此显示「数据可能已过期」。
        console.warn("[hub-stream] 刷新失败", e);
        setFetchFailed(true);
      } finally {
        inFlight.current = false;
        if (pending.current) {
          pending.current = false;
          runRef.current();
        }
      }
    })();
  }, []);
  runRef.current = run;

  useEffect(() => {
    if (!enabled) return;
    const listener: StreamListener = (s, changed): void => {
      setState(s);
      if (changed) runRef.current();
    };
    streamListeners.add(listener);
    listener(streamState, false); // 挂载时若已连上,立刻拿到当前状态
    openSource();
    runRef.current(); // 首拉
    return () => {
      streamListeners.delete(listener);
      if (streamListeners.size === 0) {
        // 最后一个订阅者走了 → 彻底断开,不留后台重连(否则页面切走后仍在重连打服务端)。
        closeSource();
        if (streamReconnectTimer) {
          clearTimeout(streamReconnectTimer);
          streamReconnectTimer = null;
        }
        streamAttempt = 0;
        streamState = { live: false, lastPushAt: 0 };
      }
    };
  }, [enabled]);

  // 兜底轮询(仅推送离线时):3s 起步、×1.5 退避、封顶 30s;页面隐藏时静默(到点只续期不请求)。
  useEffect(() => {
    if (!enabled || state.live) return;
    let delay = fallbackMs;
    const tick = (): void => {
      if (!document.hidden) {
        runRef.current();
        delay = Math.min(maxFallbackMs, Math.round(delay * 1.5));
      }
      timer = setTimeout(tick, delay);
    };
    let timer = setTimeout(tick, delay);
    const onVisible = (): void => {
      if (document.hidden) return;
      delay = fallbackMs; // 回到前台立刻补拉,并把退避重置
      runRef.current();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, state.live, fallbackMs, maxFallbackMs]);

  // 推送在线时的低频对账:TCP 半开时 onerror 可能永远不触发,靠它把视图拉回正。
  useEffect(() => {
    if (!enabled || !state.live || keepAliveMs <= 0) return;
    const id = setInterval(() => {
      if (!document.hidden) runRef.current();
    }, keepAliveMs);
    return () => clearInterval(id);
  }, [enabled, state.live, keepAliveMs]);

  return { live: state.live, stale: enabled ? (!state.live || fetchFailed) : false, lastOkAt, refresh: run };
}

/** Best-effort human message from an unknown thrown value. */
export function errMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}
