/**
 * upload-limits.ts — 上传限流状态(冷却截止 + 滑动窗口提交时刻)的**跨重启持久化**。
 *
 * 为什么:B 站对投稿有 601/21566 频率限制,命中后必须冷却。冷却与滑动窗口若只存在内存,
 * master 一重启就清零 → 立刻又能猛传 → 反复触发风控。ResourcePool 仍是唯一判定者,
 * 本模块只负责「把它的两个状态字段落盘 / 读回」。
 *
 * 设计取舍(勿轻改):
 * - **不改变内存语义**:同进程内仍按内存滑动窗口推进,本模块只是附加的落盘/恢复通道。
 *   不能靠「每 tick 重建 pool」实现持久化 —— 那会静默重置内存状态,与本模块目标相反。
 * - **不可用 = 保守**:存储损坏/打不开时 load() 返回 null,ResourcePool 进入
 *   **fail-closed**(先冷却一个 uploadCooldownMs 再放行),绝不降级成「无限速」。
 * - **接口不写死 master**:sqlite 落点由调用方给路径,节点侧上传(T19)可传自己的库复用同一实现。
 */
import { DatabaseSync } from "node:sqlite";

/** 上传限流的两个状态字段(与 ResourcePool 内部字段一一对应)。 */
export interface UploadLimitState {
  /** 命中 601 后的静默截止时刻(ms);0 = 未在冷却。 */
  blockedUntil: number;
  /** 滑动窗口内的提交时刻(ms),升序。 */
  times: number[];
}

export interface UploadLimitStore {
  /** 读回状态;文件/表缺失 = 空状态;**存储不可用(损坏/打不开)= null**。 */
  load(): UploadLimitState | null;
  /** 覆盖写单行;失败抛错,由调用方 warn(不静默)。 */
  save(state: UploadLimitState): void;
  close(): void;
}

/** 表结构 = plans/030 T8.1;单行(id=1),同一 sync 库内共享。 */
const CREATE_SQL = `CREATE TABLE IF NOT EXISTS upload_limits(
  id INTEGER PRIMARY KEY CHECK(id=1),
  blockedUntil INTEGER NOT NULL DEFAULT 0,
  times TEXT NOT NULL DEFAULT '[]',
  updatedAt INTEGER NOT NULL DEFAULT 0)`;

/**
 * 字段消毒:坏数据(非有限数/非数组/非升序/窗口外)在此收敛,不进内存态。
 * 窗口裁剪由调用方给 windowMs —— 落盘时用 MAX_SAFE_INTEGER(原样保存),
 * 恢复时用真实窗口(读回即丢过期,避免时钟回拨把陈旧时刻当已占额)。
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
    } catch { /* 坏 JSON → 窗口计数归零,但冷却仍在 */ }
  }
  times.sort((a, b) => a - b);
  const winStart = now - Math.max(0, windowMs);
  return { blockedUntil, times: times.filter((t) => t > winStart) };
}

export interface UploadLimitStoreOpts {
  /** 诊断日志(默认 console.error);存储异常必须留痕,绝不静默。 */
  log?: (msg: string) => void;
}

/** 打开(或惰性建)sqlite 存储。**不吞异常**:打不开时返回 unavailable store,让上层 fail-closed。 */
export function openUploadLimitStore(dbPath: string, opts: UploadLimitStoreOpts = {}): UploadLimitStore {
  const log = opts.log ?? ((m: string) => console.error(m));
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA busy_timeout=3000");
    db.exec(CREATE_SQL);
  } catch (e) {
    log(`[upload-limits] 打开 ${dbPath} 失败,进入保守限流: ${(e as Error).message}`);
    return unavailableStore(dbPath, log);
  }
  return {
    load(): UploadLimitState | null {
      try {
        const row = db.prepare("SELECT blockedUntil, times FROM upload_limits WHERE id=1").get() as
          | { blockedUntil?: unknown; times?: unknown }
          | undefined;
        // 表在、行不在 = 首次运行 → 空窗口(正常),不是「不可用」。
        if (!row) return { blockedUntil: 0, times: [] };
        return sanitizeUploadLimitState(row, Date.now(), Number.MAX_SAFE_INTEGER);
      } catch (e) {
        log(`[upload-limits] 读取 ${dbPath} 失败,进入保守限流: ${(e as Error).message}`);
        return null;
      }
    },
    save(state: UploadLimitState): void {
      db.prepare(
        `INSERT INTO upload_limits(id, blockedUntil, times, updatedAt) VALUES(1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET blockedUntil=excluded.blockedUntil, times=excluded.times, updatedAt=excluded.updatedAt`,
      ).run(state.blockedUntil, JSON.stringify(state.times), Date.now());
    },
    close(): void {
      try { db.close(); } catch { /* 已关闭 */ }
    },
  };
}

function unavailableStore(dbPath: string, log: (m: string) => void): UploadLimitStore {
  return {
    load: () => null,
    save: () => { log(`[upload-limits] ${dbPath} 不可用,跳过持久化(状态仅存内存)`); },
    close: () => {},
  };
}
