/**
 * proc-queue/store.ts — 每节点持久任务表 `ProcQueueStore`(plans/036 §2.3)。
 *
 * `<root>/db/proc-queue.db`(`node:sqlite`,WAL + busy_timeout)。**任何进程首开都执行幂等迁移**
 * (`PRAGMA user_version` + `CREATE TABLE IF NOT EXISTS`,包在 `BEGIN IMMEDIATE` 内)。
 * 多进程同时首开:首次切 WAL 需排他锁,busy_timeout 对它不生效(直接报 `database is locked`),
 * 故 `PRAGMA journal_mode=WAL` 单独带退避重试(`initWal`);test/proc-queue/store-multiproc.test.ts 用真进程钉住。
 * 全部写操作是同步的、单条 `BEGIN IMMEDIATE` 事务 → 跨进程(serve / record)互斥靠 sqlite 文件锁。
 *
 * 只经 core 的状态机(`canTransition` / `cancelOutcome`)判迁移合法性,不自造第二套;不 import 任何处理器、
 * 不扫目录(只 `stat` 回填文件标识)。
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  assertJobInvariants, canTransition, cancelOutcome, jobIdOf,
  type EnqueueResult, type JobState, type ProcessJob,
} from "@drec/core";

/** `<dataRoot>/db/proc-queue.db`。路径单点(app/orchestrator/cli 都经它,不各拼一份)。 */
export function procQueueDbPath(dataRoot: string): string {
  return join(dataRoot, "db", "proc-queue.db");
}

/** logicalKey 以此结尾 = 派发方不知道文件标识,由执行节点 enqueue 时对 `inputs[0]` stat 回填 `${ino}-${size}`。 */
export const FILE_TAG_PLACEHOLDER = "@";

/**
 * `${ino}-${size}`。用 bigint stat:64 位 inode(xfs/btrfs 大盘)可能超 2^53,Number 会丢精度(N8)。
 * 文件不存在 / 不可读 → 抛错。
 */
export function fileTagOf(path: string, stat: typeof statSync = statSync): string {
  const st = stat(path, { bigint: true });
  return `${String(st.ino)}-${String(st.size)}`;
}

export const LEASE_MS = 30_000;
export const GC_RETAIN_MS = 7 * 24 * 3600_000;

/** 任务行(契约字段 + 执行态)。 */
export interface ProcJobRecord extends ProcessJob {
  state: JobState;
  attempts: number;
  claimedBy: string | null;
  /** 曾经被认领过(只增不减;`cancelIfUnclaimed` 的判据 —— attempts 会因关停回退而不可靠)。 */
  everClaimed: boolean;
  cancelRequested: boolean;
  /** done 时的实际产物。 */
  resultOutputs: string[] | null;
  note: string | null;
  error: string | null;
  updatedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface LeaseRow {
  kind: string;
  owner: string;
  pid: number;
  heartbeatAt: number;
  expiresAt: number;
  handoverRequested: boolean;
}

export type FinishOutcome =
  | { state: "done"; outputs: string[]; note?: string }
  | { state: "failed"; error: string }
  | { state: "uncertain"; error: string }
  /** 取消落点经 `cancelOutcome(kind, hasIntent)`;第一期无 intent 概念,hasIntent 缺省 false。 */
  | { state: "cancelled"; hasIntent?: boolean; error?: string };

export interface ProcQueueStoreOpts {
  now?: () => number;
  /** pid 是否存活(测试可注入);默认 `process.kill(pid, 0)`。仅用于提前接管,过期才是权威。 */
  isPidAlive?: (pid: number) => boolean;
  log?: (m: string) => void;
  /** sqlite busy_timeout(默认 5000ms;测试可调小以快速观察锁冲突)。 */
  busyTimeoutMs?: number;
  /** 只读打开:不建目录、不切 WAL、不迁移、只读连接;库/表缺失时查询抛错由调用方兜。 */
  readOnly?: boolean;
}

const SCHEMA_VERSION = 1;
const WAL_RETRIES = 200;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const DDL = `
CREATE TABLE IF NOT EXISTS proc_jobs(
  jobId TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  logicalKey TEXT NOT NULL,
  generation INTEGER NOT NULL,
  state TEXT NOT NULL,
  inputs TEXT NOT NULL,
  outputs TEXT,
  params TEXT NOT NULL,
  replaceInputs INTEGER NOT NULL,
  ownerTaskId INTEGER,
  ownerStreamKey TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  claimedBy TEXT,
  everClaimed INTEGER NOT NULL DEFAULT 0,
  cancelRequested INTEGER NOT NULL DEFAULT 0,
  resultOutputs TEXT,
  note TEXT,
  error TEXT,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL,
  startedAt INTEGER,
  finishedAt INTEGER);
CREATE INDEX IF NOT EXISTS idx_proc_jobs_kind_state ON proc_jobs(kind, state, createdAt);
CREATE INDEX IF NOT EXISTS idx_proc_jobs_logical ON proc_jobs(kind, logicalKey);
CREATE TABLE IF NOT EXISTS proc_runner_lease(
  kind TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  pid INTEGER NOT NULL,
  heartbeatAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL,
  handoverRequested INTEGER NOT NULL DEFAULT 0);
`;

const defaultPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // 存在但无权限 = 活着
  }
};

