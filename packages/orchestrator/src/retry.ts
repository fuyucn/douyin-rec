export interface RetryOpts {
  /** 最大调用次数(含首次)。默认 3。<=1 则只调一次不重试。 */
  tries?: number;
  /** 首次退避 ms(第 n 次失败后等 backoffMs * 2^(n-1))。默认 5000。 */
  backoffMs?: number;
  /** 可注入 sleep(测试用)。默认 setTimeout 包装。 */
  sleep?: (ms: number) => Promise<void>;
  /** 每次失败(还会重试时)回调,attempt 从 1 计。 */
  onRetry?: (attempt: number, err: unknown) => void;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 有限次重试 + 指数退避。fn 成功即返回;全部失败抛**最后一次**错误。
 * 纯逻辑,不知道 fn 是什么——调用方负责保证 fn 幂等安全(见 pipeline:只包安全的单文件 append)。
 */
export async function retry<T>(fn: () => Promise<T>, opts: RetryOpts = {}): Promise<T> {
  const tries = opts.tries ?? 3;
  const backoffMs = opts.backoffMs ?? 5000;
  const sleep = opts.sleep ?? defaultSleep;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= Math.max(1, tries); attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= tries) break; // 用尽,跳出后抛
      opts.onRetry?.(attempt, err);
      await sleep(backoffMs * 2 ** (attempt - 1));
    }
  }
  throw lastErr;
}
