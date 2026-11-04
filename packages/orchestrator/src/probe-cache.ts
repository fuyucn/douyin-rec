/**
 * probe-cache.ts — memoize per-file ffprobe results by file version (plans/042 Task 4).
 *
 * `inventory` probes every recording segment on every call. Inside the resident serve (fleet agent) the
 * same finished segments are probed again each reconcile round; caching by `path|size|mtimeMs` makes a
 * repeat inventory cost one stat per file. A segment still being written changes size/mtime and is
 * re-probed. The stat is handed to the probe so callers need not stat again. Concurrent calls for the same
 * version share one probe; failures are never cached.
 */
import { statSync, type Stats } from "node:fs";

export function createProbeCache<T>(
  probe: (file: string, st: Stats | null) => Promise<T>,
  max = 2000,
): (file: string) => Promise<T> {
  const cache = new Map<string, Promise<T>>();
  return (file) => {
    let st: Stats;
    try {
      st = statSync(file);
    } catch {
      return probe(file, null); // vanished / unreadable: let the probe report it
    }
    const key = `${file}|${st.size}|${st.mtimeMs}`;
    const hit = cache.get(key);
    if (hit) {
      cache.delete(key); // refresh LRU position
      cache.set(key, hit);
      return hit;
    }
    const value = probe(file, st);
    cache.set(key, value);
    value.catch(() => {
      if (cache.get(key) === value) cache.delete(key);
    });
    if (cache.size > max) cache.delete(cache.keys().next().value as string);
    return value;
  };
}
