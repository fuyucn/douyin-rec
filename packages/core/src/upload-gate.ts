/**
 * upload-gate.ts — 上传配额闸门(冷却 + 滑动窗口)的**唯一判定实现**(core/rank 0)。
 *
 * 为什么在 core:B站按「提交次数」限流(601/21566),master 侧 ResourcePool(orchestrator L4.5)
 * 与节点侧上传(app L4 的 node-pipeline)必须走同一套判定,但 app 不能 import orchestrator
 * (test/arch/layering.test.ts 守护)。故判定放 core,两侧各自注入**本进程自己的** store 实现。
 *
 * 语义(与 orchestrator ResourcePool 既有行为逐条对齐,勿另造第二套):
 * - **冷却独立于次数限制**:命中 601 后先静默到 cooldownMs,即使 rateLimit<=0 也照冷却。
 * - **窗口限速**:窗口内已提交次数 >= rateLimit 时,睡到最早那次滑出窗口为止。
 * - **fail-closed**:store load() 返回 null(损坏/打不开)→ 按「刚命中 601」处理,
 *   冷却 max(cooldownMs, failClosedMs),**绝不降级成无限速**。
 * - **占额即落盘**:拿到配额立刻写回,重启后窗口不归零。
 * - **按账号分键**:同一 B 站账号在 master 与节点上是**同一个限流桶**,不同账号互不影响。
 *   键算法唯一真理 = {@link biliAccountKey} / {@link biliAccountKeyFromCookiesJson},
 *   禁止在别处再拼一遍。
 *
 * 本模块**不做 IO**:store 由调用方注入(orchestrator 与 app 各自用自己的 sqlite 行)。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isUploadRateLimited } from "./upload-contract.js";

/** 闸门的两个状态字段(与 ResourcePool 内部字段、upload_limits 表列一一对应)。 */
export interface UploadLimitState {
  /** 命中 601 后的静默截止时刻(ms);0 = 未在冷却。 */
  blockedUntil: number;
  /** 滑动窗口内的提交时刻(ms),升序。 */
  times: number[];
}

/**
 * 按账号分键的状态存储。**实现由调用方注入**(core 不碰 sqlite/路径)。
 * `load` 返回 null = **存储不可用/损坏** → 调用方必须 fail-closed,不得当成空状态。
 */
export interface UploadGateStore {
  load(key: string): UploadLimitState | null;
  /** 覆盖写该键的单行;失败抛错,由调用方 warn(不静默、不阻断投稿)。 */
  save(key: string, state: UploadLimitState): void;
  /**
   * **可选**的原子占额(多进程/多实例共享同一行时避免 read-modify-write 竞态超卖):
   * 在一个写事务里读回 + 裁窗口 + 判断是否还有配额 + 占额 + 写回,返回是否成功占到。
   * 不实现该方法时,调用方退化为「读-判断-写」的乐观路径(**同进程内仍安全**,跨进程可能各占一格)。
   */
  tryClaim?(key: string, now: number, windowMs: number, rateLimit: number): boolean;
  /** 关闭底层句柄(必须实现:无操作即可)——调用方不该区分「有没有」。 */
  close(): void;
}

export interface UploadGateOpts {
  store?: UploadGateStore;
  /** 窗口内最多提交次数;<=0 = 关闭次数限制(**冷却仍然生效**)。缺省 5。 */
  rateLimit?: number;
  /** 滑动窗口 ms。缺省 600_000。 */
  windowMs?: number;
  /** 命中 601 后的冷却 ms。缺省 1_800_000。 */
  cooldownMs?: number;
  /** store 不可用时的兜底冷却下限(ms)。缺省 30min —— 防「显式关冷却」退化成无限速。 */
  failClosedMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 等待期间的中断检查(orchestrator 的 abort 语义)。 */
  throwIfBlocked?: () => void;
  /** 诊断日志(落盘失败、fail-closed 等)。**绝不静默**。 */
  warn?: (msg: string) => void;
}

/** 存储不可用 / 显式关冷却时的兜底冷却下限(与 ResourcePool.UPLOAD_FAILCLOSED_MS 同值)。 */
export const UPLOAD_FAIL_CLOSED_MS = 30 * 60_000;

