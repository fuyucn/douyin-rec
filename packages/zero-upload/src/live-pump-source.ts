import { sleepUnlessAborted } from "./live-pump-wait.js";
import { IDLE_POLL_MS, DEFAULT_RECOVERY_WINDOW_MS } from "./live-pump-policy.js";
import type { RunLivePumpOptions } from "./live-pump-run-options.js";
export interface StreamAcquirer {
  living: boolean;
  url?: string;
  headers?: Record<string, string>;
  title?: string;
  owner?: string;
  /** Issue #496: live but no playable URL (CDN not ready / risk control). */
  unplayableReason?: string;
  /** Internal: the probe itself failed (timeout/exception), not a confirmed-offline answer. */
  probeFailed?: boolean;
}
export interface AcquireStreamOpts {
  room: string;
  fetch: (room: string, quality: string) => Promise<StreamAcquirer>;
  quality: string;
  maxRetries?: number;
  baseMs?: number;
  onRetry?: (waitMs: number, attempt: number, max: number) => void;
  onGiveUp?: (totalAttempts: number) => void;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}
export async function acquireStreamWithBackoff(o: AcquireStreamOpts): Promise<StreamAcquirer> {
  const max = o.maxRetries ?? 5;
  const base = o.baseMs ?? 5000;
  const sleep = o.sleep ?? (ms => new Promise(r => setTimeout(r, ms)));
  const timeoutMs = o.timeoutMs ?? 30000;
  let fails = 0;
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<StreamAcquirer>(resolve => {
      timer = setTimeout(() => resolve({ living: false, probeFailed: true }), timeoutMs);
    });
    let s: StreamAcquirer;
    try {
      s = await Promise.race([o.fetch(o.room, o.quality), timeout]);
    }
    catch {
      s = { living: false, probeFailed: true };
    }
    finally {
      if (timer)
        clearTimeout(timer);
    }
    if (s.living && s.url)
      return s;
    if (fails >= max) {
      o.onGiveUp?.(fails + 1);
      return s;
    }
    const wait = base * 2 ** fails;
    fails++;
    o.onRetry?.(wait, fails, max);
    await sleep(wait);
  }
}
export class LivePumpSource {
  private readonly idlePollMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Issue #496: one alert per broadcast while live but no playable URL. */
  private unplayableAlerted = false;
  constructor(private readonly o: RunLivePumpOptions, private readonly log: (message: string) => void) {
    this.idlePollMs = o.idlePollMs ?? IDLE_POLL_MS;
    this.sleep = o.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  }
  async stopRequested(): Promise<boolean> {
    return !!this.o.signal?.aborted || !!this.o.drainSignal?.aborted || !!(await this.o.shouldStop?.());
  }
  async waitForBroadcast(deadlineMs?: number): Promise<StreamAcquirer | null> {
    for (let misses = 0;; misses++) {
      if (await this.stopRequested())
        return null;
      if (deadlineMs !== undefined && Date.now() >= deadlineMs) {
        this.log(`[直播直传] 停滞恢复窗口已耗尽(${Math.round((this.o.recoverWindowMs ?? DEFAULT_RECOVERY_WINDOW_MS) / 60000)} 分钟),结束本次录制`);
        return null;
      }
      const s = await acquireStreamWithBackoff({
        room: this.o.room,
        fetch: this.o.fetch,
        quality: this.o.quality,
        maxRetries: 0,
        sleep: this.sleep,
      });
      if (s.living && s.url) {
        this.unplayableAlerted = false;
        return s;
      }
      // Only the no-URL path suppresses on stop: a usable URL must still open the broadcast (#308).
      if (await this.stopRequested())
        return null;
      if (s.living) {
        // Issue #496: do not let a live-but-no-URL probe look like offline. Alert once per broadcast
        // and keep the normal poll cadence; a usable URL or a confirmed-offline probe re-arms it.
        if (!this.unplayableAlerted) {
          this.unplayableAlerted = true;
          const why = s.unplayableReason?.trim();
          const msg = `直播直传:平台显示直播中但取不到可播放地址${why ? `(${why})` : ""} —— 保持轮询,长时间不恢复即整场漏录,请检查。room=${this.o.room}`;
          this.log(`[直播直传] ⚠️ ${msg}`);
          try { this.o.onAlert?.(msg); } catch { /* alert sink is best-effort */ }
        }
      } else if (!s.probeFailed) {
        // Confirmed offline re-arms; a timed-out/exception probe must not look like a broadcast end.
        this.unplayableAlerted = false;
      }
      if (misses % Math.max(1, Math.round(600000 / this.idlePollMs)) === 0) {
        this.log(`[直播直传] 未开播,每 ${this.idlePollMs / 1000}s 探测一次(留在进程内等待)`);
      }
      const waitMs = deadlineMs === undefined ? this.idlePollMs : Math.max(0, Math.min(this.idlePollMs, deadlineMs - Date.now()));
      if (waitMs <= 0)
        continue;
      await sleepUnlessAborted(waitMs, [this.o.signal, this.o.drainSignal], this.o.sleep);
    }
  }
  acquire(partSeq: number): Promise<StreamAcquirer> {
    return acquireStreamWithBackoff({
      room: this.o.room,
      fetch: this.o.fetch,
      quality: this.o.quality,
      onRetry: (waitMs, attempt, max) => this.log(`[直播直传] 段${partSeq + 1} 取流失败,${waitMs / 1000}s 后重试(${attempt}/${max})`),
      onGiveUp: attempts => this.log(`[直播直传] 连续 ${attempts} 次取不到流,按收播收尾(已录分 P 不受影响)`),
      sleep: this.sleep,
    });
  }
}
