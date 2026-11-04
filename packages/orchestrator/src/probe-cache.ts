/**
 * probe-cache.ts — memoize per-file ffprobe results by file version (plans/042 Task 4).
 *
 * `inventory` probes every recording segment on every call. Inside the resident serve (fleet agent) the
 * same finished segments are probed again each reconcile round; caching by `path|size|mtimeMs` makes a
 * repeat inventory cost a stat per file. A segment still being written changes size/mtime and is
 * re-probed. Failures are never cached.
 */
import { statSync } from "node:fs";

export function createProbeCache<T>(probe: (file: string) => Promise<T>, max = 2000): (file: string) => Promise<T> {
  const cache = new Map<string, T>();
  return async (file) => {
    let key: string;
    try {
      const st = statSync(file);
      key = `${file}|${st.size}|${st.mtimeMs}`;
    } catch {
      return probe(file); // vanished / unreadable: let the probe report it
    }
    const hit = cache.get(key);
    if (hit !== undefined) {
      cache.delete(key); // refresh LRU position
      cache.set(key, hit);
      return hit;
    }
    const value = await probe(file);
    cache.set(key, value);
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
    return value;
  };
}
