/**
 * sync-gate.ts — hub 任务「立即同步」的**合并 + force 累积**闸门(T-2 / plans/030 T2.8)。
 *
 * 独立成文件而不是内联在 cli.ts:cli.ts 顶层会 import 全部 CLI 依赖(平台 vendor 包等),
 * 单测 import 不了 —— 而「在途合并 + 标志累积」恰恰是最容易写错的时序,必须有测试。
 * 本文件**零依赖**,只管时序语义。
 */

/** 一轮同步的入参:`force` = 显式确认缩容/清空,让节点跳过骤减安全阀。 */
export interface SyncRunOpts {
  force?: boolean;
}
/** 一轮同步的执行体(cli 注入的 syncTasks)。 */
export type SyncRunner = (opts?: SyncRunOpts) => Promise<void>;

export class SyncGate {
  /** 有一轮正在跑。 */
  running = false;
  /** 已请求至少一次补跑(在途期间)。 */
  rerunRequested = false;
  /** 有补跑待执行(执行体尚未就绪)。 */
  pending = false;
  /** 累积的 force:任一请求置位后,必须在**下一次真正执行的轮次**生效。 */
  forcePending = false;
  private runner: SyncRunner | undefined;

  /**
   * 请求同步。
   *
   * `true` = 调用方应立即执行一轮(force 由 `beginRun()` 消费);
   * `false` = 已合并(在途 → 记补跑;执行体未就绪 → 等 `bind()` 补跑)。
   *
   * **force 为什么必须累积**:同步是防重入的 —— 周期 tick 正在 in-flight 时,web 的
   * 「强制应用」会被合并进「下一轮补跑」。若 force 不被记住,这次强制请求就静默消失:
   * 节点继续按守卫拒绝删除,master 日志只有节点侧那行 `rejected`,用户看到的是「点了没反应」。
   */
  request(force?: boolean): boolean {
    this.forcePending ||= force === true;
    if (this.running) {
      this.rerunRequested = true;
      return false;
    }
    if (!this.runner) {
      this.pending = true;
      return false;
    }
    return true;
  }

  /** 绑定执行体;若此前有挂起请求(含 force)立即补跑一轮。 */
  bind(runner: SyncRunner): void {
    this.runner = runner;
    if (this.pending) {
      this.pending = false;
      void runner({ force: this.forcePending });
    }
  }

  /**
   * 一轮**开始**时消费 force 标志(取走即清:否则之后的普通周期轮次会被误升格为 force,
   * 安全阀形同虚设)。返回本轮实际生效的 force。
   */
  beginRun(force?: boolean): boolean {
    const eff = this.forcePending || force === true;
    this.forcePending = false;
    return eff;
  }

  /**
   * 解绑执行体并清空全部状态(hub 停止时调用)。
   *
   * 必须显式做:cli 在 stop 里把 `hubSyncTasks` 置 undefined,但本类**持有 runner 引用** ——
   * 不解绑的话,stop 之后再来一次「立即同步」请求会打到已经停掉的旧 runner 上
   * (旧的 `if (hubSyncTasks)` 判断天然挡住了这种情况,换成类之后必须自己守住;自审发现)。
   */
  unbind(): void {
    this.runner = undefined;
    this.running = false;
    this.rerunRequested = false;
    this.pending = false;
    this.forcePending = false;
  }

  /** 本轮**结束**:返回是否需要补跑(调用方在 `finally` 里调)。 */
  endRun(): boolean {
    this.running = false;
    if (!this.rerunRequested) return false;
    this.rerunRequested = false;
    return true;
  }
}