/** 未分桶时 master ResourcePool 用的单一键(与账号无关:B 站按账号限流,单机单账号)。 */
export const UPLOAD_GATE_DEFAULT_KEY = "default";

/**
 * 账号键算法 —— **全仓库唯一一处**,禁止在别处再拼一遍。
 * `bilibili:<DedeUserID>`;缺 mid 时回落到 `bilibili:unknown`(保守:并到同桶,宁可多等)。
 */
export function biliAccountKey(dedeUserId?: string | number | null): string {
  const id = String(dedeUserId ?? "").trim();
  return id.length > 0 ? `bilibili:${id}` : "bilibili:unknown";
}

/**
 * 从 biliup `cookies.json` 的**文本**解析账号键(不暴露 cookie 值)。
 * 兼容 `{cookie_info:{cookies:[{name,value}]}}` 与 `{cookies:[...]}` 两种结构。
 * 解析不出 DedeUserID → `bilibili:unknown`(**不抛错**,退化偏保守)。
 */
export function biliAccountKeyFromCookiesJson(text: string | null | undefined): string {
  if (!text) return biliAccountKey(null);
  try {
    const data = JSON.parse(text) as { cookie_info?: { cookies?: unknown }; cookies?: unknown };
    const raw = data?.cookie_info?.cookies ?? data?.cookies ?? [];
    if (Array.isArray(raw)) {
      for (const c of raw) {
        const o = c as { name?: unknown; value?: unknown };
        if (String(o?.name ?? "").toLowerCase() === "dedeuserid") return biliAccountKey(String(o?.value ?? ""));
      }
    }
  } catch {
    /* 坏 JSON → 保守回落到 unknown 桶 */
  }
  return biliAccountKey(null);
}

/**
 * 字段消毒:坏数据(非有限数/非数组/非升序/窗口外)在此收敛,不进内存态。
 * orchestrator/upload-limits.ts 直接 re-export 本函数(单一真理源,勿复制第二份)。
 */
export function sanitizeUploadLimitState(raw: unknown, now: number, windowMs: number): UploadLimitState {
  const o = (raw ?? {}) as Record<string, unknown>;
  const blockedUntil =
    typeof o.blockedUntil === "number" && Number.isFinite(o.blockedUntil) && o.blockedUntil > 0 ? o.blockedUntil : 0;
  let times: number[] = [];
  if (Array.isArray(o.times)) {
    times = o.times.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0);
  } else if (typeof o.times === "string") {
    // 容错:JSON 坏掉不该让整份状态作废 —— 至少保住 blockedUntil(防打爆更重要)。
    try {
      const parsed: unknown = JSON.parse(o.times);
      if (Array.isArray(parsed)) {
        times = parsed.filter((t): t is number => typeof t === "number" && Number.isFinite(t) && t > 0);
      }
    } catch {
      /* 坏 JSON → 窗口计数归零,但冷却仍在 */
    }
  }
  times.sort((a, b) => a - b);
  const winStart = now - Math.max(0, windowMs);
  return { blockedUntil, times: times.filter((t) => t > winStart) };
}

/**
 * 默认 sqlite 适配器(`node:sqlite`,Node 内置 —— core 不引任何外部依赖,故不违反分层)。
 * 落点/表结构由调用方给路径参数;**master 与节点各自传自己的库路径**,不共享文件系统。
 *
 * 表结构 030 T19:按账号键分行 `upload_limits(key PK, blockedUntil, times, updatedAt)`。
 * **自动迁移 T8 的单行结构**(`id=1 CHECK(id=1)`、无 key 列)→ 把 `id=1` 那行搬到 `default` 键,
 * 老部署重启后冷却不丢。幂等;迁移异常向上抛(上层 fail-closed,不静默)。
 */
const CREATE_SQL = `CREATE TABLE IF NOT EXISTS upload_limits(
  key TEXT PRIMARY KEY,
  blockedUntil INTEGER NOT NULL DEFAULT 0,
  times TEXT NOT NULL DEFAULT '[]',
  updatedAt INTEGER NOT NULL DEFAULT 0)`;

const UPSERT_SQL = `INSERT INTO upload_limits(key, blockedUntil, times, updatedAt) VALUES(?, ?, ?, ?)
  ON CONFLICT(key) DO UPDATE SET blockedUntil=excluded.blockedUntil, times=excluded.times, updatedAt=excluded.updatedAt`;

