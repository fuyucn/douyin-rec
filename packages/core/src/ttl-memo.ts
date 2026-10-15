/**
 * 异步函数的 TTL 缓存 + 并发合并:ttl 内复用上次成功结果;已有请求在途则共用同一个 promise。
 * 失败不缓存(下次调用重试)。用于「多个浏览器标签页各自轮询、每次要 N 条 ssh」的探测接口,
 * 让探测成本与标签页数量无关。
 */
export function ttlMemoAsync<T>(fn: () => Promise<T>, ttlMs: number, now: () => number = Date.now): () => Promise<T> {
  let cache: { at: number; value: T } | null = null;
  let inflight: Promise<T> | null = null;
  return () => {
    if (cache && now() - cache.at < ttlMs) return Promise.resolve(cache.value);
    if (inflight) return inflight;
    inflight = fn()
      .then((value) => { cache = { at: now(), value }; return value; })
      .finally(() => { inflight = null; });
    return inflight;
  };
}
