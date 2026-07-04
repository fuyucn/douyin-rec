import { DatabaseSync } from "node:sqlite";

export type JobState = "pending"|"settling"|"syncing"|"merging"|"uploading"|"done"|"failed"|"needs_manual";
export interface JobRow { streamKey: string; state: JobState; winnerTenant?: string; bv?: string; error?: string; fails: number; updatedAt: number; }

/** 一个节点候选的选优指标(落库供复盘"为什么这台赢")。 */
export interface CandidateRow {
  streamKey: string;
  tenantId: string;
  coverage: number;
  durationSec: number;
  startMs: number;
  endMs: number;
  totalGapSec: number;
  isWinner: number; // 0/1（sqlite 无 bool）
  updatedAt: number;
}

/** 一次状态转换事件(时间线复盘:每步起点 = 该事件时刻,步骤耗时 = 相邻事件差)。 */
export interface JobEvent { streamKey: string; state: JobState; at: number; }

/** pipeline 细粒度子步骤规范名(流程图节点)。upload/append 仅 upload 模式有。 */
export type StepName =
  | "select" | "pull" | "merge"
  | "burn_danmu" | "burn_livechat"
  | "upload_plain" | "append_danmu" | "append_livechat";
/** 子步骤事件:start/done 配对(能算每步耗时 + 判断当前在跑哪步;异步并行的两轨各有各的起止)。 */
export interface StepEvent { streamKey: string; step: StepName; phase: "start" | "done"; at: number; }

export class SyncLedger {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs(
      streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerTenant TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL)`);
    // 既有库迁移:补 fails 列(已存在则忽略)。
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN fails INTEGER NOT NULL DEFAULT 0"); } catch { /* 列已存在 */ }
    // 选优候选明细:每场每节点一行,记 coverage/时长/起止/缺口 + 是否胜出,供事后复盘选优依据。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_candidates(
      streamKey TEXT NOT NULL, tenantId TEXT NOT NULL,
      coverage REAL NOT NULL, durationSec REAL NOT NULL,
      startMs INTEGER NOT NULL, endMs INTEGER NOT NULL, totalGapSec REAL NOT NULL,
      isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, tenantId))`);
    // 状态转换事件流(append-only):每次 setState/markDone/markFailed/upsertPending 追加一行。
    // Web「hub 任务」页据此展示步骤时间线/当前步已运行时长/按历史步骤耗时估 ETA。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_job_events(
      streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_job_events_key ON sync_job_events(streamKey, at)");
    // 细粒度子步骤流(start/done):驱动前端「真·分叉双轨」流程图(合并后 烧录轨‖上传轨,再 join)。
    // 与粗粒度 sync_job_events 分表:events 驱动状态徽标/ETA,steps 驱动流程图。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_job_steps(
      streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_job_steps_key ON sync_job_steps(streamKey, at)");
  }
  private logEvent(streamKey: string, state: JobState, at: number): void {
    this.db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(streamKey, state, at);
  }
  /** 记一个子步骤 start/done(pipeline 调用;流程图用)。 */
  logStep(streamKey: string, step: StepName, phase: "start" | "done"): void {
    this.db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at) VALUES(?,?,?,?)")
      .run(streamKey, step, phase, this.now());
  }
  /** 某场的子步骤事件流(升序)。 */
  getSteps(streamKey: string): StepEvent[] {
    return this.db.prepare("SELECT streamKey,step,phase,at FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
      .all(streamKey) as unknown as StepEvent[];
  }
  /** 上次发出的时间戳(见 now 的单调性保证)。 */
  private lastNow = 0;
  /**
   * 毫秒时间戳,**进程内严格单调递增**(同毫秒内多次调用 +1 递推)。
   * 旧实现用 sqlite unixepoch 只有秒精度 → 同秒内多次状态转换的 updatedAt/事件时序不可分,
   * listRecent 排序与事件时间线都会乱。
   */
  private now(): number {
    let t = Date.now();
    if (t <= this.lastNow) t = this.lastNow + 1;
    this.lastNow = t;
    return t;
  }
  upsertPending(streamKey: string): { isNew: boolean } {
    const existing = this.get(streamKey);
    if (existing) return { isNew: false };
    const at = this.now();
    this.db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run(streamKey, "pending", at);
    this.logEvent(streamKey, "pending", at);
    return { isNew: true };
  }
  get(streamKey: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM sync_jobs WHERE streamKey=?").get(streamKey) as unknown as JobRow | undefined;
    return r ?? null;
  }
  setState(streamKey: string, state: JobState, patch: { winnerTenant?: string; error?: string } = {}): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET state=?, winnerTenant=COALESCE(?,winnerTenant), error=?, updatedAt=? WHERE streamKey=?")
      .run(state, patch.winnerTenant ?? null, patch.error ?? null, at, streamKey);
    this.logEvent(streamKey, state, at);
  }
  markDone(streamKey: string, bv: string): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET state='done', bv=?, error=NULL, updatedAt=? WHERE streamKey=?").run(bv, at, streamKey);
    this.logEvent(streamKey, "done", at);
  }
  /** pipeline 抛错时:置 failed + 记 error + fails 自增(供重试上限判定)。 */
  markFailed(streamKey: string, error: string): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET state='failed', error=?, fails=fails+1, updatedAt=? WHERE streamKey=?")
      .run(error, at, streamKey);
    this.logEvent(streamKey, "failed", at);
  }
  /** 某场的状态转换时间线(升序)。 */
  getEvents(streamKey: string): JobEvent[] {
    return this.db.prepare("SELECT * FROM sync_job_events WHERE streamKey=? ORDER BY at ASC, rowid ASC")
      .all(streamKey) as unknown as JobEvent[];
  }
  /** 最近 N 个 job(updatedAt 倒序,Web hub 任务页用)。 */
  listRecent(limit = 20): JobRow[] {
    return this.db.prepare("SELECT * FROM sync_jobs ORDER BY updatedAt DESC LIMIT ?").all(limit) as unknown as JobRow[];
  }
  listActive(): JobRow[] {
    return this.db.prepare("SELECT * FROM sync_jobs WHERE state NOT IN('done','needs_manual')").all() as unknown as JobRow[];
  }
  /** 记录某场各节点的选优候选指标(幂等覆盖)。winnerTenantId 标记哪台胜出。 */
  recordCandidates(
    streamKey: string,
    cands: Array<{ tenantId: string; coverage: number; durationSec: number; startMs: number; endMs: number; totalGapSec: number }>,
    winnerTenantId?: string,
  ): void {
    const now = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO sync_candidates(streamKey,tenantId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(streamKey,tenantId) DO UPDATE SET
         coverage=excluded.coverage, durationSec=excluded.durationSec,
         startMs=excluded.startMs, endMs=excluded.endMs, totalGapSec=excluded.totalGapSec,
         isWinner=excluded.isWinner, updatedAt=excluded.updatedAt`,
    );
    for (const c of cands) {
      stmt.run(streamKey, c.tenantId, c.coverage, c.durationSec, c.startMs, c.endMs, c.totalGapSec,
        c.tenantId === winnerTenantId ? 1 : 0, now);
    }
  }
  /** 取某场的候选明细(复盘用)。 */
  getCandidates(streamKey: string): CandidateRow[] {
    return this.db.prepare("SELECT * FROM sync_candidates WHERE streamKey=? ORDER BY isWinner DESC, coverage DESC")
      .all(streamKey) as unknown as CandidateRow[];
  }
  close(): void { this.db.close(); }
}