function migrateLegacyUploadLimits(db: DatabaseSync, log: (m: string) => void): void {
  const cols = db.prepare("PRAGMA table_info(upload_limits)").all() as Array<{ name?: string }>;
  if (cols.length === 0 || cols.some((c) => c.name === "key")) return; // 无表 / 已是新结构
  log("[upload-gate] 检测到 T8 单行表结构,迁移为按账号分键");
  db.exec("ALTER TABLE upload_limits RENAME TO upload_limits_legacy");
  db.exec(CREATE_SQL);
  const row = db.prepare("SELECT blockedUntil, times FROM upload_limits_legacy WHERE id=1").get() as
    | { blockedUntil?: unknown; times?: unknown }
    | undefined;
  if (row) db.prepare(UPSERT_SQL).run(UPLOAD_GATE_DEFAULT_KEY, Number(row.blockedUntil ?? 0), String(row.times ?? "[]"), Date.now());
  db.exec("DROP TABLE upload_limits_legacy");
}

export interface OpenUploadLimitStoreOpts {
  /** 诊断日志(默认 console.error);存储异常必须留痕,绝不静默。 */
  log?: (m: string) => void;
  /** 时间源(测试可注入)。 */
  now?: () => number;
}

/**
 * 打开(或惰性建)按账号分键的 sqlite 存储。**打不开时不吞异常**:返回 unavailable store,
 * `load()` 恒为 null → UploadGate 进入 fail-closed(保守冷却),绝不退化成无限速。
 */
export function openUploadLimitStore(dbPath: string, opts: OpenUploadLimitStoreOpts = {}): UploadGateStore {
  const log = opts.log ?? ((m: string) => console.error(m));
  const now = opts.now ?? Date.now;
  let db: DatabaseSync;
  try {
    // 父目录不存在时 sqlite 报 `unable to open database file`,退化成 fail-closed 静默冷却
    // (实测节点首次跑时数据根尚未建库 → 整场卡在 30min 冷却)。主动建父目录,消除该静默失败。
    mkdirSync(dirname(dbPath), { recursive: true });
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=3000");
    migrateLegacyUploadLimits(db, log);
    db.exec(CREATE_SQL);
  } catch (e) {
    log(`[upload-gate] 打开 ${dbPath} 失败,进入保守限流: ${(e as Error).message}`);
    return unavailableUploadLimitStore(dbPath, log);
  }
  const getRow = db.prepare("SELECT blockedUntil, times FROM upload_limits WHERE key=?");
  const putRow = db.prepare(UPSERT_SQL);
  const readState = (key: string): UploadLimitState => {
    const row = getRow.get(key) as { blockedUntil?: unknown; times?: unknown } | undefined;
    if (!row) return { blockedUntil: 0, times: [] };
    return sanitizeUploadLimitState(row, now(), Number.MAX_SAFE_INTEGER);
  };
  return {
    /**
     * 原子占额:`BEGIN IMMEDIATE` 内读-判-写,两个进程同时抢也只有一个能拿到同一格配额。
     * 抛错(库不可用/锁超时)→ 上层按「拿不到」处理并 warn,不静默放行。
     */
    tryClaim(key: string, nowMs: number, windowMs: number, rateLimit: number): boolean {
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          const st = readState(key);
          if (st.blockedUntil > nowMs) { db.exec("ROLLBACK"); return false; }
          // 边界用 `>=`(比 sanitize 的裁剪更保守一毫毫秒):恰好落在窗口边界上的提交算**仍在窗口内**。
          // 否则同一毫秒内的多个进程会连开多格 → 实测 6 次并发在边界处放过 3 次(超 rateLimit)。
          // 本行不经过 sanitize(直接读原始列),故必须自己用 `>=`;与 `_awaitSlot` 的判定逐字一致。
          const winStart = nowMs - windowMs;
          const times = st.times.filter((t) => t >= winStart);
          if (rateLimit > 0 && times.length >= rateLimit) { db.exec("ROLLBACK"); return false; }
          putRow.run(key, st.blockedUntil, JSON.stringify([...times, nowMs]), now());
          db.exec("COMMIT");
          return true;
        } catch (e) {
          try { db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
          throw e;
        }
      } catch (e) {
        log(`[upload-gate] 原子占额失败(${key}): ${(e as Error).message}`);
        return false;
      }
    },
    load(key: string): UploadLimitState | null {
      try {
        // 落盘不裁窗口(MAX_SAFE_INTEGER),裁剪交给 sanitizeUploadLimitState(带真实 windowMs)。
        // 表在、行不在 = 该键还没提交过 → 空状态(正常),不是「不可用」。
        return readState(key);
      } catch (e) {
        log(`[upload-gate] 读取 ${dbPath} 失败,进入保守限流: ${(e as Error).message}`);
        return null;
      }
    },
    save(key: string, state: UploadLimitState): void {
      // 并发多进程写同一键:busy_timeout + upsert;最坏情况抛错 → 上层 warn(状态仅存内存/进程内)。
      putRow.run(key, state.blockedUntil, JSON.stringify(state.times), now());
    },
    close(): void {
      try { db.close(); } catch { /* 已关闭 */ }
    },
  };
}

