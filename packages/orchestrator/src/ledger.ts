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
  }
  private now(): number { return Number((this.db.prepare("SELECT unixepoch('now')*1000 AS t").get() as unknown as { t: number })!.t); }
  upsertPending(streamKey: string): { isNew: boolean } {
    const existing = this.get(streamKey);
    if (existing) return { isNew: false };
    this.db.prepare("INSERT INTO sync_jobs(streamKey,state,updatedAt) VALUES(?,?,?)").run(streamKey, "pending", this.now());
    return { isNew: true };
  }
  get(streamKey: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM sync_jobs WHERE streamKey=?").get(streamKey) as unknown as JobRow | undefined;
    return r ?? null;
  }
  setState(streamKey: string, state: JobState, patch: { winnerTenant?: string; error?: string } = {}): void {
    this.db.prepare("UPDATE sync_jobs SET state=?, winnerTenant=COALESCE(?,winnerTenant), error=?, updatedAt=? WHERE streamKey=?")
      .run(state, patch.winnerTenant ?? null, patch.error ?? null, this.now(), streamKey);
  }
  markDone(streamKey: string, bv: string): void {
    this.db.prepare("UPDATE sync_jobs SET state='done', bv=?, error=NULL, updatedAt=? WHERE streamKey=?").run(bv, this.now(), streamKey);
  }
  /** pipeline 抛错时:置 failed + 记 error + fails 自增(供重试上限判定)。 */
  markFailed(streamKey: string, error: string): void {
    this.db.prepare("UPDATE sync_jobs SET state='failed', error=?, fails=fails+1, updatedAt=? WHERE streamKey=?")
      .run(error, this.now(), streamKey);
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