type Row = Record<string, unknown>;

function toRecord(r: Row): ProcJobRecord {
  const outputs = r.outputs == null ? undefined : (JSON.parse(String(r.outputs)) as string[]);
  const rec: ProcJobRecord = {
    jobId: String(r.jobId),
    kind: String(r.kind),
    logicalKey: String(r.logicalKey),
    generation: Number(r.generation),
    inputs: JSON.parse(String(r.inputs)) as string[],
    params: JSON.parse(String(r.params)) as Record<string, unknown>,
    replaceInputs: Number(r.replaceInputs) === 1,
    owner: {
      ...(r.ownerTaskId != null ? { taskId: Number(r.ownerTaskId) } : {}),
      ...(r.ownerStreamKey != null ? { streamKey: String(r.ownerStreamKey) } : {}),
    },
    createdAt: Number(r.createdAt),
    state: String(r.state) as JobState,
    attempts: Number(r.attempts),
    claimedBy: r.claimedBy == null ? null : String(r.claimedBy),
    everClaimed: Number(r.everClaimed) === 1,
    cancelRequested: Number(r.cancelRequested) === 1,
    resultOutputs: r.resultOutputs == null ? null : (JSON.parse(String(r.resultOutputs)) as string[]),
    note: r.note == null ? null : String(r.note),
    error: r.error == null ? null : String(r.error),
    updatedAt: Number(r.updatedAt),
    startedAt: r.startedAt == null ? null : Number(r.startedAt),
    finishedAt: r.finishedAt == null ? null : Number(r.finishedAt),
  };
  if (outputs) rec.outputs = outputs;
  return rec;
}

function toLease(r: Row): LeaseRow {
  return {
    kind: String(r.kind), owner: String(r.owner), pid: Number(r.pid),
    heartbeatAt: Number(r.heartbeatAt), expiresAt: Number(r.expiresAt),
    handoverRequested: Number(r.handoverRequested) === 1,
  };
}

export interface ListFilter {
  kind?: string;
  state?: JobState;
  ownerTaskId?: number;
  limit?: number;
}

export class ProcQueueStore {
  private readonly db: DatabaseSync;
  private readonly now: () => number;
  private readonly isPidAlive: (pid: number) => boolean;