function unavailableUploadLimitStore(dbPath: string, log: (m: string) => void): UploadGateStore {
  return {
    load: () => null,
    save: () => {
      log(`[upload-gate] ${dbPath} 不可用,跳过持久化(状态仅存内存)`);
    },
    close: () => {},
  };
}

export class UploadGate {
  private readonly store?: UploadGateStore;
  private readonly rateLimit: number;
  private readonly windowMs: number;
  private readonly cooldownMs: number;
  private readonly failClosedMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly throwIfBlocked: () => void;
  private readonly warn: (msg: string) => void;
  /** 每个键一条串行链:同键并发调用不会互相超卖窗口配额。 */
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(opts: UploadGateOpts = {}) {
    this.store = opts.store;
    this.rateLimit = Math.max(0, opts.rateLimit ?? 5);
    this.windowMs = Math.max(0, opts.windowMs ?? 600_000);
    this.cooldownMs = Math.max(0, opts.cooldownMs ?? 1_800_000);
    this.failClosedMs = Math.max(0, opts.failClosedMs ?? UPLOAD_FAIL_CLOSED_MS);
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.throwIfBlocked = opts.throwIfBlocked ?? (() => {});
    this.warn = opts.warn ?? ((m: string) => console.error(m));
  }

  /** 当前窗口上限(诊断/队列页用)。 */
  get rateWindowLimit(): number {
    return this.rateLimit;
  }

  /** 只读快照(不过链、不落盘);store 不可用时返回 fail-closed 后的冷却截止。 */
  peek(key: string): UploadLimitState {
    const raw = this.read(key);
    if (raw === null) return { blockedUntil: this.now() + Math.max(this.cooldownMs, this.failClosedMs), times: [] };
    return raw;
  }

  /** 读回并消毒;null = 存储不可用(调用方须 fail-closed)。 */
  private read(key: string): UploadLimitState | null {
    if (!this.store) return { blockedUntil: 0, times: [] };
    try {
      const raw = this.store.load(key);
      if (raw === null) return null;
      return sanitizeUploadLimitState(raw, this.now(), this.windowMs);
    } catch (e) {
      this.warn(`[upload-gate] 读取限流状态失败(${key}),按保守冷却处理: ${(e as Error).message}`);
      return null;
    }
  }

  private write(key: string, state: UploadLimitState): void {
    if (!this.store) return;
    try {
      this.store.save(key, state);
    } catch (e) {
      // 落盘失败不阻断投稿(内存/后续读仍限流),但必须留痕 —— 绝不静默。
      this.warn(`[upload-gate] 持久化失败(${key},限流状态仅存内存): ${(e as Error).message}`);
    }
  }

