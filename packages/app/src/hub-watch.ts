/**
 * hub-watch.ts(T4) —— hub 台账**变更监视**:给 web 前端一条常驻 SSE 通道
 * (`GET /api/hub/stream`),让「hub 任务 / 处理队列」页不再靠轮询也能实时刷新。
 *
 * **为什么轮询不实时**:队列页 `GET /api/hub/queue` 的刷新间隔默认 60s,
 * 台账写入(同步/合并/上传/烧录节点状态)与读取之间没有任何通知通道 → UI 最多滞后近 1 分钟。
 *
 * **指纹为什么不用 COUNT(*)**:sync_job_steps / sync_job_events 会随一场直播线性增长
 * (每节点 start/done 各一行,一天几百场 = 十万级),COUNT(*) 每次 tick 都全表扫;
 * 而「有没有变」只需要看**最新写入位置**。故取:
 *   - sync_jobs: MAX(updatedAt) + MAX(rowid)   —— 状态/字段更新都动 updatedAt
 *   - sync_job_steps: MAX(rowid)             —— 追加型表,插入必然抬高 rowid
 *   - sync_node_states: MAX(updatedAt)       —— 节点状态原地更新,不动 rowid
 * 三者组合覆盖「插入 / 原地更新 / 状态推进」三种变更形态,每条都是走索引的 O(1)-ish 聚合。
 *
 * **全部 try/catch**:台账 db 可能不存在(slave/未开过 hub)、正处于写事务被锁、
 * 旧库还没有新表。任一失败都不能让监视器死掉,故统一回落成「稳定但信息缺失」的指纹。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, statSync } from "node:fs";

/** 台账库指纹。字段为 `null` = 该来源本次取不到(表缺失/库被锁),占位值保证不产生虚假变更。 */
export interface HubFingerprint {
  /** db 文件 mtimeMs(ms);文件不存在 → -1。 */
  mtimeMs: number;
  jobsMaxUpdatedAt: number | null;
  jobsMaxRowid: number | null;
  stepsMaxRowid: number | null;
  nodeStatesMaxUpdatedAt: number | null;
}

/** 只读连接打开 sqlite 时的等待预算(ms)。不设则并发写期间直接 SQLITE_BUSY。 */
const BUSY_TIMEOUT_MS = 3000;

/**
 * 计算台账库指纹。**永不抛**:任何异常都返回可比较的结果。
 * db 路径不存在 → 纯 mtime 指纹(稳定,不会每次 tick 都变化)。
 */
export function computeVersionFingerprint(dbPath: string): HubFingerprint {
  const fp: HubFingerprint = {
    mtimeMs: -1,
    jobsMaxUpdatedAt: null,
    jobsMaxRowid: null,
    stepsMaxRowid: null,
    nodeStatesMaxUpdatedAt: null,
  };
  try {
    if (existsSync(dbPath)) fp.mtimeMs = statSync(dbPath).mtimeMs;
  } catch { /* 文件被删/无权限 → -1 */ }
  if (fp.mtimeMs < 0) return fp;
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // **必须设**:与 orchestrator SyncLedger 写端并发时,不设就是立刻 SQLITE_BUSY,
    // 表现成「队列页莫名其妙空了 / 收不到更新」—— 典型的静默失败。
    db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    // 注意 **`Number(null)` 是 0,不是 null**:直接 Number() 会把「表空/取不到」压成 0,
    // 于是 null(不可观测)与 0(真实最大值就是 0)不可区分 —— 契约就废了。必须先判空。
    const one = (sql: string): number | null => {
      const row = db!.prepare(sql).get() as unknown as Record<string, unknown> | undefined;
      const v = row?.n;
      return v == null ? null : Number(v);
    };
    fp.jobsMaxUpdatedAt = one("SELECT MAX(updatedAt) AS n FROM sync_jobs");
    fp.jobsMaxRowid = one("SELECT MAX(rowid) AS n FROM sync_jobs");
    fp.stepsMaxRowid = one("SELECT MAX(rowid) AS n FROM sync_job_steps");
    fp.nodeStatesMaxUpdatedAt = one("SELECT MAX(updatedAt) AS n FROM sync_node_states");
  } catch {
    // 表不存在(旧库)/被锁 → 保留 null 占位。下一次 tick 取到值时指纹会「从 null 变有值」
    // 而被判为变更 —— 这是正确的:从不可观测变为可观测,前端该刷一次。
  } finally {
    try { db?.close(); } catch { /* 已关/无关紧要 */ }
  }
  return fp;
}

/** 指纹比较:逐字段。两侧同为 null 时相等 → 「取不到」不会造成虚假推送。 */
export function fingerprintEquals(a: HubFingerprint, b: HubFingerprint): boolean {
  return a.mtimeMs === b.mtimeMs
    && a.jobsMaxUpdatedAt === b.jobsMaxUpdatedAt
    && a.jobsMaxRowid === b.jobsMaxRowid
    && a.stepsMaxRowid === b.stepsMaxRowid
    && a.nodeStatesMaxUpdatedAt === b.nodeStatesMaxUpdatedAt;
}