  constructor(readonly dbPath: string, opts: ProcQueueStoreOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.isPidAlive = opts.isPidAlive ?? defaultPidAlive;
    if (opts.readOnly) {
      this.db = new DatabaseSync(dbPath, { readOnly: true });
      this.db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5000}`);
      return;
    }
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA busy_timeout=${opts.busyTimeoutMs ?? 5000}`);
    this.initWal();
    this.migrate();
  }

  /**
   * 切 WAL(幂等)。已是 WAL 直接返回;否则退避重试 `locked/busy`:并发首开时 busy_timeout 对
   * journal_mode 切换不生效,不重试会让后到的进程直接抛 `database is locked`(F3 实测 2 进程 43% 失败)。
   */
  private initWal(): void {
    for (let i = 0; ; i++) {
      try {
        const cur = (this.db.prepare("PRAGMA journal_mode").get() as Row).journal_mode;
        if (String(cur).toLowerCase() === "wal") return;
        this.db.exec("PRAGMA journal_mode=WAL");
        return;
      } catch (e) {
        if (i >= WAL_RETRIES || !/locked|busy/i.test((e as Error).message)) throw e;
        sleepSync(5 + Math.random() * 25);
      }
    }
  }

  /** 幂等迁移:`BEGIN IMMEDIATE` 内重读 user_version(两进程同时首开,后到者见已迁移即跳过)。 */
  private migrate(): void {
    this.tx(() => {
      const v = Number((this.db.prepare("PRAGMA user_version").get() as Row).user_version ?? 0);
      if (v >= SCHEMA_VERSION) return;
      this.db.exec(DDL);
      this.db.exec(`PRAGMA user_version=${SCHEMA_VERSION}`);
    });
  }

  /** `BEGIN IMMEDIATE` 事务;抛错回滚并重抛。 */
  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      try { this.db.exec("ROLLBACK"); } catch { /* 已回滚 */ }
      throw e;
    }
  }

  close(): void {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  // ───────────────────────── 读 ─────────────────────────

  get(jobId: string): ProcJobRecord | null {
    const r = this.db.prepare("SELECT * FROM proc_jobs WHERE jobId=?").get(jobId) as Row | undefined;
    return r ? toRecord(r) : null;
  }

  list(f: ListFilter = {}): ProcJobRecord[] {
    const where: string[] = [];
    const args: Array<string | number> = [];
    if (f.kind !== undefined) { where.push("kind=?"); args.push(f.kind); }
    if (f.state !== undefined) { where.push("state=?"); args.push(f.state); }
    if (f.ownerTaskId !== undefined) { where.push("ownerTaskId=?"); args.push(f.ownerTaskId); }
    const sql = `SELECT * FROM proc_jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY createdAt, rowid LIMIT ?`;
    args.push(f.limit ?? 1000);
    return (this.db.prepare(sql).all(...args) as Row[]).map(toRecord);
  }

  /** 各 kind 的 running / pending 计数(只含有行的 kind)。 */
  active(): { running: Record<string, number>; pending: Record<string, number> } {
    const out = { running: {} as Record<string, number>, pending: {} as Record<string, number> };
    const rows = this.db
      .prepare("SELECT kind, state, COUNT(*) AS n FROM proc_jobs WHERE state IN ('running','pending') GROUP BY kind, state")
      .all() as Row[];
    for (const r of rows) out[String(r.state) as "running" | "pending"][String(r.kind)] = Number(r.n);
    return out;
  }

  /** 下一代 generation(同 kind+logicalKey 已有最大代 +1;无则 1)。 */
  nextGeneration(kind: string, logicalKey: string): number {
    const r = this.db
      .prepare("SELECT MAX(generation) AS g FROM proc_jobs WHERE kind=? AND logicalKey=?")
      .get(kind, logicalKey) as Row;
    return (r.g == null ? 0 : Number(r.g)) + 1;
  }

  // ───────────────────────── 入队 ─────────────────────────

  /**
   * 幂等入队。`allowedRoots` 必传(fail-closed):违反契约 → `rejected`(不抛)。
   * 顺序:契约校验 → stat `inputs[0]`(失败 → `rejected`)→ 回填 fileTag(logicalKey 以 `@` 结尾时)→
   * 同 jobId 已存在:done 且产物缺失 → `stale`(附 `nextGeneration`);否则原样回报现态,**不改任何行**。
   * 返回的 `jobId` 是回填后的最终 id。
   */
  enqueue(job: ProcessJob, opts: { allowedRoots: readonly string[] }): EnqueueResult {
    try {
      assertJobInvariants(job, { allowedRoots: opts.allowedRoots });
    } catch (e) {
      return { jobId: job.jobId, state: "rejected", error: (e as Error).message };
    }
    let tag: string;
    try {
      tag = fileTagOf(job.inputs[0]);
    } catch (e) {
      return { jobId: job.jobId, state: "rejected", error: `inputs[0] 无法 stat: ${(e as Error).message}` };
    }
    const logicalKey = job.logicalKey.endsWith(FILE_TAG_PLACEHOLDER) ? `${job.logicalKey}${tag}` : job.logicalKey;
    const jobId = jobIdOf(job.kind, logicalKey, job.generation);
    return this.tx((): EnqueueResult => {
      const existing = this.get(jobId);
      if (existing) {
        switch (existing.state) {
          case "pending": return { jobId, state: "pending" };
          case "running": return { jobId, state: "running" };
          case "done": {
            const targets = existing.resultOutputs ?? existing.outputs ?? [];
            if (targets.some((p) => !existsSync(p))) {
              return { jobId, state: "stale", nextGeneration: this.nextGeneration(job.kind, logicalKey) };
            }
            return { jobId, state: "done" };
          }
          default:
            // failed / uncertain / cancelled:不隐式复活(须经 requeue / ackUncertain),入队方不重试。
            return { jobId, state: "rejected", error: `已存在且 state=${existing.state}(需人工处理)` };
        }
      }
      const t = this.now();
      this.db.prepare(
        `INSERT INTO proc_jobs(jobId, kind, logicalKey, generation, state, inputs, outputs, params, replaceInputs,
           ownerTaskId, ownerStreamKey, createdAt, updatedAt)
         VALUES(?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        jobId, job.kind, logicalKey, job.generation, JSON.stringify(job.inputs),
        job.outputs ? JSON.stringify(job.outputs) : null, JSON.stringify(job.params), job.replaceInputs ? 1 : 0,
        job.owner.taskId ?? null, job.owner.streamKey ?? null, t, t,
      );
      return { jobId, state: "pending" };
    });
  }

  // ───────────────────────── 租约 ─────────────────────────

  getLease(kind: string): LeaseRow | null {
    const r = this.db.prepare("SELECT * FROM proc_runner_lease WHERE kind=?").get(kind) as Row | undefined;
    return r ? toLease(r) : null;
  }

  /** 有租约行的 kind(含已过期;`leaseAlive` 再判存活)。 */
  leaseKinds(): string[] {
    return (this.db.prepare("SELECT kind FROM proc_runner_lease").all() as Row[]).map((r) => String(r.kind));
  }

  /** 租约行存活:未过期。pid 已死只用于「提前接管」,不影响此判定(过期为权威)。 */
  leaseAlive(kind: string): boolean {
    const l = this.getLease(kind);
    return !!l && l.expiresAt > this.now();
  }

  /** 该 owner 当前是否仍持有有效(未过期)租约 —— `assertLease` / claim 的权威判据。 */
  leaseValid(kind: string, owner: string): boolean {
    const l = this.getLease(kind);
    return !!l && l.owner === owner && l.expiresAt > this.now();
  }

  /**
   * 抢租约。无行 / 已过期 / 自己持有 / 持有者 pid 已死 → 接管;
   * 否则(他人存活持有)→ `acquired=false`,且 `requestHandover` 时置 `handoverRequested=1`
   * (**不抢正在跑的 job**)。`takeover=true` = 此前存在他人的行(调用方须对其 running 行跑 recover)。
   */
  acquireLease(
    kind: string, owner: string,
    o: { pid?: number; leaseMs?: number; requestHandover?: boolean } = {},
  ): { acquired: boolean; takeover: boolean; holder?: LeaseRow } {
    const pid = o.pid ?? process.pid;
    const leaseMs = o.leaseMs ?? LEASE_MS;
    return this.tx(() => {
      const t = this.now();
      const cur = this.getLease(kind);
      const mine = cur?.owner === owner;
      const stale = !cur || cur.expiresAt <= t || (cur.pid !== pid && !this.isPidAlive(cur.pid));
      if (cur && !mine && !stale) {
        if (o.requestHandover) {
          this.db.prepare("UPDATE proc_runner_lease SET handoverRequested=1 WHERE kind=?").run(kind);
        }
        return { acquired: false, takeover: false, holder: cur };
      }
      this.db.prepare(
        `INSERT INTO proc_runner_lease(kind, owner, pid, heartbeatAt, expiresAt, handoverRequested)
         VALUES(?, ?, ?, ?, ?, 0)
         ON CONFLICT(kind) DO UPDATE SET owner=excluded.owner, pid=excluded.pid, heartbeatAt=excluded.heartbeatAt,
           expiresAt=excluded.expiresAt, handoverRequested=0`,
      ).run(kind, owner, pid, t, t + leaseMs);
      return { acquired: true, takeover: !!cur && !mine };
    });
  }

  /**
   * 心跳续约。行不在 / 持有者已换人 → `ok=false`(调用方须立即 fencing)。
   * 自己的行即使已过期、尚未被人接管,续约仍成立(接管会换 owner)。
   */
  heartbeat(kind: string, owner: string, leaseMs = LEASE_MS): { ok: boolean; handoverRequested: boolean } {
    const t = this.now();
    const res = this.db
      .prepare("UPDATE proc_runner_lease SET heartbeatAt=?, expiresAt=? WHERE kind=? AND owner=?")
      .run(t, t + leaseMs, kind, owner);
    if (Number(res.changes) === 0) return { ok: false, handoverRequested: false };
    return { ok: true, handoverRequested: !!this.getLease(kind)?.handoverRequested };
  }

  /** 删自己的租约行(优雅退出 / 交接完成)。返回是否删到。 */
  releaseLease(kind: string, owner: string): boolean {
    return Number(this.db.prepare("DELETE FROM proc_runner_lease WHERE kind=? AND owner=?").run(kind, owner).changes) > 0;
  }

  // ───────────────────────── 认领 / 执行态 ─────────────────────────

  /**
   * 认领最老的 pending 行(`BEGIN IMMEDIATE`,两连接并发只一个成功)。
   * 只认领 `kinds` 内、且 `owner` 持有**有效租约**的 kind(DB 级 fencing)。
   * `cancelRequested` 的待执行行(曾认领、关停回退后才被取消)**不执行**,认领时直接落终态(经
   * `cancelOutcome`,等价 pending→running→cancelled 一步完成,`attempts` 不增),避免永远停在 pending。
   * `accept` 在事务内逐候选同步判定(须纯判定,不得做告警等副作用):返回 false 则跳过该候选,不改行。
   */
  claim(o: { kinds: readonly string[]; owner: string; accept?: (job: ProcJobRecord) => boolean }): ProcJobRecord | null {
    if (o.kinds.length === 0) return null;
    return this.tx(() => {
      const t = this.now();
      const marks = o.kinds.map(() => "?").join(",");
      const cands = this.db.prepare(
        `SELECT j.* FROM proc_jobs j JOIN proc_runner_lease l ON l.kind=j.kind AND l.owner=? AND l.expiresAt>?
         WHERE j.state='pending' AND j.kind IN (${marks})
         ORDER BY j.createdAt, j.rowid`,
      ).all(o.owner, t, ...o.kinds) as Row[];
      for (const c of cands) {
        const rec = toRecord(c);
        if (rec.cancelRequested) {
          const to = cancelOutcome(rec.kind, false);
          this.db.prepare(
            `UPDATE proc_jobs SET state=?, error='已取消(认领前已请求取消)', finishedAt=?, updatedAt=?
             WHERE jobId=? AND state='pending'`,
          ).run(to, t, t, rec.jobId);
          continue;
        }
        if (o.accept && !o.accept(rec)) continue;
        this.db.prepare(
          `UPDATE proc_jobs SET state='running', claimedBy=?, attempts=attempts+1, everClaimed=1,
             startedAt=?, updatedAt=?, error=NULL WHERE jobId=? AND state='pending'`,
        ).run(o.owner, t, t, rec.jobId);
        return this.get(rec.jobId);
      }
      return null;
    });
  }

  /** running 行的当前状态读取(runner 心跳时查 `cancelRequested`)。 */
  runningOf(owner: string): ProcJobRecord[] {
    return (this.db.prepare("SELECT * FROM proc_jobs WHERE state='running' AND claimedBy=?").all(owner) as Row[]).map(toRecord);
  }

  /** 某 kind 的全部 running 行(接管时 recover 用)。 */
  runningOfKind(kind: string): ProcJobRecord[] {
    return (this.db.prepare("SELECT * FROM proc_jobs WHERE state='running' AND kind=?").all(kind) as Row[]).map(toRecord);
  }

  /**
   * 收尾:校验行为 running 且 `claimedBy===owner`、迁移合法;否则返回 false(调用方已失去该 job,不得再动其产物)。
   */
  finish(jobId: string, owner: string, outcome: FinishOutcome): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running" || row.claimedBy !== owner) return false;
      return this.applyFinish(row, outcome);
    });
  }

  private applyFinish(row: ProcJobRecord, outcome: FinishOutcome): boolean {
    const t = this.now();
    let to: JobState = outcome.state;
    if (outcome.state === "cancelled") to = cancelOutcome(row.kind, outcome.hasIntent ?? false);
    if (!canTransition("running", to)) return false;
    const error = "error" in outcome ? (outcome.error ?? null) : null;
    this.db.prepare(
      `UPDATE proc_jobs SET state=?, resultOutputs=?, note=?, error=?, updatedAt=?, finishedAt=?
       WHERE jobId=? AND state='running'`,
    ).run(
      to, outcome.state === "done" ? JSON.stringify(outcome.outputs) : null,
      outcome.state === "done" ? (outcome.note ?? null) : null, error, t, t, row.jobId,
    );
    return true;
  }

  /**
   * running → pending(关停 abort):只允许 `interruptible` 的 job;`attempts` 回退(关停不算一次尝试)。
   * 校验持有者。返回是否成功。
   */
  releaseForShutdown(jobId: string, owner: string, interruptible: boolean): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running" || row.claimedBy !== owner) return false;
      if (!canTransition("running", "pending", { reason: "shutdown-abort", interruptible })) return false;
      this.db.prepare(
        `UPDATE proc_jobs SET state='pending', claimedBy=NULL, attempts=MAX(attempts-1,0), updatedAt=? WHERE jobId=?`,
      ).run(this.now(), jobId);
      return true;
    });
  }

  /**
   * 接管后处置前任遗留的 running 行(`recover()` 的结果落库)。调用方须已持有该 kind 的有效租约。
   * rerun → pending(`attempts` 保持:那次尝试已发生);done → done;uncertain → uncertain(不自动重跑)。
   * `info.attempts` 给出时为代际 CAS:与当前行不一致则不写、返回 false。
   */
  settleOrphan(
    jobId: string, newOwner: string, outcome: "rerun" | "done" | "uncertain",
    info: { error?: string; allowSelf?: boolean; attempts?: number } = {},
  ): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || row.state !== "running") return false;
      // 代际 CAS(D1):传入快照行的 attempts,已被重新认领(attempts 变了)的新一轮不得被旧快照的处置打回/收尾。
      if (info.attempts !== undefined && row.attempts !== info.attempts) return false;
      // 本持有者名下的行默认拒绝(可能正在跑);仅 runner 确认「已被 fence、不在执行」时 allowSelf(F2)。
      if (row.claimedBy === newOwner && !info.allowSelf) return false;
      if (!this.leaseValid(row.kind, newOwner)) return false;
      if (outcome === "rerun") {
        if (!canTransition("running", "pending", { reason: "lease-expired-rerun" })) return false;
        this.db.prepare("UPDATE proc_jobs SET state='pending', claimedBy=NULL, updatedAt=? WHERE jobId=?").run(this.now(), jobId);
        return true;
      }
      return this.applyFinish(
        row,
        outcome === "done"
          ? { state: "done", outputs: row.outputs ?? [], note: "接管后判定已完成" }
          : { state: "uncertain", error: info.error ?? "接管后无法判定上次执行结果" },
      );
    });
  }

  // ───────────────────────── 人工 / 取消 ─────────────────────────

  /** failed → pending(唯一入口)。`retryable=false`(如 biliup)拒绝。返回是否成功。 */
  requeue(jobId: string, o: { retryable?: boolean } = {}): boolean {
    if (o.retryable === false) return false;
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || !canTransition(row.state, "pending", { reason: "requeue" })) return false;
      this.db.prepare(
        `UPDATE proc_jobs SET state='pending', claimedBy=NULL, error=NULL, finishedAt=NULL, updatedAt=? WHERE jobId=?`,
      ).run(this.now(), jobId);
      return true;
    });
  }

  /** uncertain → failed(人工确认「已知结果不确定」后才能 requeue / purge)。 */
  ackUncertain(jobId: string): boolean {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row || !canTransition(row.state, "failed", { reason: "ack-uncertain" })) return false;
      this.db.prepare("UPDATE proc_jobs SET state='failed', updatedAt=? WHERE jobId=?").run(this.now(), jobId);
      return true;
    });
  }

  /** pending → cancelled,**仅当从未被认领**(原子条件更新)。已认领 → false。 */
  cancelIfUnclaimed(jobId: string): boolean {
    const t = this.now();
    const res = this.db.prepare(
      `UPDATE proc_jobs SET state='cancelled', finishedAt=?, updatedAt=?
       WHERE jobId=? AND state='pending' AND everClaimed=0`,
    ).run(t, t, jobId);
    return Number(res.changes) > 0;
  }

  /**
   * 取消:从未认领的 pending 直接 cancelled;running 置 `cancelRequested`(执行者心跳时发现并 abort);
   * pending 但已认领过(关停回退)也置标记,下次 `claim` 扫到时直接落终态(不执行)。其余状态 noop。
   */
  requestCancel(jobId: string): "cancelled" | "requested" | "noop" {
    return this.tx(() => {
      const row = this.get(jobId);
      if (!row) return "noop";
      if (row.state === "pending" && !row.everClaimed) {
        return this.cancelIfUnclaimed(jobId) ? "cancelled" : "noop";
      }
      if (row.state === "pending" || row.state === "running") {
        this.db.prepare("UPDATE proc_jobs SET cancelRequested=1, updatedAt=? WHERE jobId=?").run(this.now(), jobId);
        return "requested";
      }
      return "noop";
    });
  }

  // ───────────────────────── 保留 ─────────────────────────

  /**
   * 清理:done/cancelled 超过 `retainMs`(默认 7 天)删;**failed / uncertain 不自动删**。
   * `purgeFailed` 时额外删 failed(人工清,`_proc-gc --purge-failed` / `POST /api/proc/purge`);
   * uncertain 须先 `ackUncertain` 转 failed 才会被删。返回删除行数。
   */
  gc(o: { retainMs?: number; purgeFailed?: boolean } = {}): number {
    const cutoff = this.now() - (o.retainMs ?? GC_RETAIN_MS);
    let n = Number(
      this.db.prepare("DELETE FROM proc_jobs WHERE state IN ('done','cancelled') AND finishedAt IS NOT NULL AND finishedAt<?")
        .run(cutoff).changes,
    );
    if (o.purgeFailed) n += Number(this.db.prepare("DELETE FROM proc_jobs WHERE state='failed'").run().changes);
    return n;
  }
}