  /**
   * 等一个上传配额(冷却 + 窗口)并**占额**;同键并发按到达顺序串行,窗口不会被超卖。
   * 返回时该键的窗口已记入本次提交 → 与 ResourcePool._awaitUploadSlot 语义一致。
   */
  async awaitSlot(key: string = UPLOAD_GATE_DEFAULT_KEY): Promise<void> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(
      () => this._awaitSlot(key),
      () => this._awaitSlot(key),
    );
    this.chains.set(key, run.catch(() => undefined));
    return run;
  }

  /**
   * 窗口边界口径(**全仓库唯一**):`t >= now - windowMs` 视为**仍在窗口内**。
   * orchestrator 的 `_awaitUploadSlot` 与 store 的 `tryClaim` 都逐字照抄此处,改一处必须三处同改。
   */
  private async _awaitSlot(key: string): Promise<void> {
    let state = this.read(key);
    if (state === null) {
      // fail-closed:按「刚命中 601」处理,宁可多等,不能重启/损坏即打爆。
      const cooldown = Math.max(this.cooldownMs, this.failClosedMs);
      this.warn(`[upload-gate] 限流状态不可用(${key}),本进程按保守冷却 ${cooldown}ms 启动`);
      await this.waitUntil(this.now() + cooldown);
      state = this.read(key) ?? { blockedUntil: 0, times: [] };
    }
    // 主循环:先过冷却期(独立于次数限制 —— 即使限速关闭,命中 601 后也要等冷却),
    // 再保证滑动窗口内不超过 rateLimit 次。
    for (;;) {
      this.throwIfBlocked();
      const now = this.now();
      if (state.blockedUntil > now) {
        await this.waitUntil(state.blockedUntil);
        const fresh = this.read(key);
        if (fresh) state = { blockedUntil: Math.max(fresh.blockedUntil, state.blockedUntil), times: fresh.times };
        continue;
      }
      if (this.rateLimit <= 0) return;
      const winStart = now - this.windowMs;
      const times: number[] = state.times.filter((t) => t >= winStart);
      if (times.length < this.rateLimit) {
        if (this.store?.tryClaim) {
          // 原子路径(多进程共享同一行时不会各占一格 → 不会超卖)。
          if (this.store.tryClaim(key, now, this.windowMs, this.rateLimit)) {
            const claimed = this.read(key);
            if (claimed) state = claimed;
            return;
          }
          // 没抢到:重读真实状态(别人刚占或刚记冷却),再算该等多久。
          const fresh = this.read(key);
          state = fresh ?? { blockedUntil: 0, times };
          continue;
        }
        times.push(now);
        state = { blockedUntil: state.blockedUntil, times };
        this.write(key, state); // 占额即落盘,重启后窗口不归零
        return;
      }
      // 滑出边界含在窗口内 → 至少再等 1ms,否则 waitUntil 立刻返回 → 死循环。
      await this.waitUntil(times[0] + this.windowMs + 1);
      // 醒来重读:别的进程/别的 gate 可能已推进状态(单调取晚,不覆盖更新的冷却)
      const fresh = this.read(key);
      state =
        fresh === null
          ? { blockedUntil: 0, times } // 存储中途坏了 → 退化成只用窗口判断,后续占额仍会写失败告警
          : {
              blockedUntil: Math.max(fresh.blockedUntil, state.blockedUntil),
              times: fresh.times.length >= times.length ? fresh.times : times,
            };
    }
  }

  private async waitUntil(deadline: number): Promise<void> {
    for (;;) {
      this.throwIfBlocked();
      const remain = deadline - this.now();
      if (remain <= 0) return;
      await this.sleep(remain);
    }
  }

  /**
   * 记录一次 601/21566 命中:该账号键进入冷却(跨重启保留)。
   * 用 max 取更晚的截止,避免旧的冷却记录覆盖掉新的更长冷却。
   */
  recordRateLimit(key: string = UPLOAD_GATE_DEFAULT_KEY, cooldownMs?: number): void {
    const cd = Math.max(0, cooldownMs ?? this.cooldownMs);
    const cur = this.read(key) ?? { blockedUntil: 0, times: [] };
    this.write(key, { blockedUntil: Math.max(cur.blockedUntil, this.now() + cd), times: cur.times });
  }

  /**
   * 便捷包装:包住一次上传提交 —— 先 awaitSlot,失败时若命中 601/21566 则 recordRateLimit。
   * 两侧(orchestrator ResourcePool 未来迁移、node-pipeline)共用这一个入口,避免漏记冷却。
   */
  async run<T>(key: string, fn: () => Promise<T>, cooldownMs?: number): Promise<T> {
    await this.awaitSlot(key);
    try {
      return await fn();
    } catch (e) {
      if (isUploadRateLimited(e)) this.recordRateLimit(key, cooldownMs);
      throw e;
    }
  }
}