export interface HubWatchOptions {
  /** 轮询间隔(ms;默认 1000)。 */
  intervalMs?: number;
  /** 变更去抖窗口(ms;默认 250):一次 pipeline 推进会连写好几张表,合并成一次推送。 */
  debounceMs?: number;
  /** 日志(默认静默;只在**变更**时打一行,避免每 tick 刷屏)。 */
  log?: (m: string) => void;
  /** 手工注入时钟(测试用;省略用 Date.now)。 */
  now?: () => number;
}

/**
 * hub 台账变更监视器:定时比对指纹,变更去抖后通知订阅者。
 *
 * **去抖的必要性**:一次 upload 推进会同时写 sync_jobs(state) + sync_job_events +
 * sync_job_steps + sync_node_states,一个 tick 窗口内可能被读到中间态 → 前端按中间态刷一次、
 * 再刷一次。250ms 窗口把一轮写入折叠成一次推送。
 */
export class HubWatch {
  private readonly dbPath: string;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly log: (m: string) => void;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private last: HubFingerprint;
  private readonly subs = new Set<() => void>();
  /** 待推送变更的时刻;null = 无待推送(去抖窗口到期后发一次)。 */
  private pendingSince: number | null = null;

  constructor(dbPath: string, opts: HubWatchOptions = {}) {
    this.dbPath = dbPath;
    this.intervalMs = opts.intervalMs ?? 1000;
    this.debounceMs = opts.debounceMs ?? 250;
    this.log = opts.log ?? ((): void => {});
    this.now = opts.now ?? Date.now;
    this.last = computeVersionFingerprint(dbPath);
  }

  /** 当前订阅者数量(测试/诊断用,也是「无泄漏」的断言口径)。 */
  get subscriberCount(): number {
    return this.subs.size;
  }

  /**
   * **外部主动触发一次变更通知**(T17)。
   *
   * 为什么需要:SSE 的指纹只覆盖 **sync 台账**(hub 后处理)。但用户看的「房间页」还关心
   * **录制状态** —— 开播/收播那一刻,台账可能毫无变化(后处理还没开始),指纹不变 → 不推 →
   * 页面在最该刷新的几秒里是陈旧的。录制状态在 tasks 表 / TaskManager 内存里,不在台账里,
   * 所以指纹看不见,只能由**状态变更方主动喊一声**。
   *
   * 语义与轮询路径完全一致:走去抖,不绕过 debounce(否则一次开播会连推十几帧)。
   * 未 start 时调用是安全的空操作(没有订阅者可通知)。
   */
  notifyChanged(): void {
    if (this.subs.size === 0) return;        // 没人听 → 不排(否则定时器白转)
    if (this.pendingSince !== null) return;  // 已在去抖窗口里 → 不重复排
    this.pendingSince = this.now();
    if (this.debounceMs <= 0) {
      this.pendingSince = null;
      this.flush();
      return;
    }
    setTimeout(() => {
      if (this.pendingSince == null) return;
      this.pendingSince = null;
      this.flush();
    }, this.debounceMs).unref?.();
  }

  /** 订阅变更。返回退订函数;重复调用退订是安全的。 */
  subscribe(fn: () => void): () => void {
    this.subs.add(fn);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.subs.delete(fn);
    };
  }

  /** 立即比对一次指纹。变更则进入去抖窗口,到期通知订阅者。 */
  check(): void {
    const fp = computeVersionFingerprint(this.dbPath);
    if (fingerprintEquals(fp, this.last)) {
      // 无变更 → 撤回待推送(上一次抖动不该在静默期之后又冒出来)。
      this.pendingSince = null;
      return;
    }
    this.last = fp;
    if (this.pendingSince != null) return; // 窗口内再变更 → 仍只推一次
    this.pendingSince = this.now();
    if (this.debounceMs <= 0) {
      this.pendingSince = null;
      this.flush();
      return;
    }
    setTimeout(() => {
      if (this.pendingSince == null) return; // 已被后续「无变更」撤回,或已发过
      this.pendingSince = null;
      this.flush();
    }, this.debounceMs).unref?.();
  }

  private flush(): void {
    if (this.subs.size === 0) return; // 没人听就不推
    this.log("[hub_watch] 台账变更,通知订阅者");
    // 复制一份再遍历:回调里退订(前端断开即退订)不能边遍历边改 Set。
    for (const fn of [...this.subs]) {
      try {
        fn();
      } catch (e) {
        // **绝不静默**:一个订阅者抛错不能带倒其他订阅者,也不能让监视器停摆。
        this.log(`[hub_watch] 订阅者回调抛错(跳过该订阅者本次): ${String(e)}`);
      }
    }
  }

  start(): void {
    if (this.timer) return; // 幂等:重复 start 不叠加定时器
    this.timer = setInterval(() => {
      try {
        this.check();
      } catch (e) {
        this.log(`[hub_watch] 检查异常(忽略本轮): ${String(e)}`);
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.subs.clear();
    this.pendingSince = null;
  }
}

/**
 * SSE 帧:`event: <name>\ndata: <json>\n\n`。data 必须是单行(SSE 规范多行要逐行加 `data:`),
 * JSON.stringify 天然满足(裸换行被转义)。
 */
export function sseFrame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** SSE 心跳注释帧(`:` 开头,EventSource 会忽略):防空闲连接被中间代理掐掉。 */
export function sseComment(text = "hb"): string {
  return `: ${text}\n\n`;
}
