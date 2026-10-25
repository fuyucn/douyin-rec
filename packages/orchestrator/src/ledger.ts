import { DatabaseSync } from "node:sqlite";
import type { HubJobState, HubNodeStateName, HubStepName } from "@drec/core";

// 状态/步骤名的**唯一真理 = core 的只读契约**(app 的 hub 任务页只读同一张库,靠它对齐)。
export type JobState = HubJobState;

/**
 * job 状态转换白名单(from → 允许的 to)。**由现有调用点推导**,不是凭空设计:
 * - 主线 pending → syncing(pipeline 选优后)→ merging → uploading(仅分段上传)→ done / needs_manual;
 * - 任意非终态可 → failed(markFailed / sweepStale)、→ needs_manual(停止 / 转人工)、→ done(上传成功是事实);
 * - 重入:failed → syncing(reconciler 自动重试)、{非 done} → retrying(runNow / retryNode);
 * - needs_manual 只能被人工 → retrying / done(hub-recheck 翻正);**不得 → failed**,否则
 *   「用户已停止」的场被还在跑的 pipeline 迟到的 markFailed 改回 failed,reconciler 会自动重跑。
 * - done 是终态,无出边;人工重跑须显式 `{ force: true }`(runNow / retryNode)。
 * 同态(含 done → done 的幂等收尾、failed → failed 的 fails 自增)恒允许,不列在表里。
 */
export const ALLOWED_TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  pending: ["settling", "syncing", "retrying", "failed", "needs_manual", "done"],
  settling: ["syncing", "retrying", "failed", "needs_manual", "done"],
  syncing: ["merging", "retrying", "failed", "needs_manual", "done"],
  merging: ["uploading", "retrying", "failed", "needs_manual", "done"],
  uploading: ["retrying", "failed", "needs_manual", "done"],
  retrying: ["syncing", "failed", "needs_manual", "done"],
  failed: ["syncing", "retrying", "needs_manual", "done"],
  needs_manual: ["retrying", "done"],
  done: [],
};

/** from→to 是否合法。库里不认识的旧状态一律放行:行仍可读,也允许被改写回合法状态自愈。 */
export function isTransitionAllowed(from: string, to: JobState): boolean {
  if (from === to) return true;
  const allowed = (ALLOWED_TRANSITIONS as Record<string, readonly JobState[] | undefined>)[from];
  return allowed === undefined || allowed.includes(to);
}

/** 状态写入的显式覆盖:仅供人工重跑(runNow / retryNode)把 done 拨回进行中。 */
export interface TransitionOpts { force?: boolean }

export interface JobRow {
  streamKey: string;
  state: JobState;
  winnerWorker?: string;
  bv?: string;
  error?: string;
  fails: number;
  /** 该场第一簇的开录时间(供同日多场 key 去重判断;旧库为 null)。 */
  startMs?: number | null;
  /** 本场 stage stem / B 站标题(首次 merge 锁定,改模板不影响重跑)。旧库为 null。 */
  outputStem?: string | null;
  /** 收尾后留存转格式的跟随状态(JSON,见 finalize-format `Followups`;plans/036 T9b)。旧库 / 未派发为 null。 */
  followups?: string | null;
  /** Node upload queue plan (JSON, see node-upload-queue `UploadPlan`; plan 038 T12). Old rows / never queued: null. */
  uploadPlan?: string | null;
  /** Last queue poll snapshot (JSON `NodeUploadStatusDTO`; plan 038 PR5, display only). */
  uploadStatus?: string | null;
  /**
   * Manual review mark on a `needs_manual` row (issue #312): when a person/agent confirmed the case needs no
   * further action. The row keeps its state, history and log; the queue inbox just stops listing it.
   * Cleared automatically when the job changes state or re-enters needs_manual for a different reason.
   */
  ackedAt?: number | null;
  ackNote?: string | null;
  /**
   * Bilibili season association state for this archive (issue #364).
   * NULL = feature off / never attempted; "pending" = BV persisted but the add may not have landed;
   * "done" = the archive is confirmed in the section; "failed" = a definite failure, surfaced to a human.
   */
  seasonState?: "pending" | "done" | "failed" | null;
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
  /** 该 worker 本场弹幕条目数(0 = 无弹幕/仅表头空 xml;旧库/未统计为 NULL)。 */
  danmuCount?: number | null;
  isWinner: number; // 0/1（sqlite 无 bool）
  updatedAt: number;
}

