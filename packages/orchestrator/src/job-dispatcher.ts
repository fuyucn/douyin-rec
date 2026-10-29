/**
 * T7:有界并发派发器。
 *
 * 解决 reconcileAll 的 N+1 阻塞:旧实现在 `for (const b of broadcasts)` 里
 * `await this._runPipeline(b, …)`,于是**后一个房间的 job 行要等前一个房间
 * merge/burn/upload 全部跑完才创建** —— 队列/UI 看起来「卡住」,而且后一场的
 * pull(网络 IO)也没机会与前一场的 CPU 编码重叠。
 *
 * 两阶段:①reconciler 同步把所有 job 行建好(纯台账写入,快);②把每场的执行
 * enqueue 给本调度器,最多 `maxConcurrent` 场同时跑,其余排队。
 *
 * 语义约定(刻意收窄,避免"看起来防重其实漏重试"):
 * - **只对活动 key 去重**:enqueue 时 key 已在跑 → 直接跳过(返回 false);
 *   任务 settle(成功/失败都算)即从活动集合删除。**不保留「刚完成」集合** ——
 *   否则会压掉合法重试(reconciler 靠 upsertPending 对 RETRYABLE 状态重入,
 *   下一轮会拿到一个 retrying 的新 job,必须能再派发)。重入判断属于台账语义。
 * - 不吞异常:交给调用方的 run 自行决定失败语义;这里只保证**一个任务抛错
 *   不影响其余任务**(drain 仍会等完)。
 * - **不解决 CPU 争用**:merge/burn 的串行由 `ResourcePool` 的 maxCpuParallel
 *   决定(默认 1)。本调度器给的是「跨房间的调度并发」,CPU 闸门仍在其内生效。
 */

export interface JobDispatcherOptions {
  /** 同时执行的任务上限。<1 视为 1(不提供并发度 = 串行,与旧行为一致)。 */
  maxConcurrent?: number;
  /**
   * **热读取值器**(T15):传函数则每次派发取当前值,UI 改完立即生效、无需重启。
   * 不传则退回 maxConcurrent(行为不变)。
   */
  maxConcurrentLive?: () => number;
  /** 便于测试/日志注入;默认 console。 */
  log?: (msg: string) => void;
}

export interface JobDispatcherStats {
  /** 本调度器生命周期内 enqueue 被活动 key 去重掉的次数。 */
  deduped: number;
}

export class JobDispatcher {
  /** 热读取值器;无则退化为常量闭包。 */
  private readonly resolveMaxConcurrent: () => number;
  /** 上一次解析出的上限(snapshot / 日志用;非法值夹到 1)。 */
  maxConcurrent: number;
  private readonly log: (msg: string) => void;
  /** 正在执行的 key(活动去重集合;settle 即删)。 */
  private readonly active = new Set<string>();
  /** 排队等待的任务。 */
  private readonly queue: TaskItem[] = [];
  /** 在飞 promise 数(含排队者启动后)。 */
  private inFlight = 0;
  private dedupedCount = 0;
  /** drain 的等待者:在飞归零时被唤醒。 */
  private idleWaiters: (() => void)[] = [];

  constructor(opts: JobDispatcherOptions = {}) {
    const clamp = (v: number): number => (Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1);
    this.resolveMaxConcurrent = opts.maxConcurrentLive ?? ((): number => clamp(opts.maxConcurrent ?? 1));
    this.maxConcurrent = clamp(opts.maxConcurrent ?? 1);
    this.log = opts.log ?? ((m) => console.info(m));
  }

  /**
   * 入队一场。key 已在执行中 → 跳过并返回 false(同一场永不并发、不重复建稿)。
   * 队列已满不阻塞调用方(有界并发 = 排队等待,不是无限并发)。
   * @returns 是否真的排上了(排队或立即执行都算)。
   */
  enqueue(key: string, run: () => Promise<void>): boolean {
    return this.slot(key, run) != null;
  }

  /**
   * 同 enqueue,但返回**这一项 settle 的 promise**(被活动去重挡掉时立即 resolve)。
   * 调用方(如 reconciler)用它精确地只等**本轮自己派发出去**的任务 ——
   * 比全局 `drain()` 强:别人的在飞任务不该把自己的 reconcileAll 卡住。
   */
  dispatch(key: string, run: () => Promise<void>): Promise<void> {
    return this.slot(key, run) ?? Promise.resolve();
  }

  private slot(key: string, run: () => Promise<void>): Promise<void> | null {
    if (this.active.has(key)) {
      this.dedupedCount++;
      this.log(`[dispatcher] ${key} 正在执行中,跳过重复派发(活动去重)`);
      return null;
    }
    this.active.add(key);
    const item: TaskItem = { key, run };
    item.settled = new Promise<void>((resolve) => { item.finish = resolve; });
    this.queue.push(item);
    this.pump();
    return item.settled;
  }

  /** 当前排队 + 执行中的任务数(日志/测试用)。 */
  get pending(): number {
    return this.queue.length + this.inFlight;
  }

  /** 当前排队等待的任务数(并发已满、在等槽位)。 */
  get waiting(): number {
    return this.queue.length;
  }

  get stats(): JobDispatcherStats {
    return { deduped: this.dedupedCount };
  }

  /** 等全部(排队 + 执行中)结束。返回后 active 集合为空。 */
  async drain(): Promise<void> {
    while (this.pending > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }

  private pump(): void {
    // 每轮派发前重取一次上限:UI 改了并行度后,下一场就用新值(无需重启 master)。
    this.maxConcurrent = this.resolveMaxConcurrent();
    while (this.inFlight < this.maxConcurrent && this.queue.length > 0) {
      const item = this.queue.shift()!;
      this.inFlight++;
      // 并发/排队可观测:队列/在飞非零时打一行,便于线上判断「几场在跑、几场在等」。
      if (this.queue.length > 0 || this.inFlight > 1) {
        this.log(`[dispatcher] 派发 ${item.key}:在飞 ${this.inFlight}/${this.maxConcurrent},排队 ${this.queue.length}`);
      }
      void this.runOne(item);
    }
    this.maybeIdle();
  }

  private async runOne(item: TaskItem): Promise<void> {
    try {
      await item.run();
    } catch (err) {
      // 兜底:调用方的 run 正常会自己 markFailed;真漏到这里也不许吞成静默成功,
      // 更不能炸掉整个 drain(其余任务必须继续跑完)。
      console.error(`[dispatcher] ${item.key} 未捕获异常:`, err);
    } finally {
      this.active.delete(item.key);   // settle(含失败)即出活动集合 → 下一轮可合法重试
      this.inFlight--;
      this.pump();
      item.finish?.();
    }
  }

  private maybeIdle(): void {
    if (this.pending > 0) return;
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const w of waiters) w();
  }
}

interface TaskItem {
  key: string;
  run: () => Promise<void>;
  /** settle promise,由 slot() 注入 finish 回调后创建。 */
  settled?: Promise<void>;
  finish?: () => void;
}
