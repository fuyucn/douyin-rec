import { DatabaseSync } from "node:sqlite";

export type JobState =
  | "pending"|"settling"|"syncing"|"merging"|"uploading"
  | "retrying"        // 单节点重跑中(非终态,reconciler 不重入)
  | "done"|"failed"|"needs_manual";
export interface JobRow {
  streamKey: string;
  state: JobState;
  winnerWorker?: string;
  bv?: string;
  error?: string;
  fails: number;
  /** 该场第一簇的开录时间(供同日多场 key 去重判断;旧库为 null)。 */
  startMs?: number | null;
  updatedAt: number;
}

/** 一个节点候选的选优指标(落库供复盘"为什么这台赢")。 */
export interface CandidateRow {
  streamKey: string;
  workerId: string;
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
  | "upload_plain" | "append_danmu" | "append_livechat"
  // 清理步骤(各由对应 cleanup 开关驱动;没开 → 不打点 → 前端显示 skipped):
  | "clean_stage_src"   // stageSourceAfterMerge:merge 后删 stage 里拉来的源 .ts
  | "clean_source"      // sourceAfterDone:完成后删各节点原始录制 .ts
  | "clean_stage";      // stageAfterDone:完成后删 stage 合成产物
/** 子步骤事件:start/done 配对(能算每步耗时 + 判断当前在跑哪步;异步并行的两轨各有各的起止)。 */
export interface StepEvent { streamKey: string; step: StepName; phase: "start" | "done"; at: number; detail?: string }

/** 单节点状态(workflow 安全阀 + 单节点重跑)。与 StepName 同 key。 */
export type NodeStateName = "pending" | "running" | "done" | "failed" | "blocked" | "skipped";
export interface NodeStateRow {
  streamKey: string;
  node: StepName;
  state: NodeStateName;
  error: string | null;
  attempts: number;
  updatedAt: number;
}

export class SyncLedger {
  private db: DatabaseSync;
  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_jobs(
      streamKey TEXT PRIMARY KEY, state TEXT NOT NULL,
      winnerWorker TEXT, bv TEXT, error TEXT, fails INTEGER NOT NULL DEFAULT 0,
      startMs INTEGER, updatedAt INTEGER NOT NULL)`);
    // 既有库迁移:补 fails 列(已存在则忽略)。
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN fails INTEGER NOT NULL DEFAULT 0"); } catch { /* 列已存在 */ }
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN startMs INTEGER"); } catch { /* 列已存在 */ }
    // 选优候选明细:每场每节点一行,记 coverage/时长/起止/缺口 + 是否胜出,供事后复盘选优依据。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_candidates(
      streamKey TEXT NOT NULL, workerId TEXT NOT NULL,
      coverage REAL NOT NULL, durationSec REAL NOT NULL,
      startMs INTEGER NOT NULL, endMs INTEGER NOT NULL, totalGapSec REAL NOT NULL,
      isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, workerId))`);
    // 既有库列改名 tenant→worker(fresh DB 上旧列不存在会抛 → 吞掉;SQLite ≥3.25 支持 PK 列改名)。
    try { this.db.exec("ALTER TABLE sync_jobs RENAME COLUMN winnerTenant TO winnerWorker"); } catch { /* 已是新列名或 fresh */ }
    try { this.db.exec("ALTER TABLE sync_candidates RENAME COLUMN tenantId TO workerId"); } catch { /* 已是新列名或 fresh */ }
    // 状态转换事件流(append-only):每次 setState/markDone/markFailed/upsertPending 追加一行。
    // Web「hub 任务」页据此展示步骤时间线/当前步已运行时长/按历史步骤耗时估 ETA。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_job_events(
      streamKey TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL)`);
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_job_events_key ON sync_job_events(streamKey, at)");
    // 细粒度子步骤流(start/done):驱动前端「真·分叉双轨」流程图(合并后 烧录轨‖上传轨,再 join)。
    // 与粗粒度 sync_job_events 分表:events 驱动状态徽标/ETA,steps 驱动流程图。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_job_steps(
      streamKey TEXT NOT NULL, step TEXT NOT NULL, phase TEXT NOT NULL, at INTEGER NOT NULL, detail TEXT)`);
    // 既有库迁移:补 detail 列(已存在则忽略)。
    try { this.db.exec("ALTER TABLE sync_job_steps ADD COLUMN detail TEXT"); } catch { /* 列已存在 */ }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_job_steps_key ON sync_job_steps(streamKey, at)");
    // 单节点状态(workflow 安全阀):pending/running/done/failed/blocked/skipped + error/attempts。
    // 供 DAG 幂等续跑、reconciler 判定「可安全自动重跑」、UI 单节点重跑入口。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_node_states(
      streamKey TEXT NOT NULL, node TEXT NOT NULL, state TEXT NOT NULL,
      error TEXT, attempts INTEGER NOT NULL DEFAULT 0, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, node))`);
  }
  private logEvent(streamKey: string, state: JobState, at: number): void {
    this.db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(streamKey, state, at);
  }
  /** 记一个子步骤 start/done(pipeline 调用;流程图用)。 */
  logStep(streamKey: string, step: StepName, phase: "start" | "done", detail?: string): void {
    this.db.prepare("INSERT INTO sync_job_steps(streamKey,step,phase,at,detail) VALUES(?,?,?,?,?)")
      .run(streamKey, step, phase, this.now(), detail ?? null);
  }
  /** 某场的子步骤事件流(升序)。 */
  getSteps(streamKey: string): StepEvent[] {
    return this.db.prepare("SELECT streamKey,step,phase,at,detail FROM sync_job_steps WHERE streamKey=? ORDER BY at ASC, rowid ASC")
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
  upsertPending(streamKey: string, startMs?: number): { isNew: boolean } {
    const existing = this.get(streamKey);
    if (existing) {
      // 旧库没存过 startMs 时顺手回填,让后续同日多场判断有据可依。
      if (existing.startMs == null && startMs != null) {
        this.db.prepare("UPDATE sync_jobs SET startMs=?, updatedAt=updatedAt WHERE streamKey=?").run(startMs, streamKey);
      }
      return { isNew: false };
    }
    const at = this.now();
    this.db.prepare("INSERT INTO sync_jobs(streamKey,state,startMs,updatedAt) VALUES(?,?,?,?)")
      .run(streamKey, "pending", startMs ?? null, at);
    this.logEvent(streamKey, "pending", at);
    return { isNew: true };
  }
  get(streamKey: string): JobRow | null {
    const r = this.db.prepare("SELECT * FROM sync_jobs WHERE streamKey=?").get(streamKey) as unknown as JobRow | undefined;
    return r ?? null;
  }
  setState(streamKey: string, state: JobState, patch: { winnerWorker?: string; error?: string } = {}): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET state=?, winnerWorker=COALESCE(?,winnerWorker), error=?, updatedAt=? WHERE streamKey=?")
      .run(state, patch.winnerWorker ?? null, patch.error ?? null, at, streamKey);
    this.logEvent(streamKey, state, at);
  }
  markDone(streamKey: string, bv: string): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET state='done', bv=?, error=NULL, updatedAt=? WHERE streamKey=?").run(bv, at, streamKey);
    this.logEvent(streamKey, "done", at);
  }
  /** checkpoint:P1 上传成功即落 bv 列(不改 state、不写事件)。续跑靠它判断"已建稿"。 */
  setBv(streamKey: string, bv: string): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET bv=?, updatedAt=? WHERE streamKey=?").run(bv, at, streamKey);
  }
  /** 某 step 的最新事件是否为 done(续跑用:跳过已完成的 append 组)。无该 step 事件 → false。 */
  isStepDone(streamKey: string, step: StepName): boolean {
    const r = this.db
      .prepare("SELECT phase FROM sync_job_steps WHERE streamKey=? AND step=? ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(streamKey, step) as { phase?: string } | undefined;
    return r?.phase === "done";
  }
  /** 记录/覆盖单节点状态(workflow 执行器 + retryNode 用)。 */
  syncNodeState(
    streamKey: string,
    node: StepName,
    state: NodeStateName,
    opts: { error?: string | null; attempts?: number } = {},
  ): void {
    const row = this.getNodeState(streamKey, node);
    const attempts = opts.attempts ?? ((row?.attempts ?? 0) + (state === "running" ? 1 : 0));
    const at = this.now();
    this.db.prepare(
      `INSERT INTO sync_node_states(streamKey,node,state,error,attempts,updatedAt) VALUES(?,?,?,?,?,?)
       ON CONFLICT(streamKey,node) DO UPDATE SET
         state=excluded.state, error=excluded.error, attempts=excluded.attempts, updatedAt=excluded.updatedAt`,
    ).run(streamKey, node, state, opts.error ?? null, attempts, at);
  }
  getNodeState(streamKey: string, node: StepName): NodeStateRow | null {
    const r = this.db.prepare("SELECT * FROM sync_node_states WHERE streamKey=? AND node=?")
      .get(streamKey, node) as unknown as NodeStateRow | undefined;
    return r ?? null;
  }
  getNodeStates(streamKey: string): NodeStateRow[] {
    return this.db.prepare("SELECT * FROM sync_node_states WHERE streamKey=? ORDER BY node ASC")
      .all(streamKey) as unknown as NodeStateRow[];
  }
  /** 某场 failed 节点清单(workflow 失败收口 / reconciler 自动重试判定用)。 */
  getFailedNodes(streamKey: string): NodeStateRow[] {
    return this.db.prepare("SELECT * FROM sync_node_states WHERE streamKey=? AND state='failed'")
      .all(streamKey) as unknown as NodeStateRow[];
  }
  /**
   * 旧 run 回填:没有 sync_node_states 的 job,按 sync_job_steps 最新事件回填。
   * done → done;只有 start 没有 done → failed(错误「上次中断/失败」);bv 已落库 → upload_plain 回填 done。
   * select/pull/merge 等新节点无事件也回填(merge 按事件;其余不臆造)。
   */
  backfillNodeStates(streamKey: string): void {
    if (this.getNodeStates(streamKey).length > 0) return;
    const job = this.get(streamKey);
    const steps = this.getSteps(streamKey);
    const last = new Map<string, { phase: string; at: number }>();
    for (const s of steps) last.set(s.step, { phase: s.phase, at: s.at });
    for (const [step, e] of last) {
      if (step === "select" || step === "pull") continue; // 前奏不进节点表(UI 仍按 steps 画)
      const name = step as StepName;
      this.syncNodeState(streamKey, name, e.phase === "done" ? "done" : "failed", {
        error: e.phase === "done" ? undefined : "上次中断/失败",
      });
    }
    if (job?.bv) this.syncNodeState(streamKey, "upload_plain", "done");
  }
  /**
   * 崩溃恢复 sweep:超过 staleMs 的 retrying job / running 节点 → 标 failed(「进程重启中断」),
   * 让 reconciler/UI 可重入。会先回填旧 run 的节点状态,否则升级前的失败 job 没有重跑入口。
   * isStreamActive(可选):本进程正在执行该场 pipeline(长 merge/burn 会超过 staleMs)→
   * 不误杀还在跑的节点;重启后本进程没有该场执行,才按 stale 清理。
   */
  sweepStale(staleMs: number, isStreamActive: (streamKey: string) => boolean = () => false): void {
    const cutoff = this.now() - staleMs;
    for (const job of this.listActive()) {
      this.backfillNodeStates(job.streamKey);
      // 非终态 job 整场卡住(含 running 节点已 failed、job 仍是 merging/uploading 的僵尸态)
      // → 同步 failed,让 reconciler 下一轮重入。本进程正在跑的场(长 merge/burn/上传)不误杀。
      if (job.state !== "failed" && job.updatedAt <= cutoff && !isStreamActive(job.streamKey)) {
        this.setState(job.streamKey, "failed", { error: "进程重启中断" });
      }
    }
    const staleNodes = this.db.prepare(
      "SELECT streamKey FROM sync_node_states WHERE state='running' AND updatedAt<=?",
    ).all(cutoff) as unknown as Array<{ streamKey: string }>;
    const sweptKeys = [...new Set(staleNodes.map((r) => r.streamKey))].filter((k) => !isStreamActive(k));
    if (sweptKeys.length === 0) return;
    this.db.prepare(
      "UPDATE sync_node_states SET state='failed', error='进程重启中断', updatedAt=? WHERE streamKey IN (" +
      sweptKeys.map(() => "?").join(",") + ") AND state='running'",
    ).run(this.now(), ...sweptKeys);
    // job 级状态同步到 failed:reconciler 只重入 pending/failed。只标 running 节点不更新 job,
    // 会留下 merging/uploading 的僵尸 job 永远跳过(本次线上卡住即此 bug)。
    for (const streamKey of sweptKeys) {
      const job = this.get(streamKey);
      if (job && job.state !== "failed") {
        this.setState(streamKey, "failed", { error: "进程重启中断" });
      }
    }
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
  /** 全部 job key + 开录时间/最后更新时间:给聚类做同日 key 去重,防第二场复用已 done 的 base key。 */
  listKeys(): Array<{ streamKey: string; startMs: number | null; updatedAt: number }> {
    return this.db.prepare("SELECT streamKey, startMs, updatedAt FROM sync_jobs").all() as unknown as Array<{
      streamKey: string;
      startMs: number | null;
      updatedAt: number;
    }>;
  }
  /** 记录某场各节点的选优候选指标(幂等覆盖)。winnerWorkerId 标记哪台胜出。 */
  recordCandidates(
    streamKey: string,
    cands: Array<{ workerId: string; coverage: number; durationSec: number; startMs: number; endMs: number; totalGapSec: number }>,
    winnerWorkerId?: string,
  ): void {
    const now = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO sync_candidates(streamKey,workerId,coverage,durationSec,startMs,endMs,totalGapSec,isWinner,updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?)
       ON CONFLICT(streamKey,workerId) DO UPDATE SET
         coverage=excluded.coverage, durationSec=excluded.durationSec,
         startMs=excluded.startMs, endMs=excluded.endMs, totalGapSec=excluded.totalGapSec,
         isWinner=excluded.isWinner, updatedAt=excluded.updatedAt`,
    );
    for (const c of cands) {
      stmt.run(streamKey, c.workerId, c.coverage, c.durationSec, c.startMs, c.endMs, c.totalGapSec,
        c.workerId === winnerWorkerId ? 1 : 0, now);
    }
  }
  /** 取某场的候选明细(复盘用)。 */
  getCandidates(streamKey: string): CandidateRow[] {
    return this.db.prepare("SELECT * FROM sync_candidates WHERE streamKey=? ORDER BY isWinner DESC, coverage DESC")
      .all(streamKey) as unknown as CandidateRow[];
  }
  close(): void { this.db.close(); }
}