/** 一次状态转换事件(时间线复盘:每步起点 = 该事件时刻,步骤耗时 = 相邻事件差)。 */
export interface JobEvent { streamKey: string; state: JobState; at: number; }

/** pipeline 细粒度子步骤规范名(流程图节点)。upload/append 仅 upload 模式有。 */
export type StepName = HubStepName;
/**
 * Sub-step events: start/done pair for duration and the currently running step (parallel branches
 * each have their own pair). `skipped` means the step was deliberately not run this round.
 */
export type StepPhase = "start" | "done" | "skipped";
export interface StepEvent { streamKey: string; step: StepName; phase: StepPhase; at: number; detail?: string }

/** 单节点状态(workflow 安全阀 + 单节点重跑)。与 StepName 同 key。 */
export type NodeStateName = HubNodeStateName;
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
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN outputStem TEXT"); } catch { /* 列已存在 */ }
    // 收尾后留存转格式的跟随状态(T9b;JSON)。旧库补列,老行为 NULL = 从未派发。
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN followups TEXT"); } catch { /* 列已存在 */ }
    // Node upload queue plan (plan 038 T12): persisted job ids per order. Old rows stay NULL = never queued.
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN uploadPlan TEXT"); } catch { /* column exists */ }
    // Last queue poll snapshot for the queue page (plan 038 PR5). Display only; NULL = never polled.
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN uploadStatus TEXT"); } catch { /* column exists */ }
    // Manual review mark for needs_manual rows (issue #312). NULL = not reviewed.
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN ackedAt INTEGER"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN ackNote TEXT"); } catch { /* column exists */ }
    try { this.db.exec("ALTER TABLE sync_jobs ADD COLUMN seasonState TEXT"); } catch { /* column exists */ }
    // transition() names these columns on every state change, so a failed ALTER must surface here, not later.
    const cols = new Set((this.db.prepare("PRAGMA table_info(sync_jobs)").all() as Array<{ name: string }>).map((c) => c.name));
    if (!cols.has("ackedAt") || !cols.has("ackNote") || !cols.has("seasonState")) {
      throw new Error("sync_jobs migration failed: ackedAt/ackNote/seasonState columns missing");
    }
    // 选优候选明细:每场每节点一行,记 coverage/时长/起止/缺口 + 是否胜出,供事后复盘选优依据。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_candidates(
      streamKey TEXT NOT NULL, workerId TEXT NOT NULL,
      coverage REAL NOT NULL, durationSec REAL NOT NULL,
      startMs INTEGER NOT NULL, endMs INTEGER NOT NULL, totalGapSec REAL NOT NULL,
      isWinner INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
      PRIMARY KEY(streamKey, workerId))`);
    // 既有库迁移:补 danmuCount 列(选优「为什么这台赢」的弹幕维度;已存在则忽略)。
    try { this.db.exec("ALTER TABLE sync_candidates ADD COLUMN danmuCount INTEGER"); } catch { /* 列已存在 */ }
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
    // 分段模式的分 P checkpoint:记录每个已成功 append 的文件(段号 + 该段名),
    // 供续跑精确跳过已提交的段,避免重复分 P 或漏段(mergeSegments=false 时用)。
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_parts(
      streamKey TEXT NOT NULL, groupName TEXT NOT NULL, partIndex INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL, PRIMARY KEY(streamKey, groupName, partIndex))`);
  }
  private logEvent(streamKey: string, state: JobState, at: number): void {
    this.db.prepare("INSERT INTO sync_job_events(streamKey,state,at) VALUES(?,?,?)").run(streamKey, state, at);
  }
  /** 记一个子步骤 start/done(pipeline 调用;流程图用)。 */
  logStep(streamKey: string, step: StepName, phase: StepPhase, detail?: string): void {
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
  /**
   * 受白名单约束的状态写入:合法才写库 + 记事件,返回 true;
   * 非法(含无此 job、并发下已被别处改走)→ 不写库、不动 updatedAt、console.warn、返回 false,**不 throw**。
   * 用「按读到的旧状态比较再写」(CAS)而非先查后盲写,并发/重入下也不会覆盖终态。
   */
  private transition(
    streamKey: string,
    to: JobState,
    set: string,
    args: Array<string | number | null>,
    force = false,
    reopen: (cur: JobRow) => boolean = (cur) => cur.state !== to,
  ): boolean {
    const cur = this.get(streamKey);
    if (!cur) {
      console.warn(`[ledger] 拒绝状态转换 ${streamKey}: → ${to}(无此 job)`);
      return false;
    }
    if (!force && !isTransitionAllowed(cur.state, to)) {
      console.warn(`[ledger] 拒绝非法状态转换 ${streamKey}: ${cur.state} → ${to}`);
      return false;
    }
    const at = this.now();
    // A state change (or a new needs_manual reason) is a new case: drop any earlier review mark.
    const clearAck = reopen(cur) ? "ackedAt=NULL, ackNote=NULL, " : "";
    const r = this.db.prepare(`UPDATE sync_jobs SET state=?, ${set}, ${clearAck}updatedAt=? WHERE streamKey=? AND state=?`)
      .run(to, ...args, at, streamKey, cur.state);
    if (Number(r.changes) === 0) {
      console.warn(`[ledger] 拒绝状态转换 ${streamKey}: ${cur.state} → ${to}(状态已被并发改写)`);
      return false;
    }
    this.logEvent(streamKey, to, at);
    return true;
  }
  setState(
    streamKey: string,
    state: JobState,
    patch: { winnerWorker?: string; error?: string } = {},
    opts: TransitionOpts = {},
  ): boolean {
    return this.transition(streamKey, state, "winnerWorker=COALESCE(?,winnerWorker), error=?",
      [patch.winnerWorker ?? null, patch.error ?? null], opts.force === true,
      (cur) => cur.state !== state || (state === "needs_manual" && (patch.error ?? null) !== (cur.error ?? null)));
  }
  /**
   * Set (note = text) or clear (note = null) the manual review mark of a `needs_manual` row (issue #312).
   * Compare-and-set on the state: a row that moved on meanwhile is left alone and false is returned.
   * Does not change state, events or `updatedAt` (the age of the case stays the age of the case).
   */
  ackManual(streamKey: string, note: string | null): boolean {
    const at = note === null ? null : this.now();
    const r = this.db.prepare("UPDATE sync_jobs SET ackedAt=?, ackNote=? WHERE streamKey=? AND state='needs_manual'")
      .run(at, note, streamKey);
    return Number(r.changes) > 0;
  }
  /**
   * 流程内推进(syncing/merging/uploading):done 场的收尾补跑会重入这些阶段,
   * done 是终态 → 静默跳过(不 warn、不改库),流程照常往下走到收尾。
   */
  advanceState(
    streamKey: string,
    state: JobState,
    patch: { winnerWorker?: string; error?: string } = {},
  ): boolean {
    if (this.get(streamKey)?.state === "done") return false;
    return this.setState(streamKey, state, patch);
  }
  markDone(streamKey: string, bv: string): boolean {
    return this.transition(streamKey, "done", "bv=?, error=NULL", [bv]);
  }
  /** checkpoint:P1 上传成功即落 bv 列(不改 state、不写事件)。续跑靠它判断"已建稿"。 */
  setBv(streamKey: string, bv: string): void {
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET bv=?, updatedAt=? WHERE streamKey=?").run(bv, at, streamKey);
  }
  /** Season association state (issue #364); NULL clears it when the feature is off. */
  setSeasonState(streamKey: string, state: JobRow["seasonState"]): void {
    this.db.prepare("UPDATE sync_jobs SET seasonState=?, updatedAt=? WHERE streamKey=?").run(state ?? null, this.now(), streamKey);
  }
  /** 锁定本场产物 stem(不改 state、不写事件)。已有值不覆盖。 */
  setOutputStem(streamKey: string, stem: string): void {
    const existing = this.get(streamKey)?.outputStem?.trim();
    if (existing) return;
    const at = this.now();
    this.db.prepare("UPDATE sync_jobs SET outputStem=?, updatedAt=? WHERE streamKey=?").run(stem, at, streamKey);
  }
  /**
   * 认领「收尾后留存转格式」的派发权(T9b):仅当 `followups` 仍为 NULL 时写入初值并返回 true;
   * 已被认领(含历史派发过的场)→ false。这是「每场只派发一次」的唯一闸门(done 场收尾补跑会重入 runPipeline)。
   * 不改 state、不写事件、**不碰 updatedAt**(跟随状态不该扰动 listRecent 排序与 sweepStale 判定)。
   */
  claimFollowups(streamKey: string, initial: string): boolean {
    const r = this.db.prepare("UPDATE sync_jobs SET followups=? WHERE streamKey=? AND followups IS NULL").run(initial, streamKey);
    return Number(r.changes) > 0;
  }
  /** 覆盖写跟随状态(不碰 updatedAt)。无此 job → 无操作。 */
  setFollowups(streamKey: string, json: string): void {
    this.db.prepare("UPDATE sync_jobs SET followups=? WHERE streamKey=?").run(json, streamKey);
  }
  getFollowups(streamKey: string): string | null {
    const r = this.db.prepare("SELECT followups FROM sync_jobs WHERE streamKey=?").get(streamKey) as { followups?: string | null } | undefined;
    return r?.followups ?? null;
  }
  /**
   * Claim the right to persist the upload plan: writes only while `uploadPlan` is NULL (first writer wins).
   * Must happen before any enqueue so a re-entry reuses the same job ids and generation.
   * Does not touch state, events or `updatedAt`.
   */
  claimUploadPlan(streamKey: string, json: string): boolean {
    const r = this.db.prepare("UPDATE sync_jobs SET uploadPlan=? WHERE streamKey=? AND uploadPlan IS NULL").run(json, streamKey);
    return Number(r.changes) > 0;
  }
  /** Overwrite the plan (recovery moves an order to a new generation). No such job: no-op. */
  setUploadPlan(streamKey: string, json: string): void {
    this.db.prepare("UPDATE sync_jobs SET uploadPlan=? WHERE streamKey=?").run(json, streamKey);
  }
  /** Store the latest queue observation; does not bump updatedAt (the poller's touch owns liveness). */
  setUploadStatus(streamKey: string, json: string): void {
    this.db.prepare("UPDATE sync_jobs SET uploadStatus=? WHERE streamKey=?").run(json, streamKey);
  }
  getUploadPlan(streamKey: string): string | null {
    const r = this.db.prepare("SELECT uploadPlan FROM sync_jobs WHERE streamKey=?").get(streamKey) as { uploadPlan?: string | null } | undefined;
    return r?.uploadPlan ?? null;
  }
  /** Orders that have a queue plan and are not yet terminal in the ledger (the queue poller's work list). */
  listUploadPlans(): Array<{ streamKey: string; state: JobState; uploadPlan: string }> {
    return this.db.prepare("SELECT streamKey, state, uploadPlan FROM sync_jobs WHERE uploadPlan IS NOT NULL AND state NOT IN('done','needs_manual')")
      .all() as unknown as Array<{ streamKey: string; state: JobState; uploadPlan: string }>;
  }
  /** Refresh `updatedAt` without changing state: proof of life for a queue-managed order (keeps sweepStale off it). */
  touch(streamKey: string): void {
    this.db.prepare("UPDATE sync_jobs SET updatedAt=? WHERE streamKey=?").run(this.now(), streamKey);
  }
  /**
   * 仍有未终结项的场(对账轮询用)。判据 = JSON 里的 `"open":true`(finalize-format 写入,`JSON.stringify` 无空格);
   * 全部终结后写回 `open:false`,于是历史 done 场不会每轮被扫描解析。
   */
  listOpenFollowups(): Array<{ streamKey: string; followups: string }> {
    return this.db.prepare("SELECT streamKey, followups FROM sync_jobs WHERE followups LIKE '%\"open\":true%'")
      .all() as unknown as Array<{ streamKey: string; followups: string }>;
  }
  /** 某 step 的最新事件是否为 done(续跑用:跳过已完成的 append 组)。无该 step 事件 → false。 */
  isStepDone(streamKey: string, step: StepName): boolean {
    const r = this.db
      .prepare("SELECT phase FROM sync_job_steps WHERE streamKey=? AND step=? ORDER BY at DESC, rowid DESC LIMIT 1")
      .get(streamKey, step) as { phase?: string } | undefined;
    return r?.phase === "done";
  }

  /** 分段模式:记录某个分 P(组 + 段号)已成功提交(append 成功即写,续跑据此跳过)。 */
  markPartDone(streamKey: string, groupName: string, partIndex: number): void {
    this.db.prepare(
      "INSERT INTO sync_parts(streamKey,groupName,partIndex,updatedAt) VALUES(?,?,?,?) " +
      "ON CONFLICT(streamKey,groupName,partIndex) DO UPDATE SET updatedAt=excluded.updatedAt",
    ).run(streamKey, groupName, partIndex, this.now());
  }
  /** 分段模式:该组已成功提交的段号集合(续跑跳过它们)。 */
  doneParts(streamKey: string, groupName: string): Set<number> {
    const rows = this.db
      .prepare("SELECT partIndex FROM sync_parts WHERE streamKey=? AND groupName=?")
      .all(streamKey, groupName) as unknown as Array<{ partIndex: number }>;
    return new Set(rows.map((r) => r.partIndex));
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
      // 前奏不进节点表(UI 仍按 steps 画)。node_upload 与 pull 同为「拉取/处理后上传」的前奏:
      // 回填它 = 给旧 job 造一个可能被 reconciler 当成可重试的节点 —— 而节点侧一旦跑过就可能已建稿,
      // 故与 pull 同口径排除(真正的闸门仍是失败路径写的 upload_plain failed)。
      if (step === "select" || step === "pull" || step === "node_upload") continue;
      const name = step as StepName;
      // A skip is not a failure and not a completion: it carries no node verdict at all.
      if (e.phase === "skipped") continue;
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
    const sweptKeys = [...new Set(staleNodes.map((r) => r.streamKey))].filter((k) => {
      if (isStreamActive(k)) return false;
      const job = this.get(k);
      // needs_manual / done 是终态:用户停止后 running 节点可能还没刷盘,sweep 不得改写。
      return job?.state !== "needs_manual" && job?.state !== "done";
    });
    if (sweptKeys.length === 0) return;
    this.db.prepare(
      "UPDATE sync_node_states SET state='failed', error='进程重启中断', updatedAt=? WHERE streamKey IN (" +
      sweptKeys.map(() => "?").join(",") + ") AND state='running'",
    ).run(this.now(), ...sweptKeys);
    // job 级状态同步到 failed:reconciler 只重入 pending/failed。只标 running 节点不更新 job,
    // 会留下 merging/uploading 的僵尸 job 永远跳过(本次线上卡住即此 bug)。
    for (const streamKey of sweptKeys) {
      const job = this.get(streamKey);
      if (job && job.state !== "failed" && job.state !== "needs_manual" && job.state !== "done") {
        this.setState(streamKey, "failed", { error: "进程重启中断" });
      }
    }
  }

  /** runNow 前把 blocked/running 节点拨回 pending,清 error,让 DAG 能再起。 */
  resetActiveNodes(streamKey: string): void {
    for (const row of this.getNodeStates(streamKey)) {
      if (row.state === "blocked" || row.state === "running") {
        this.syncNodeState(streamKey, row.node, "pending", { error: null });
      }
    }
  }
  /** pipeline 抛错时:置 failed + 记 error + fails 自增(供重试上限判定)。 */
  markFailed(streamKey: string, error: string): boolean {
    return this.transition(streamKey, "failed", "error=?, fails=fails+1", [error]);
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
    cands: Array<{ workerId: string; coverage: number; durationSec: number; startMs: number; endMs: number; totalGapSec: number; danmuCount?: number }>,
    winnerWorkerId?: string,
  ): void {
    const now = this.now();
    const stmt = this.db.prepare(
      `INSERT INTO sync_candidates(streamKey,workerId,coverage,durationSec,startMs,endMs,totalGapSec,danmuCount,isWinner,updatedAt)
       VALUES(?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(streamKey,workerId) DO UPDATE SET
         coverage=excluded.coverage, durationSec=excluded.durationSec,
         startMs=excluded.startMs, endMs=excluded.endMs, totalGapSec=excluded.totalGapSec,
         danmuCount=excluded.danmuCount,
         isWinner=excluded.isWinner, updatedAt=excluded.updatedAt`,
    );
    for (const c of cands) {
      stmt.run(streamKey, c.workerId, c.coverage, c.durationSec, c.startMs, c.endMs, c.totalGapSec, c.danmuCount ?? null,
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
